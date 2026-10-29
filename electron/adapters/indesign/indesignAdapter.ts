import { indesignLibrary } from "./library";
import { blocks } from "../../core/blocks/registry";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppStatus, DocumentRef, DocumentSummary, ParamOption, PreviewImage } from "../../core/types";
import { shortVersion } from "../../core/util";
import { filePreview } from "../previews";
import type { AdapterOutput, DesignAppAdapter, ManifestOptions, Progress, RuleCheckOptions, RuleFinding, ScriptContext, ScriptResult, StageItemInput, StageItemResult, StageRunContext, StageSession, StyleFacts } from "../types";
import { AdobeConnection } from "../adobe/connection";
import { BridgeError, indesignBridge } from "./bridge";
import { lintExtendScript } from "./lint";
import { INDESIGN_MODEL_GUIDE } from "./modelGuide";
import {
  CLOSE_DOCUMENT,
  EXPORT_PAGE_PREVIEWS,
  INSPECT,
  LIST_DOCUMENTS,
  MISSING_FONTS,
  OPEN_PAGE,
  PDF_PRESETS,
  PREPARE_COPY,
  PROBE,
  RULE_CHECKS,
  SAVE_DOCUMENT,
  STYLE_FACTS,
  wrapRoutine,
} from "./jsx/scripts";


interface Options {
  /** Seconds before a script is abandoned (Settings → script timeout). */
  getTimeoutSec: () => number;
  /** The connection state changed without a status check (a background probe answered). */
  onStatusChange?: () => void;
}

/** Real InDesign adapter: AppleScript → ExtendScript via osascript, in the main process. */
export class InDesignAdapter implements DesignAppAdapter {
  readonly id = "indesign";
  readonly name = "Adobe InDesign";
  readonly scriptLanguage = "ExtendScript";
  readonly connection = "script-bridge" as const;
  readonly modelGuide = INDESIGN_MODEL_GUIDE;
  readonly stageKind = "script" as const;
  readonly qcChecks = [
    { level: "rule" as const, types: ["overset" as const], label: () => "Text fits its frames" },
    { level: "rule" as const, types: ["link-missing" as const, "link-modified" as const], label: () => "Links are present and up to date" },
    { level: "rule" as const, types: ["font-missing" as const], label: () => "Fonts are installed" },
    { level: "rule" as const, types: ["low-res" as const], label: (ppi: number) => `Images are at least ${ppi} ppi` },
    { level: "object" as const, types: ["off-page" as const], label: () => "Text stays inside the page" },
    { level: "object" as const, types: ["short-of-bleed" as const], label: () => "Images reach the bleed" },
  ];

  private readonly adobe: AdobeConnection;

  constructor(private readonly options: Options) {
    this.adobe = new AdobeConnection(indesignBridge, PROBE, () => this.options.getTimeoutSec(), { onChange: options.onStatusChange });
  }

  /** Runs a script and keeps the permission state up to date. */
  private call<T>(main: string, input: unknown, timeoutSec?: number, library?: string): Promise<T> {
    return this.adobe.call<T>(main, input, timeoutSec, undefined, library);
  }

  getStatus(): Promise<AppStatus> {
    return this.adobe.getStatus();
  }

  async getDetail() {
    return undefined;
  }

  async getAppVersion(): Promise<string | null> {
    const version = await this.adobe.getVersion();
    return version ? shortVersion(version) : null;
  }

  async listOpenDocuments(): Promise<DocumentRef[]> {
    if (!(await indesignBridge.isRunning())) return [];
    const docs = await this.call<{ id: string; name: string; path: string; pageCount: number; active: boolean }[]>(LIST_DOCUMENTS, {});
    return docs.map((d) => ({ id: d.id, appId: this.id, name: d.name, path: d.path || undefined, pageCount: d.pageCount, active: d.active }));
  }

  async inspectDocument(docId: string): Promise<DocumentSummary> {
    const d = await this.call<{
      id: string;
      name: string;
      path: string;
      appVersion: string;
      pageCount: number;
      pageSize: { width: number; height: number; unit: string };
      layers: string[];
      paragraphStyles: string[];
      characterStyles: string[];
      textFrameCount: number;
      links: DocumentSummary["links"];
      fonts: DocumentSummary["fonts"];
    }>(INSPECT, { docId });
    this.adobe.version = d.appVersion;
    return {
      ref: { id: d.id, appId: this.id, name: d.name, path: d.path || undefined, pageCount: d.pageCount },
      appVersion: shortVersion(d.appVersion),
      pageCount: d.pageCount,
      pageSize: d.pageSize,
      layers: d.layers,
      paragraphStyles: d.paragraphStyles,
      characterStyles: d.characterStyles,
      textFrameCount: d.textFrameCount,
      links: d.links,
      fonts: d.fonts,
    };
  }

  async runScript(
    script: string,
    params: Record<string, unknown>,
    onProgress: (p: Progress) => void,
    ctx: ScriptContext,
  ): Promise<ScriptResult> {
    if (!(await indesignBridge.isRunning())) throw new BridgeError("not-running", "InDesign isn't running.");
    const log: string[] = [];
    const docs = await this.listOpenDocuments();
    const source = ctx.documentId ? docs.find((d) => d.id === ctx.documentId) : docs.find((d) => d.active) ?? docs[0];
    if (!source) {
      throw new BridgeError("script", ctx.documentId ? "The document isn't open in InDesign anymore." : "No document is open in InDesign.");
    }

    let target = { id: source.id, name: source.name };
    if (ctx.target !== "original") {
      onProgress({ phase: ctx.target === "trial" ? "Making a temporary copy for the trial run" : "Saving a copy next to your document" });
      const copy = await this.call<{ id: string; name: string }>(PREPARE_COPY, {
        docId: source.id,
        placement: ctx.target === "trial" ? "temp" : "beside",
        // Trial copies are temporary; a real copy of an unsaved document must outlive the run.
        fallbackDir: ctx.target === "trial" ? path.join(ctx.workDir, "copies") : ctx.copiesDir,
        showWindow: ctx.target !== "trial",
      });
      target = copy;
      log.push(`Running on ${copy.name}`);
    }
    if (ctx.isCancelled()) return { outputs: [], document: target, log };

    onProgress({ phase: "Running the routine in InDesign" });
    let res: { result: unknown; outputs: AdapterOutput[]; log: string[] };
    try {
      res = await this.call(wrapRoutine(script), {
        docId: target.id,
        originalName: source.name,
        routineName: ctx.routineName,
        params,
      });
    } catch (err) {
      // A trial copy is hidden; never leave it open behind the user's back.
      if (ctx.target === "trial" && target.id !== source.id) await this.closeDocument(target.id).catch(() => undefined);
      throw err;
    }
    log.push(...(res.log ?? []));

    if (ctx.target === "copy" && ctx.modifiesDocument) {
      onProgress({ phase: "Saving the copy" });
      await this.call(SAVE_DOCUMENT, { docId: target.id });
    }
    return { outputs: res.outputs ?? [], document: target, log, data: res.result };
  }

  async renderPreview(target: string): Promise<PreviewImage> {
    if (target.startsWith("file:")) {
      const preview = await filePreview(target.slice(5));
      if (!preview) throw new Error("Couldn't render a preview of the file.");
      return preview;
    }
    const m = target.match(/^page:(.*)#(\d+)$/);
    if (!m) throw new Error(`Unknown preview target: ${target}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-preview-"));
    try {
      const previews = await this.renderPagePreviews(m[1], [Number(m[2])], dir);
      const p = previews[Number(m[2])];
      if (!p) throw new Error("InDesign didn't export the page.");
      return p;
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async renderPagePreviews(docId: string, pageIndexes: number[], workDir: string): Promise<Record<number, PreviewImage>> {
    if (pageIndexes.length === 0) return {};
    const outDir = path.join(workDir, "previews");
    const files = await this.call<{ pageIndex: number; page: string; file: string }[]>(EXPORT_PAGE_PREVIEWS, {
      docId,
      pageIndexes,
      outDir,
      ppi: 72,
    });
    const result: Record<number, PreviewImage> = {};
    for (const f of files) {
      const preview = await filePreview(f.file, `Page ${f.page}`).catch(() => undefined);
      if (preview) result[f.pageIndex] = preview;
    }
    return result;
  }

  async ruleChecks(docId: string | undefined, options: RuleCheckOptions): Promise<RuleFinding[]> {
    return this.call<RuleFinding[]>(RULE_CHECKS, { docId, minPpi: options.minPpi });
  }

  async getParamOptions(source: string): Promise<ParamOption[]> {
    if (source !== "pdfExportPresets") return [];
    if (!(await indesignBridge.isRunning())) return [];
    const names = await this.call<string[]>(PDF_PRESETS, {});
    return names.map((n) => ({ value: n, label: n }));
  }

  async missingFonts(families: string[]): Promise<string[]> {
    if (families.length === 0 || !(await indesignBridge.isRunning())) return [];
    return this.call<string[]>(MISSING_FONTS, { families });
  }

  async openInApp(docId: string, target?: { pageIndex?: number }): Promise<void> {
    await this.call(OPEN_PAGE, { docId, pageIndex: target?.pageIndex });
    await indesignBridge.activate();
  }

  async closeDocument(docId: string): Promise<void> {
    await this.call(CLOSE_DOCUMENT, { docId });
  }

  lintScript(script: string): string[] {
    return lintExtendScript(script);
  }

  /** Page size, margins, columns, bleed and paragraph styles of an .indd file (InDesign must be running). */
  async readStyleFacts(filePath: string): Promise<StyleFacts> {
    if (!(await indesignBridge.isRunning())) throw new BridgeError("not-running", "Open InDesign to read this file's styles.");
    return this.call<StyleFacts>(STYLE_FACTS, { path: filePath });
  }

  async connect(): Promise<AppStatus> {
    this.adobe.reset();
    return this.getStatus();
  }

  // ---------- Stages of multi-app routines ----------

  /** The guide (it documents the ctx helpers); "index" adds the ranked building blocks, yours included. */
  capabilityManifest(options: ManifestOptions = {}) {
    const guide = `${INDESIGN_MODEL_GUIDE}\n\n${STAGE_NOTES}`;
    return options.helperDocs === "index" ? `${guide}\n\n${blocks.indexText("indesign", options.request ?? "")}` : guide + blocks.personalText("indesign");
  }

  async inspectForModel(docId: string) {
    return this.inspectDocument(docId);
  }

  /** Makes the copy once per stage (like a single-script run); every item then runs on it. */
  async beginStage(ctx: StageRunContext): Promise<StageSession> {
    if (!(await indesignBridge.isRunning())) throw new BridgeError("not-running", "InDesign isn't running.");
    if ((ctx.stage.document ?? "open") === "none") return { state: { docId: null } };
    const docs = await this.listOpenDocuments();
    const source = ctx.documentId ? docs.find((d) => d.id === ctx.documentId) : (docs.find((d) => d.active) ?? docs[0]);
    if (!source) {
      throw new BridgeError("script", ctx.documentId ? "The document isn't open in InDesign anymore." : "No document is open in InDesign.");
    }
    let target = { id: source.id, name: source.name };
    if (ctx.target !== "original") {
      target = await this.call<{ id: string; name: string }>(PREPARE_COPY, {
        docId: source.id,
        placement: ctx.target === "trial" ? "temp" : "beside",
        fallbackDir: ctx.target === "trial" ? path.join(ctx.workDir, "copies") : ctx.copiesDir,
        showWindow: ctx.target !== "trial",
      });
    }
    return { state: { docId: target.id, sourceId: source.id, sourceName: source.name }, documentName: target.name };
  }

  async runStageItem(session: StageSession, input: StageItemInput, ctx: StageRunContext, onProgress: (text: string) => void): Promise<StageItemResult> {
    const st = session.state as { docId: string | null; sourceName?: string };
    onProgress(`Running in InDesign · ${input.label}`);
    let res: { result: unknown; outputs: AdapterOutput[]; log: string[]; values?: Record<string, unknown[]> };
    try {
      res = await this.call(wrapRoutine(String(input.body)), {
        docId: st.docId,
        noDocument: !st.docId,
        originalName: st.sourceName,
        routineName: ctx.routineName,
        params: input.params,
        item: input.item,
        itemIndex: input.index,
        matched: input.matched ?? {},
        workDir: ctx.workDir,
      }, undefined, ctx.stage.blocks?.code ? indesignLibrary(ctx.stage.blocks.code) : undefined);
    } catch (err) {
      if (err instanceof BridgeError && err.kind === "script") {
        return { ok: false, error: `${err.message}${err.line ? ` (script line ${err.line})` : ""}`, scriptFailure: true, outputs: [], values: {}, findings: [], log: [] };
      }
      throw err;
    }
    const outputs = (res.outputs ?? []).map((o, i) => ({ ...o, key: `${input.key}-${o.key || i + 1}` }));
    for (const o of outputs.filter((x) => x.filePath && !x.preview)) o.preview = await filePreview(o.filePath!).catch(() => undefined);
    const pages = outputs.filter((x) => !x.filePath && x.pageIndex);
    if (pages.length && st.docId) {
      const previews = await this.renderPagePreviews(st.docId, [...new Set(pages.map((p) => p.pageIndex!))].slice(0, 24), ctx.workDir).catch(
        () => ({}) as Record<number, never>,
      );
      for (const o of pages) o.preview = previews[o.pageIndex!];
    }
    const values: Record<string, unknown[]> = { ...(res.values ?? {}) };
    const fileList = ctx.stage.outputs.find((o) => o.type === "fileList" || o.type === "file");
    const files = outputs.filter((o) => o.filePath).map((o) => o.filePath!);
    if (fileList && !values[fileList.key] && files.length) values[fileList.key] = files;
    let findings: RuleFinding[] = [];
    if (st.docId && ctx.stage.modifiesDocument) {
      findings = await this.ruleChecks(st.docId, { minPpi: 300, outputs }).catch(() => []);
    }
    return { ok: true, outputs, values, findings, log: res.log ?? [], data: res.result };
  }

  async endStage(session: StageSession, ctx: StageRunContext): Promise<void> {
    const st = session.state as { docId: string | null; sourceId?: string };
    if (!st.docId || st.docId === st.sourceId) return;
    if (ctx.target === "copy" && ctx.stage.modifiesDocument) {
      await this.call(SAVE_DOCUMENT, { docId: st.docId }).catch(() => undefined);
    } else {
      await this.closeDocument(st.docId).catch(() => undefined);
    }
  }
}

const STAGE_NOTES = `An InDesign routine's script also gets:
  params.<key>: every input and setting by key (file and folder inputs are paths, fileList inputs arrays of paths,
  rows inputs { rows, columns, name, path }),
  ctx.item (the current item when the routine iterates: a data row object, or for files { path, name, stem, ext }),
  ctx.itemIndex (0-based), ctx.matched.<input> (the item of a second list that pairs with ctx.item),
  ctx.workDir (this routine's working folder; files other routines need go here),
  ctx.stageOutput(key, value) (adds a value to one of the routine's declared outputs; exported files listed with
  ctx.output({ filePath }) go to the first file output automatically).
doc is null for routines without a document input (open files with app.open(File(params.someFile)) yourself then).`;

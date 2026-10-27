import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppStatus, DocumentRef, DocumentSummary, ParamOption, PreviewImage } from "../../core/types";
import { shortVersion } from "../../core/util";
import { filePreview } from "../previews";
import type { AdapterOutput, DesignAppAdapter, Progress, RuleCheckOptions, RuleFinding, ScriptContext, ScriptResult, StyleFacts } from "../types";
import { BridgeError, activate, isBusy, isInstalled, isRunning, runJsx } from "./bridge";
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
}

/** Real InDesign adapter: AppleScript → ExtendScript via osascript, in the main process. */
export class InDesignAdapter implements DesignAppAdapter {
  readonly id = "indesign";
  readonly name = "Adobe InDesign";
  readonly scriptLanguage = "ExtendScript";
  readonly connection = "script-bridge" as const;
  readonly modelGuide = INDESIGN_MODEL_GUIDE;
  readonly qcChecks = [
    { level: "rule" as const, types: ["overset" as const], label: () => "Text fits its frames" },
    { level: "rule" as const, types: ["link-missing" as const, "link-modified" as const], label: () => "Links are present and up to date" },
    { level: "rule" as const, types: ["font-missing" as const], label: () => "Fonts are installed" },
    { level: "rule" as const, types: ["low-res" as const], label: (ppi: number) => `Images are at least ${ppi} ppi` },
    { level: "object" as const, types: ["off-page" as const], label: () => "Text stays inside the page" },
    { level: "object" as const, types: ["short-of-bleed" as const], label: () => "Images reach the bleed" },
  ];

  private installed: boolean | null = null;
  private installedCheckedAt = 0;
  /** Set once a script round-trip succeeded since InDesign started. */
  private probed = false;
  private permissionDenied = false;
  private version: string | null = null;
  private lastProbeAt = 0;

  constructor(private readonly options: Options) {}

  private timeout() {
    return this.options.getTimeoutSec();
  }

  /** Runs a script and keeps the permission state up to date. */
  private async call<T>(main: string, input: unknown, timeoutSec = this.timeout()): Promise<T> {
    try {
      const data = await runJsx<T>(main, input, timeoutSec);
      this.permissionDenied = false;
      this.probed = true;
      return data;
    } catch (err) {
      if (err instanceof BridgeError && err.kind === "permission-denied") this.permissionDenied = true;
      throw err;
    }
  }

  async getStatus(): Promise<AppStatus> {
    const now = Date.now();
    if (this.installed === null || (!this.installed && now - this.installedCheckedAt > 30_000)) {
      this.installed = await isInstalled();
      this.installedCheckedAt = now;
    }
    if (!this.installed) return "not-installed";
    if (!(await isRunning())) {
      this.probed = false;
      this.version = null;
      return "not-running";
    }
    if (this.probed && !this.permissionDenied) return "connected";
    // Probe with a tiny script. The first probe triggers macOS's "Doppel wants to control Adobe InDesign" prompt.
    if (isBusy() || now - this.lastProbeAt < (this.permissionDenied ? 10_000 : 2_000)) {
      return this.permissionDenied ? "permission-denied" : "not-running";
    }
    this.lastProbeAt = now;
    try {
      // Long timeout: the first probe waits while macOS shows its permission prompt.
      const info = await this.call<{ version: string }>(PROBE, {}, 90);
      this.version = info.version;
      return "connected";
    } catch (err) {
      if (err instanceof BridgeError && err.kind === "permission-denied") return "permission-denied";
      // Still launching, or busy with a modal dialog.
      return "not-running";
    }
  }

  async getDetail() {
    return undefined;
  }

  async getAppVersion(): Promise<string | null> {
    if (!this.version && (await isRunning())) {
      try {
        this.version = (await this.call<{ version: string }>(PROBE, {}, 20)).version;
      } catch {
        return null;
      }
    }
    return this.version ? shortVersion(this.version) : null;
  }

  async listOpenDocuments(): Promise<DocumentRef[]> {
    if (!(await isRunning())) return [];
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
    this.version = d.appVersion;
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
    if (!(await isRunning())) throw new BridgeError("not-running", "InDesign isn't running.");
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppel-preview-"));
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
    if (!(await isRunning())) return [];
    const names = await this.call<string[]>(PDF_PRESETS, {});
    return names.map((n) => ({ value: n, label: n }));
  }

  async missingFonts(families: string[]): Promise<string[]> {
    if (families.length === 0 || !(await isRunning())) return [];
    return this.call<string[]>(MISSING_FONTS, { families });
  }

  async openInApp(docId: string, target?: { pageIndex?: number }): Promise<void> {
    await this.call(OPEN_PAGE, { docId, pageIndex: target?.pageIndex });
    await activate();
  }

  async closeDocument(docId: string): Promise<void> {
    await this.call(CLOSE_DOCUMENT, { docId });
  }

  lintScript(script: string): string[] {
    return lintExtendScript(script);
  }

  /** Page size, margins, columns, bleed and paragraph styles of an .indd file (InDesign must be running). */
  async readStyleFacts(filePath: string): Promise<StyleFacts> {
    if (!(await isRunning())) throw new BridgeError("not-running", "Open InDesign to read this file's styles.");
    return this.call<StyleFacts>(STYLE_FACTS, { path: filePath });
  }

  async connect(): Promise<AppStatus> {
    this.installed = null;
    this.lastProbeAt = 0;
    return this.getStatus();
  }
}

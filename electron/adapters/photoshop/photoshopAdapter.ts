import { photoshopLibrary } from "./library";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppStatus, DocumentRef, DocumentSummary, ParamOption, PreviewImage, RuleFinding } from "../../core/types";
import { newId, shortVersion } from "../../core/util";
import { assembleScript, BridgeError } from "../adobe/bridge";
import { AdobeConnection } from "../adobe/connection";
import { filePreview } from "../previews";
import type { AdapterOutput, DesignAppAdapter, ManifestOptions, Progress, ScriptContext, ScriptResult, StageItemInput, StageItemResult, StageRunContext, StageSession } from "../types";
import { photoshopBridge } from "./bridge";
import { BEGIN_STAGE, END_STAGE, FOCUS_DOCUMENT, INSPECT, LAYER_NAMES, LIST_DOCUMENTS, MISSING_FONTS, PROBE, RENDER_PREVIEW, wrapItem } from "./jsx/scripts";
import { lintPhotoshopScript } from "./lint";
import { PHOTOSHOP_GUIDE_INTRO, PHOTOSHOP_GUIDE_OUTRO, PHOTOSHOP_GUIDE_RULES, PHOTOSHOP_MODEL_GUIDE } from "./modelGuide";
import { blocks } from "../../core/blocks/registry";

const PREVIEW_WIDTH = 640;

interface OwnedDoc {
  name: string;
  path: string | null;
}

interface PhotoshopStageState extends Record<string, unknown> {
  owned: OwnedDoc[];
  workingName: string | null;
}

interface ItemResponse {
  error: string | null;
  line: number | null;
  result: unknown;
  files: string[];
  outputs: Record<string, unknown[]>;
  findings: RuleFinding[];
  log: string[];
  owned: OwnedDoc[];
  reported: { label: string; name: string }[];
  activeName: string | null;
}

interface LayerNode {
  name: string;
  kind: string;
  visible: boolean;
  smartObject?: boolean;
  children?: LayerNode[];
}

function flatten(layers: LayerNode[], prefix = ""): { path: string; node: LayerNode }[] {
  const out: { path: string; node: LayerNode }[] = [];
  for (const l of layers) {
    const p = prefix ? `${prefix}/${l.name}` : l.name;
    out.push({ path: p, node: l });
    if (l.children) out.push(...flatten(l.children, p));
  }
  return out;
}

/**
 * Real Photoshop adapter on the shared Adobe bridge. Stages work on a duplicate of the picked document and on
 * files Doppl opens itself; nothing is saved over the designer's PSD, and Doppl's documents are closed without
 * saving when the stage ends.
 */
export class PhotoshopAdapter implements DesignAppAdapter {
  readonly id = "photoshop";
  readonly name = "Adobe Photoshop";
  readonly scriptLanguage = "ExtendScript";
  readonly connection = "script-bridge" as const;
  readonly modelGuide = PHOTOSHOP_MODEL_GUIDE;
  readonly stageKind = "script" as const;
  readonly qcChecks = [
    { level: "rule" as const, types: ["font-missing" as const], label: () => "Fonts are installed" },
    { level: "rule" as const, types: ["file-missing" as const], label: () => "Images and files exist" },
    { level: "rule" as const, types: ["cutout-suspect" as const], label: () => "Cutout found the subject", onlyWhenFound: true },
  ];

  private readonly adobe: AdobeConnection;

  constructor(private readonly options: { getTimeoutSec: () => number; onStatusChange?: () => void }) {
    this.adobe = new AdobeConnection(photoshopBridge, PROBE, () => this.options.getTimeoutSec(), { onChange: options.onStatusChange });
  }

  private call<T>(main: string, input: unknown, label?: string, timeoutSec?: number, library?: string): Promise<T> {
    return this.adobe.call<T>(main, input, timeoutSec, label, library);
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

  async connect(): Promise<AppStatus> {
    this.adobe.reset();
    return this.getStatus();
  }

  async listOpenDocuments(): Promise<DocumentRef[]> {
    if (!(await photoshopBridge.isRunning())) return [];
    const docs = await this.call<{ id: string; name: string; path: string; active: boolean }[]>(LIST_DOCUMENTS, {}, "list-documents");
    return docs.map((d) => ({ id: d.id, appId: this.id, name: d.name, path: d.path || undefined, active: d.active }));
  }

  private inspectRaw(docId: string, maxLayers = 400) {
    return this.call<{
      id: string;
      name: string;
      path: string;
      appVersion: string;
      width: number;
      height: number;
      resolution: number;
      mode: string;
      bitsPerChannel: string;
      layers: LayerNode[];
      layerCount: number;
      truncated: boolean;
    }>(INSPECT, { docId, maxLayers }, "inspect");
  }

  async inspectDocument(docId: string): Promise<DocumentSummary> {
    const d = await this.inspectRaw(docId);
    this.adobe.version = d.appVersion;
    const all = flatten(d.layers);
    return {
      ref: { id: d.id, appId: this.id, name: d.name, path: d.path || undefined },
      appVersion: shortVersion(d.appVersion),
      pageCount: 1,
      pageSize: { width: d.width, height: d.height, unit: "px" },
      layers: all.map((l) => `${l.path}${l.node.smartObject ? " (Smart Object)" : l.node.kind === "text" ? " (text)" : ""}`).slice(0, 80),
      paragraphStyles: [],
      characterStyles: [],
      textFrameCount: all.filter((l) => l.node.kind === "text").length,
      links: [],
      fonts: [],
    };
  }

  async inspectForModel(docId: string, args: Record<string, unknown>) {
    const max = Math.min(Math.max(Number(args.maxLayers) || 400, 20), 1000);
    return this.inspectRaw(docId, max);
  }

  /** The guide: the helper catalog as before ("full"), or a ranked index of the building blocks ("index"). */
  capabilityManifest(options: ManifestOptions = {}) {
    if (options.helperDocs === "index") return `${PHOTOSHOP_GUIDE_INTRO}${PHOTOSHOP_GUIDE_RULES}\n${blocks.indexText("photoshop", options.request ?? "")}\n\n${PHOTOSHOP_GUIDE_OUTRO}`;
    return PHOTOSHOP_MODEL_GUIDE + blocks.personalText("photoshop");
  }

  // ---------- Stages ----------

  async beginStage(ctx: StageRunContext): Promise<StageSession> {
    if (!(await photoshopBridge.isRunning())) throw new BridgeError("not-running", "Photoshop isn't running.");
    const needsDoc = (ctx.stage.document ?? "open") === "open";
    if (needsDoc && !ctx.documentId) throw new BridgeError("script", "Open a document in Photoshop and pick it for this stage.");
    const res = await this.call<{ owned: OwnedDoc[]; workingName: string | null }>(
      BEGIN_STAGE,
      { docId: needsDoc ? ctx.documentId : null, owned: [] },
      "begin-stage",
    );
    const state: PhotoshopStageState = { owned: res.owned, workingName: res.workingName };
    return { state, documentName: res.workingName ?? undefined };
  }

  async runStageItem(session: StageSession, input: StageItemInput, ctx: StageRunContext, onProgress: (text: string) => void): Promise<StageItemResult> {
    const state = session.state as PhotoshopStageState;
    onProgress(`Running in Photoshop · ${input.label}`);
    const main = wrapItem(String(input.body));
    const res = await this.call<ItemResponse>(
      main,
      {
        workingName: state.workingName,
        params: input.params,
        item: input.item,
        itemIndex: input.index,
        matched: input.matched ?? {},
        workDir: ctx.workDir,
        // The designer's picked files and folders are read-only: a script saves only into its working folder.
        allowedFolders: [ctx.workDir],
        owned: state.owned,
      },
      "run-item",
      undefined,
      ctx.stage.blocks?.code ? photoshopLibrary(ctx.stage.blocks.code) : undefined,
    );
    state.owned = res.owned ?? state.owned;

    const outputs: AdapterOutput[] = [];
    for (const [i, file] of (res.files ?? []).entries()) {
      outputs.push({ key: `${input.key}-file-${i + 1}`, label: path.basename(file), filePath: file, profile: "web" });
    }
    const previewTargets = [...(res.reported ?? [])];
    if (outputs.length === 0 && previewTargets.length === 0 && !res.error && (state.workingName || res.activeName)) {
      previewTargets.push({ label: input.label, name: state.workingName ?? res.activeName! });
    }
    for (const [i, target] of previewTargets.entries()) {
      const preview = await this.previewOfDocument(target.name, ctx.workDir, target.label).catch(() => undefined);
      outputs.push({ key: `${input.key}-doc-${i + 1}`, label: target.label, preview, profile: "web" });
    }

    const values: Record<string, unknown[]> = { ...(res.outputs ?? {}) };
    const fileList = ctx.stage.outputs.find((o) => o.type === "fileList" || o.type === "file");
    if (fileList && !values[fileList.key] && res.files?.length) values[fileList.key] = [...res.files];

    let error: string | undefined;
    if (res.error) {
      const start = assembleScript(photoshopBridge.spec, main).routineStartLine;
      const line = res.line && start ? res.line - start + 1 : undefined;
      error = `${res.error}${line && line > 0 ? ` (script line ${line})` : ""}`;
    }
    return {
      ok: !res.error,
      error,
      scriptFailure: !!res.error,
      outputs,
      values,
      findings: res.findings ?? [],
      log: res.log ?? [],
      data: res.result,
    };
  }

  async endStage(session: StageSession): Promise<void> {
    const state = session.state as PhotoshopStageState;
    if (!state.owned?.length) return;
    await this.call(END_STAGE, { owned: state.owned }, "end-stage").catch(() => undefined);
    state.owned = [];
  }

  private async previewOfDocument(name: string, workDir: string, label: string): Promise<PreviewImage | undefined> {
    const file = path.join(workDir, "previews", `${newId()}.png`);
    const res = await this.call<{ file: string }>(RENDER_PREVIEW, { name, file, width: PREVIEW_WIDTH }, "preview");
    try {
      return await filePreview(res.file, label);
    } finally {
      fs.rm(res.file, { force: true }).catch(() => undefined);
    }
  }

  // ---------- Single-script routines (one stage, one item) ----------

  async runScript(script: string, params: Record<string, unknown>, onProgress: (p: Progress) => void, ctx: ScriptContext): Promise<ScriptResult> {
    const stageCtx: StageRunContext = {
      runId: ctx.runId,
      routineName: ctx.routineName,
      stage: { id: "main", name: ctx.routineName, appId: this.id, kind: "script", body: script, outputs: [], document: ctx.documentId ? "open" : "none" },
      documentId: ctx.documentId,
      target: ctx.target,
      workDir: ctx.workDir,
      copiesDir: ctx.copiesDir,
      isCancelled: ctx.isCancelled,
    };
    const session = await this.beginStage(stageCtx);
    try {
      const res = await this.runStageItem(
        session,
        { key: "main", label: ctx.routineName, index: 0, item: null, params, body: script },
        stageCtx,
        (text) => onProgress({ phase: text }),
      );
      if (!res.ok) throw new BridgeError("script", res.error ?? "The script failed.");
      return { outputs: res.outputs, log: res.log, data: res.data, findings: res.findings, document: session.documentName ? { id: ctx.documentId ?? "", name: session.documentName } : undefined };
    } finally {
      await this.endStage(session);
    }
  }

  async renderPreview(target: string): Promise<PreviewImage> {
    if (target.startsWith("file:")) {
      const preview = await filePreview(target.slice(5));
      if (preview) return preview;
    }
    throw new Error("Couldn't render a preview.");
  }

  async renderPagePreviews() {
    return {};
  }

  async ruleChecks() {
    // Photoshop findings come from the helpers while a stage runs (missing files, missing fonts).
    return [];
  }

  async getParamOptions(source: string, docId?: string): Promise<ParamOption[]> {
    if ((source !== "layers" && source !== "smartObjects") || !docId) return [];
    const names = await this.call<string[]>(LAYER_NAMES, { docId, smartOnly: source === "smartObjects" }, "layer-names");
    return [...new Set(names)].map((n) => ({ value: n, label: n }));
  }

  async missingFonts(families: string[]): Promise<string[]> {
    if (families.length === 0 || !(await photoshopBridge.isRunning())) return [];
    return this.call<string[]>(MISSING_FONTS, { families }, "missing-fonts");
  }

  async openInApp(docId: string): Promise<void> {
    if (docId) await this.call(FOCUS_DOCUMENT, { docId }, "focus").catch(() => undefined);
    await photoshopBridge.activate();
  }

  async closeDocument() {
    // Doppl only closes its own working copies, at the end of each stage.
  }

  lintScript(script: string): string[] {
    return lintPhotoshopScript(script);
  }
}

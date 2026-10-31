import { expandComposites } from "../../core/blocks/composites";
import { blocks } from "../../core/blocks/registry";
import { shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { CancelledError } from "../../core/util";
import type { AppStatus, DocumentRef, DocumentSummary, FigmaActionList, FigmaFile, FigmaPageRef, ParamOption, PreviewImage, RuleFinding } from "../../core/types";
import { bufferPreview, filePreview } from "../previews";
import type { AdapterOutput, DesignAppAdapter, ManifestOptions, ScriptResult, StageItemInput, StageItemResult, StageRunContext, StageSession, StyleFacts } from "../types";
import { FigmaApiError, fileLink, getFile, parseFigmaLink, renderNodes, topFrames } from "./figmaRest";
import { figmaCapabilityManifest, FIGMA_MODEL_GUIDE } from "./modelGuide";
import { type FigmaPluginBridge, PluginCancelledError, PluginNotConnectedError } from "./pluginBridge";
import { ItemDataError, prepareActions } from "./prepareActions";

interface ItemResponse {
  ok: boolean;
  error?: { index: number; action: string; message: string };
  results: Record<string, unknown>;
  outputs: Record<string, unknown[]>;
  exports: { fileName: string; format: string; folder?: string; nodeId: string; data: string; output?: string }[];
  findings: { type: RuleFinding["type"]; message: string; nodeId?: string }[];
  log: string[];
  steps: { action: string; id?: string; result: unknown }[];
  shown: { nodeId: string; name: string; preview?: string }[];
  page: { id: string; name: string };
}

interface FigmaStageState extends Record<string, unknown> {
  sessionId: string;
  stageSessionId: string;
  pageId: string;
  documentId: string;
  /** The designer's page the stage started from. */
  source?: FigmaPageRef;
}

/** A page a run worked on, finished in endRun. */
interface RunPage {
  sessionId: string;
  pageId: string;
  trial: boolean;
  /** An item worked on it: a copy with results is the designer's to keep. */
  made: boolean;
}

const EXT: Record<string, string> = { PNG: ".png", JPG: ".jpg", SVG: ".svg", PDF: ".pdf" };
const safeName = (name: string) => name.replace(/[/\\:*?"<>|]/g, "-").trim() || "export";

function insideAny(target: string, folders: string[]) {
  const t = path.resolve(target);
  return folders.some((f) => t === path.resolve(f) || t.startsWith(path.resolve(f) + path.sep));
}

/** A path for a new file in `folder` that doesn't overwrite anything ("name.png", "name-2.png", …). */
async function freePath(folder: string, base: string, ext: string) {
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, `${base}${n > 1 ? `-${n}` : ""}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Real Figma: the Doppl plugin, open in each Figma file, runs action lists (figma-plugin/). Files connected by
 * link (Figma REST API, personal access token) can be read without the plugin and opened in Figma.
 */
export class FigmaAdapter implements DesignAppAdapter {
  readonly id = "figma";
  readonly name = "Figma";
  readonly scriptLanguage = "Doppl action lists (JSON)";
  readonly connection = "links-and-plugin" as const;
  readonly modelGuide = FIGMA_MODEL_GUIDE;
  readonly stageKind = "actions" as const;
  readonly qcChecks = [
    { level: "rule" as const, types: ["font-missing" as const], label: () => "Fonts are available" },
    { level: "rule" as const, types: ["font-style-missing" as const], label: () => "Font styles are available" },
    { level: "rule" as const, types: ["file-missing" as const], label: () => "Images and files exist" },
    { level: "rule" as const, types: ["barcode-invalid" as const], label: () => "Barcodes are valid" },
    { level: "rule" as const, types: ["upscaled-image" as const], label: () => "Images aren't shown larger than their pixels" },
    { level: "object" as const, types: ["text-overflow" as const, "cut-off" as const], label: () => "Text fits its box and frame" },
    { level: "object" as const, types: ["outside-boundary" as const], label: () => "Elements stay inside their boundary" },
  ];

  /** Pages per run, finished in endRun. */
  private pagesOfRun = new Map<string, RunPage[]>();
  /** Page each run works on per document, so later Figma stages of a run continue on it. */
  private runPages = new Map<string, string>();

  constructor(
    private readonly deps: {
      getToken: () => Promise<string | null>;
      getFiles: () => FigmaFile[];
      bridge: FigmaPluginBridge;
      getTimeoutSec: () => number;
    },
  ) {}

  private timeoutMs() {
    return this.deps.getTimeoutSec() * 1000;
  }

  /** The plugin session for a document (or the only open one). */
  private session(documentId?: string) {
    const sessions = this.deps.bridge.list();
    const s = documentId ? sessions.find((x) => x.documentId === documentId) : sessions.length === 1 ? sessions[0] : undefined;
    if (s) return s;
    const linked = documentId ? this.linkedFile(documentId) : undefined;
    const name = linked?.name ?? documentId?.replace(/^figma(-name)?:/, "");
    throw new PluginNotConnectedError(
      name
        ? `Open “${name}” in Figma and start the Doppl plugin there (Plugins → Development → Doppl).`
        : "Open your file in Figma and start the Doppl plugin (Plugins → Development → Doppl).",
    );
  }

  private linkedFile(documentId: string): FigmaFile | undefined {
    const key = documentId.startsWith("figma:") ? documentId.slice(6) : undefined;
    const name = documentId.startsWith("figma-name:") ? documentId.slice(11) : undefined;
    return this.deps.getFiles().find((f) => (key && f.key === key) || (name && f.name.toLowerCase() === name.toLowerCase()));
  }

  private async request<T>(sessionId: string, payload: Record<string, unknown>, label: string, onProgress?: (t: string) => void, isCancelled?: () => boolean) {
    const { id, done } = this.deps.bridge.request<T>(sessionId, payload, { timeoutMs: this.timeoutMs(), onProgress, label });
    let watcher: NodeJS.Timeout | undefined;
    if (isCancelled) {
      watcher = setInterval(() => {
        if (isCancelled()) {
          this.deps.bridge.cancel(sessionId, id);
          clearInterval(watcher);
        }
      }, 400);
    }
    try {
      return await done;
    } catch (err) {
      if (err instanceof PluginCancelledError) throw new CancelledError();
      throw err;
    } finally {
      if (watcher) clearInterval(watcher);
    }
  }

  async getStatus(): Promise<AppStatus> {
    return this.deps.bridge.list().length > 0 ? "connected" : "not-running";
  }

  async getDetail() {
    const sessions = this.deps.bridge.list();
    if (sessions.length === 0) return "Plugin not open";
    if (sessions.length === 1) return `Plugin open on ${sessions[0].fileName}${sessions[0].pageName ? ` · ${sessions[0].pageName}` : ""}`;
    return `Plugin open in ${sessions.length} files`;
  }

  async getAppVersion() {
    return null;
  }

  async connect() {
    return this.getStatus();
  }

  async listOpenDocuments(): Promise<DocumentRef[]> {
    const sessions = this.deps.bridge.list().sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
    return sessions.map((s, i) => ({ id: s.documentId, appId: this.id, name: s.fileName, active: i === 0 }));
  }

  async inspectDocument(docId: string): Promise<DocumentSummary> {
    const live = this.deps.bridge.sessionFor(docId);
    if (live) {
      const res = await this.request<{
        file: { fileName: string };
        pages: { name: string; current: boolean }[];
        page: { name: string; children?: { id: string; name: string; type: string; width?: number; height?: number }[] };
      }>(live.id, { type: "inspect", depth: 1 }, "inspect");
      const frames = (res.page.children ?? [])
        .filter((c) => ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "INSTANCE"].includes(c.type))
        .map((c) => ({ name: c.name, id: c.id, width: c.width ?? 0, height: c.height ?? 0, page: res.page.name }));
      return {
        ref: { id: docId, appId: this.id, name: res.file.fileName },
        appVersion: "",
        pageCount: res.pages.length,
        layers: res.pages.map((p) => p.name),
        paragraphStyles: [],
        characterStyles: [],
        textFrameCount: 0,
        links: [],
        fonts: [],
        frames,
      };
    }
    // Linked but not open: read it through the REST API.
    const file = this.linkedFile(docId);
    const token = await this.deps.getToken();
    if (!file || !token) this.session(docId);
    const data = await getFile(token!, file!.key, 2);
    return {
      ref: { id: docId, appId: this.id, name: data.name, path: file!.url },
      appVersion: "",
      pageCount: data.document.children?.length ?? 0,
      layers: (data.document.children ?? []).map((p) => p.name),
      paragraphStyles: Object.values(data.styles ?? {}).filter((s) => s.styleType === "TEXT").map((s) => s.name),
      characterStyles: [],
      textFrameCount: 0,
      links: [],
      fonts: [],
      frames: topFrames(data),
    };
  }

  async inspectForModel(docId: string, args: Record<string, unknown>) {
    const s = this.session(docId);
    return this.request(s.id, { type: "inspect", node: typeof args.node === "string" ? args.node : undefined, depth: Number(args.depth ?? 2) }, "inspect");
  }

  /** The action guide and catalog; "index" adds the building blocks (composite actions), yours included. */
  capabilityManifest(options: ManifestOptions = {}) {
    if (options.helperDocs !== "index") return figmaCapabilityManifest() + blocks.personalText("figma");
    return `${figmaCapabilityManifest()}\n\nBuilding blocks are composite actions: use one as { "action": "block", "name": "<name>", "args": { … }, "id"?: "<id>", "output"?: "<output key>" }; Doppl expands it into catalog actions. "$<id>" is its result.\n${blocks.indexText("figma", options.request ?? "")}`;
  }

  // ---------- Stages ----------

  async beginStage(ctx: StageRunContext): Promise<StageSession> {
    const s = this.session(ctx.documentId);
    const runKey = `${ctx.runId}:${s.documentId}`;
    // A routine starts from the page it was made on, whatever page the designer has open.
    const res = await this.request<{ stageSessionId: string; pageId: string; pageName: string; source?: FigmaPageRef }>(
      s.id,
      { type: "beginStage", mode: ctx.target, routineName: ctx.routineName, reusePageId: this.runPages.get(runKey), source: ctx.stage.page },
      "beginStage",
    );
    this.runPages.set(runKey, res.pageId);
    const list = this.pagesOfRun.get(ctx.runId) ?? [];
    if (!list.some((p) => p.pageId === res.pageId)) list.push({ sessionId: s.id, pageId: res.pageId, trial: ctx.target === "trial", made: false });
    this.pagesOfRun.set(ctx.runId, list);
    const state: FigmaStageState = { sessionId: s.id, stageSessionId: res.stageSessionId, pageId: res.pageId, documentId: s.documentId, source: res.source };
    return { state, documentName: `${s.fileName} · ${res.pageName}` };
  }

  async runStageItem(session: StageSession, input: StageItemInput, ctx: StageRunContext, onProgress: (text: string) => void): Promise<StageItemResult> {
    const st = session.state as FigmaStageState;
    // The designer's picked files and folders are read-only: exports go only into the stage's working folder.
    const allowed = [ctx.workDir];
    let prepared;
    try {
      // Building blocks (composite actions) expand into catalog actions, at the versions the routine pinned.
      const expanded = expandComposites((input.body as FigmaActionList).actions as Record<string, unknown>[], ctx.stage.blocks?.composites ?? blocks.composites());
      if (expanded.problems.length) throw new ItemDataError(expanded.problems.join(" "), undefined, "routine");
      prepared = await prepareActions(expanded.actions, allowed);
    } catch (err) {
      if (err instanceof ItemDataError) {
        return { ok: false, error: err.message, cause: err.fault, outputs: [], values: {}, findings: err.finding ? [err.finding] : [], log: [] };
      }
      throw err;
    }
    let res: ItemResponse;
    try {
      res = await this.request<ItemResponse>(
        st.sessionId,
        { type: "runItem", stageSessionId: st.stageSessionId, actions: prepared.actions, label: input.label },
        "runItem",
        (text) => onProgress(`Figma · ${text}`),
        ctx.isCancelled,
      );
    } catch (err) {
      // Validation in the plugin or an unexpected error there: the action list must be fixed.
      if (err instanceof Error && !(err instanceof PluginNotConnectedError) && !(err instanceof CancelledError) && !/didn't finish within/.test(err.message)) {
        return { ok: false, error: err.message, scriptFailure: true, outputs: [], values: {}, findings: [], log: [] };
      }
      throw err;
    }

    const outputs: AdapterOutput[] = [];
    const values: Record<string, unknown[]> = {};
    for (const [key, list] of Object.entries(res.outputs ?? {})) values[key] = [...list];
    const fileList = ctx.stage.outputs.find((o) => o.type === "fileList" || o.type === "file");

    // Exports go only into the stage's working folder.
    for (const [i, e] of (res.exports ?? []).entries()) {
      const folder = e.folder ? path.resolve(e.folder) : ctx.workDir;
      if (!insideAny(folder, allowed)) throw new Error("A Figma export tried to save outside the routine's working folder. Doppl never writes into the designer's folders: leave out the export's folder.");
      await fs.mkdir(folder, { recursive: true });
      const filePath = await freePath(folder, safeName(path.basename(e.fileName)).replace(/\.(png|jpe?g|svg|pdf)$/i, ""), EXT[e.format] ?? ".png");
      const bytes = Buffer.from(e.data, "base64");
      await fs.writeFile(filePath, bytes);
      const preview = e.format === "PNG" || e.format === "JPG" ? bufferPreview(bytes, path.basename(filePath)) : await filePreview(filePath).catch(() => undefined);
      outputs.push({ key: `${input.key}-export-${i + 1}`, label: path.basename(filePath), filePath, nodeId: e.nodeId, preview, profile: "web" });
      const target = e.output ?? fileList?.key;
      if (target) (values[target] ??= []).push(filePath);
    }
    if (outputs.length === 0) {
      for (const [i, n] of (res.shown ?? []).entries()) {
        outputs.push({
          key: `${input.key}-node-${i + 1}`,
          label: n.name,
          nodeId: n.nodeId,
          preview: n.preview ? bufferPreview(Buffer.from(n.preview, "base64"), n.name) : undefined,
          profile: "web",
        });
      }
    }
    if (res.ok) {
      const page = this.pagesOfRun.get(ctx.runId)?.find((p) => p.pageId === st.pageId);
      if (page) page.made = true;
    }
    const findings: RuleFinding[] = (res.findings ?? []).map((f) => ({ type: f.type, message: f.message }));
    const error = res.ok ? undefined : `Action ${res.error!.index + 1} (${res.error!.action}): ${res.error!.message}`;
    return {
      ok: res.ok,
      error,
      scriptFailure: !res.ok,
      outputs,
      values,
      findings,
      log: [...(res.log ?? []), ...prepared.barcodes.map((b) => `Barcode ${b}`)],
      data: { steps: res.steps, results: res.results, page: res.page, ...(st.source ? { source: st.source } : {}) },
    };
  }

  async endStage(session: StageSession): Promise<void> {
    const st = session.state as FigmaStageState;
    if (!this.deps.bridge.list().some((s) => s.id === st.sessionId)) return;
    await this.request(st.sessionId, { type: "endStage", stageSessionId: st.stageSessionId }, "endStage").catch(() => undefined);
  }

  /**
   * After a run, Figma shows the designer's page again. A trial's scratch page is removed, and so is a copy no item
   * worked on (a failed run leaves nothing behind); copies with results stay in the file.
   */
  async endRun(runId: string): Promise<void> {
    for (const key of [...this.runPages.keys()]) if (key.startsWith(`${runId}:`)) this.runPages.delete(key);
    const pages = this.pagesOfRun.get(runId) ?? [];
    this.pagesOfRun.delete(runId);
    for (const p of pages) {
      if (!this.deps.bridge.list().some((s) => s.id === p.sessionId)) continue;
      await this.request(p.sessionId, { type: "finishPage", pageId: p.pageId, remove: p.trial || !p.made }, "finishPage").catch(() => undefined);
    }
  }

  // ---------- Other ----------

  async runScript(): Promise<ScriptResult> {
    throw new Error("This Figma routine was made by an older Doppl that ran code in Figma. Create it again with New task.");
  }

  async renderPreview(target: string): Promise<PreviewImage> {
    let preview: PreviewImage | undefined;
    if (target.startsWith("file:")) {
      preview = await filePreview(target.slice(5));
    } else {
      const m = target.match(/^node:(.*)#(.+)$/);
      if (!m) throw new Error(`Unknown preview target: ${target}`);
      const live = this.deps.bridge.sessionFor(m[1]);
      if (live) {
        const previews = await this.request<Record<string, string>>(live.id, { type: "preview", nodeIds: [m[2]], width: 640 }, "preview");
        if (previews[m[2]]) preview = bufferPreview(Buffer.from(previews[m[2]], "base64"), m[2]);
      } else {
        const file = this.linkedFile(m[1]);
        const token = await this.deps.getToken();
        if (file && token) {
          const images = await renderNodes(token, file.key, [m[2]], 1);
          if (images[m[2]]) preview = bufferPreview(images[m[2]], file.name);
        }
      }
    }
    if (!preview) throw new Error("Couldn't render a preview.");
    return preview;
  }

  async renderPagePreviews() {
    return {};
  }

  async ruleChecks() {
    // Figma findings come from the actions while a stage runs (measure, fonts, images, barcodes).
    return [];
  }

  async getParamOptions(source: string, docId?: string): Promise<ParamOption[]> {
    if (source !== "frames" || !docId) return [];
    const summary = await this.inspectDocument(docId);
    return [...new Map((summary.frames ?? []).map((f) => [f.name, f])).values()].map((f) => ({ value: f.name, label: `${f.name} (${f.width}×${f.height})` }));
  }

  async missingFonts(families: string[]): Promise<string[]> {
    const sessions = this.deps.bridge.list();
    if (families.length === 0 || sessions.length === 0) return [];
    const available = new Set((await this.request<string[]>(sessions[0].id, { type: "fonts" }, "fonts")).map((f) => f.toLowerCase()));
    return families.filter((f) => !available.has(f.toLowerCase()));
  }

  async openInApp(docId: string, target?: { nodeId?: string }) {
    const live = this.deps.bridge.sessionFor(docId);
    if (live && target?.nodeId) {
      await this.request(live.id, { type: "focus", nodeId: target.nodeId }, "focus");
      return;
    }
    const file = this.linkedFile(docId);
    if (file) await shell.openExternal(fileLink(file.key, target?.nodeId));
  }

  async closeDocument() {
    // Trial pages are removed in endRun.
  }

  /** Frame sizes, text and color styles of a Figma file (for the style profile). */
  async readStyleFacts(link: string): Promise<StyleFacts> {
    const parsed = parseFigmaLink(link);
    if (!parsed) throw new FigmaApiError(400, "That doesn't look like a Figma file link.");
    const token = await this.deps.getToken();
    if (!token) throw new FigmaApiError(401, "Add your Figma access token in Connect apps → Figma first.");
    const data = await getFile(token, parsed.key, 2);
    const frames = topFrames(data);
    const sizes = new Map<string, number>();
    for (const f of frames) sizes.set(`${f.width}×${f.height}`, (sizes.get(`${f.width}×${f.height}`) ?? 0) + 1);
    const topSizes = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const styles = Object.values(data.styles ?? {});
    const named = (type: string) => styles.filter((s) => s.styleType === type).map((s) => s.name);
    const facts = [
      topSizes.length ? { label: "Frame sizes", value: topSizes.map(([s, n]) => `${s} (${n})`).join(", ") } : null,
      named("TEXT").length ? { label: "Text styles", value: named("TEXT").slice(0, 10).join(", ") } : null,
      named("FILL").length ? { label: "Color styles", value: named("FILL").slice(0, 10).join(", ") } : null,
      named("GRID").length ? { label: "Layout grids", value: named("GRID").slice(0, 6).join(", ") } : null,
    ].filter((f): f is { label: string; value: string } => f !== null);
    return { name: data.name, facts };
  }
}

import { shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppStatus, DocumentRef, DocumentSummary, FigmaFile, ParamOption, PreviewImage, RuleFinding } from "../../core/types";
import { bufferPreview, filePreview } from "../previews";
import type { AdapterOutput, DesignAppAdapter, Progress, ScriptContext, ScriptResult, StyleFacts } from "../types";
import { FigmaApiError, fileLink, getFile, parseFigmaLink, renderNodes, topFrames } from "./figmaRest";
import { lintFigmaScript } from "./lint";
import { FIGMA_MODEL_GUIDE } from "./modelGuide";
import { type FigmaPluginBridge, PluginNotConnectedError } from "./pluginBridge";

interface RunResponse {
  outputs: { key: string; label: string; nodeId?: string; details?: { label: string; value?: string }[]; preview?: string }[];
  findings: RuleFinding[];
  log: string[];
  exports: { folder?: string; fileName: string; format: string; nodeId?: string; data: string }[];
  result: unknown;
  page: { id: string; name: string };
}

const EXT: Record<string, string> = { PNG: ".png", JPG: ".jpg", SVG: ".svg", PDF: ".pdf" };
const docIdOf = (key: string) => `figma:${key}`;
const keyOf = (docId: string) => docId.replace(/^figma:/, "");
const safeName = (name: string) => name.replace(/[/\\:*?"<>|]/g, "-").trim() || "export";

/**
 * Real Figma: files are connected by link and read with Figma's REST API (personal access token);
 * routines run through the Doppel plugin open in Figma (figma-plugin/), which can change designs.
 */
export class FigmaAdapter implements DesignAppAdapter {
  readonly id = "figma";
  readonly name = "Figma";
  readonly scriptLanguage = "Figma Plugin API (JavaScript)";
  readonly connection = "links-and-plugin" as const;
  readonly modelGuide = FIGMA_MODEL_GUIDE;
  readonly qcChecks = [
    { level: "rule" as const, types: ["font-missing" as const], label: () => "Fonts are available" },
    { level: "rule" as const, types: ["upscaled-image" as const], label: () => "Images aren't shown larger than their pixels" },
    { level: "object" as const, types: ["cut-off" as const], label: () => "Text stays inside its frame" },
  ];

  constructor(
    private readonly deps: {
      getToken: () => Promise<string | null>;
      getFiles: () => FigmaFile[];
      bridge: FigmaPluginBridge;
      getTimeoutSec: () => number;
    },
  ) {}

  private async token(): Promise<string> {
    const token = await this.deps.getToken();
    if (!token) throw new FigmaApiError(401, "Add your Figma access token in Connect apps → Figma first.");
    return token;
  }

  private file(docId: string): FigmaFile {
    const key = keyOf(docId);
    const file = this.deps.getFiles().find((f) => f.key === key);
    if (!file) throw new FigmaApiError(404, "This Figma file isn't connected anymore. Add its link in Connect apps → Figma.");
    return file;
  }

  /** The connected file the plugin is open on (matched by key when Figma shares it, else by name). */
  private pluginFileKey(): string | undefined {
    const { connected, info } = this.deps.bridge.status();
    if (!connected || !info) return undefined;
    const files = this.deps.getFiles();
    return (
      files.find((f) => info.fileKey && f.key === info.fileKey)?.key ??
      files.find((f) => f.name.trim().toLowerCase() === info.fileName.trim().toLowerCase())?.key
    );
  }

  async getStatus(): Promise<AppStatus> {
    return (await this.deps.getToken()) ? "connected" : "needs-setup";
  }

  async getDetail() {
    const { connected, info } = this.deps.bridge.status();
    return connected && info ? `Plugin open on ${info.fileName} · ${info.pageName}` : "Plugin not open";
  }

  async getAppVersion() {
    return null;
  }

  async listOpenDocuments(): Promise<DocumentRef[]> {
    const open = this.pluginFileKey();
    return this.deps.getFiles().map((f) => ({ id: docIdOf(f.key), appId: this.id, name: f.name, path: f.url, active: f.key === open }));
  }

  async inspectDocument(docId: string): Promise<DocumentSummary> {
    const file = this.file(docId);
    const data = await getFile(await this.token(), file.key, 2);
    const frames = topFrames(data);
    const styles = Object.values(data.styles ?? {});
    return {
      ref: { id: docId, appId: this.id, name: data.name, path: file.url },
      appVersion: "",
      pageCount: data.document.children?.length ?? 0,
      layers: (data.document.children ?? []).map((p) => p.name),
      paragraphStyles: styles.filter((s) => s.styleType === "TEXT").map((s) => s.name),
      characterStyles: [],
      textFrameCount: 0,
      links: [],
      fonts: [],
      frames,
    };
  }

  /** The plugin must be open on the file the routine runs on. */
  private assertPluginOn(file: FigmaFile) {
    const { connected, info } = this.deps.bridge.status();
    if (!connected || !info) {
      throw new PluginNotConnectedError(`Open “${file.name}” in Figma and start the Doppel plugin (Plugins → Development → Doppel).`);
    }
    if (this.pluginFileKey() !== file.key) {
      throw new PluginNotConnectedError(`The Doppel plugin is open on “${info.fileName}”. Open “${file.name}” in Figma and start the plugin there.`);
    }
  }

  async runScript(script: string, params: Record<string, unknown>, onProgress: (p: Progress) => void, ctx: ScriptContext): Promise<ScriptResult> {
    const file = this.file(ctx.documentId ?? docIdOf(this.pluginFileKey() ?? this.deps.getFiles()[0]?.key ?? ""));
    this.assertPluginOn(file);
    onProgress({
      phase:
        ctx.target === "trial"
          ? "Running on a temporary copy of the page in Figma"
          : ctx.target === "copy"
            ? "Duplicating the page in Figma and running there"
            : "Running in Figma",
    });
    const res = await this.deps.bridge.request<RunResponse>(
      { type: "run", script, params, routineName: ctx.routineName, mode: ctx.target, previewWidth: 640 },
      this.deps.getTimeoutSec() * 1000,
    );

    const outputs: AdapterOutput[] = res.outputs.map((o) => ({
      key: o.key,
      label: o.label,
      nodeId: o.nodeId,
      details: o.details,
      preview: o.preview ? bufferPreview(Buffer.from(o.preview, "base64"), o.label) : undefined,
      profile: "web",
    }));

    // Exports go only into folders the designer picked for this run.
    const allowed = ctx.allowedFolders.map((f) => path.resolve(f));
    for (const [i, e] of res.exports.entries()) {
      const folder = e.folder ? path.resolve(e.folder) : "";
      if (!allowed.includes(folder)) throw new Error("The routine tried to save a file outside the folders you picked.");
      await fs.mkdir(folder, { recursive: true });
      const filePath = path.join(folder, `${safeName(path.basename(e.fileName)).replace(/\.(png|jpe?g|svg|pdf)$/i, "")}${EXT[e.format] ?? ".png"}`);
      await fs.writeFile(filePath, Buffer.from(e.data, "base64"));
      const owner = outputs.find((o) => o.nodeId && o.nodeId === e.nodeId && !o.filePath);
      if (owner) owner.filePath = filePath;
      else outputs.push({ key: `file-${i + 1}`, label: path.basename(filePath), filePath, nodeId: e.nodeId });
    }

    const pageNote = ctx.target === "copy" ? ` · ${res.page.name}` : "";
    return {
      outputs,
      document: { id: docIdOf(file.key), name: `${file.name}${pageNote}` },
      log: res.log ?? [],
      data: res.result,
      findings: res.findings ?? [],
    };
  }

  async renderPreview(target: string): Promise<PreviewImage> {
    let preview: PreviewImage | undefined;
    if (target.startsWith("file:")) {
      preview = await filePreview(target.slice(5));
    } else {
      const m = target.match(/^node:(.*)#(.+)$/);
      if (!m) throw new Error(`Unknown preview target: ${target}`);
      const file = this.file(m[1]);
      if (this.pluginFileKey() === file.key) {
        const previews = await this.deps.bridge.request<Record<string, string>>({ type: "export", nodeIds: [m[2]], width: 640 }, 60_000);
        if (previews[m[2]]) preview = bufferPreview(Buffer.from(previews[m[2]], "base64"), file.name);
      }
      if (!preview) {
        const images = await renderNodes(await this.token(), file.key, [m[2]], 1);
        if (images[m[2]]) preview = bufferPreview(images[m[2]], file.name);
      }
    }
    if (!preview) throw new Error("Couldn't render a preview.");
    return preview;
  }

  async renderPagePreviews() {
    return {};
  }

  async ruleChecks() {
    // Figma checks each frame while the routine runs (ScriptResult.findings).
    return [];
  }

  async getParamOptions(source: string, docId?: string): Promise<ParamOption[]> {
    if (source !== "frames" || !docId) return [];
    const data = await getFile(await this.token(), this.file(docId).key, 2);
    const seen = new Set<string>();
    return topFrames(data)
      .filter((f) => !seen.has(f.name) && seen.add(f.name))
      .map((f) => ({ value: f.name, label: `${f.name} (${f.width}×${f.height}) · ${f.page}` }));
  }

  async missingFonts(families: string[]): Promise<string[]> {
    if (families.length === 0 || !this.deps.bridge.status().connected) return [];
    const available = new Set((await this.deps.bridge.request<string[]>({ type: "fonts" }, 30_000)).map((f) => f.toLowerCase()));
    return families.filter((f) => !available.has(f.toLowerCase()));
  }

  async openInApp(docId: string, target?: { nodeId?: string }) {
    const file = this.file(docId);
    if (target?.nodeId && this.pluginFileKey() === file.key) {
      await this.deps.bridge.request({ type: "focus", nodeId: target.nodeId }, 15_000);
      return;
    }
    await shell.openExternal(fileLink(file.key, target?.nodeId));
  }

  async closeDocument() {
    // Trial pages are removed by the plugin itself.
  }

  async connect() {
    return this.getStatus();
  }

  lintScript(script: string) {
    return lintFigmaScript(script);
  }

  /** Frame sizes, text and color styles of a Figma file (for the style profile). */
  async readStyleFacts(link: string): Promise<StyleFacts> {
    const parsed = parseFigmaLink(link);
    if (!parsed) throw new FigmaApiError(400, "That doesn't look like a Figma file link.");
    const data = await getFile(await this.token(), parsed.key, 2);
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

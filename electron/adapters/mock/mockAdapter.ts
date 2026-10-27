import type { AppStatus, DocumentRef, DocumentSummary, ParamOption, PreviewImage } from "../../core/types";
import { delay } from "../../core/util";
import { placeholderPreview } from "../previews";
import type { AdapterOutput, DesignAppAdapter, Progress, RuleCheckOptions, RuleFinding, ScriptContext, ScriptResult } from "../types";

export interface MockFormat {
  id: string;
  label: string;
  width: number;
  height: number;
}

export interface MockAdapterConfig {
  id: string;
  name: string;
  scriptLanguage: string;
  connection: "script-bridge" | "in-app-plugin";
  modelGuide: string;
  version: string;
  documents: (DocumentRef & { frames?: { name: string; width: number; height: number }[] })[];
  formats: MockFormat[];
  /** Mock layer names for rename routines. */
  layers: string[];
  /** Status when not connected ("not-installed" = plugin missing). */
  disconnectedStatus: AppStatus;
  isConnected: () => boolean;
  setConnected: (value: boolean) => Promise<void> | void;
  /** Rule findings the mock reports, keyed by output key. */
  findings: Record<string, RuleFinding["type"] | undefined>;
}

/**
 * A design app that doesn't exist: fake documents, fake progress, gray placeholder previews.
 * Used for Figma in this pass (and for InDesign when DOPPEL_MOCK_INDESIGN=1).
 */
export class MockAdapter implements DesignAppAdapter {
  readonly id: string;
  readonly name: string;
  readonly scriptLanguage: string;
  readonly connection: "script-bridge" | "in-app-plugin";
  readonly modelGuide: string;

  constructor(private readonly config: MockAdapterConfig) {
    this.id = config.id;
    this.name = config.name;
    this.scriptLanguage = config.scriptLanguage;
    this.connection = config.connection;
    this.modelGuide = config.modelGuide;
  }

  async getStatus(): Promise<AppStatus> {
    return this.config.isConnected() ? "connected" : this.config.disconnectedStatus;
  }

  async getAppVersion() {
    return this.config.isConnected() ? this.config.version : null;
  }

  async listOpenDocuments(): Promise<DocumentRef[]> {
    if (!this.config.isConnected()) return [];
    return this.config.documents.map(({ frames: _frames, ...ref }) => ref);
  }

  async inspectDocument(docId: string): Promise<DocumentSummary> {
    const doc = this.config.documents.find((d) => d.id === docId) ?? this.config.documents[0];
    return {
      ref: { id: doc.id, appId: doc.appId, name: doc.name, pageCount: doc.pageCount },
      appVersion: this.config.version,
      pageCount: doc.pageCount ?? doc.frames?.length ?? 1,
      layers: this.config.layers,
      paragraphStyles: ["Headline", "Body", "Caption"],
      characterStyles: ["Emphasis"],
      textFrameCount: 6,
      links: [],
      fonts: [{ name: "Inter Regular", status: "installed" }],
      frames: doc.frames,
    };
  }

  private plannedOutputs(params: Record<string, unknown>): AdapterOutput[] {
    // Any list param is treated as the format list (a model may name it "formats", "sizes", …).
    const list = Object.values(params).find((v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (list && this.config.formats.length) {
      const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return list.map((value) => {
        const f = this.config.formats.find((x) => x.id === slug(value) || slug(`${x.label}`) === slug(value)) ?? {
          id: slug(value),
          label: value,
          width: 1080,
          height: 1080,
        };
        return {
          key: `format-${f.id}`,
          label: `${f.label} ${f.width}×${f.height}`,
          preview: placeholderPreview(`${f.label}\n${f.width}×${f.height}`, f.width, f.height),
          profile: "web" as const,
        };
      });
    }
    if (typeof params.pattern === "string") {
      const pattern = params.pattern;
      const details = this.config.layers.map((name, i) => ({
        label: name,
        value: pattern.replace("{index}", String(i + 1).padStart(2, "0")).replace("{name}", name).replace("{section}", "Campaign"),
      }));
      return [
        {
          key: "layers",
          label: `Renamed ${details.length} layers`,
          details,
          preview: placeholderPreview("Layers panel", 4, 3),
        },
      ];
    }
    return [1, 2, 3, 4].map((n) => ({
      key: `page-${n}`,
      label: `Page ${n}`,
      page: String(n),
      pageIndex: n,
      preview: placeholderPreview(`Page ${n}`, 210, 297),
    }));
  }

  async runScript(
    _script: string,
    params: Record<string, unknown>,
    onProgress: (p: Progress) => void,
    ctx: ScriptContext,
  ): Promise<ScriptResult> {
    const outputs = this.plannedOutputs(params);
    const doc = this.config.documents.find((d) => d.id === ctx.documentId) ?? this.config.documents[0];
    for (const o of outputs) onProgress({ output: { ...o, status: "pending", preview: undefined } });
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      onProgress({ phase: `Generating ${o.label}`, done: i, total: outputs.length, output: { ...o, status: "running", preview: undefined } });
      await delay((350 + ((i * 137) % 300)) * ctx.speed, ctx.isCancelled);
      onProgress({ done: i + 1, total: outputs.length, output: { ...o, status: "done" } });
    }
    return { outputs, document: { id: doc.id, name: doc.name }, log: [] };
  }

  async renderPreview(target: string): Promise<PreviewImage> {
    const format = this.config.formats.find((f) => target.includes(f.id));
    if (format) return placeholderPreview(`${format.label}\n${format.width}×${format.height}`, format.width, format.height);
    return placeholderPreview(target, 4, 3);
  }

  async renderPagePreviews(_docId: string, pageIndexes: number[]): Promise<Record<number, PreviewImage>> {
    return Object.fromEntries(pageIndexes.map((n) => [n, placeholderPreview(`Page ${n}`, 210, 297)]));
  }

  async ruleChecks(_docId: string | undefined, options: RuleCheckOptions): Promise<RuleFinding[]> {
    const findings: RuleFinding[] = [];
    for (const o of options.outputs) {
      const type = this.config.findings[o.key];
      if (type === "overset") findings.push({ type, message: "Text overflows its frame", outputKey: o.key, simulated: true });
    }
    return findings;
  }

  async getParamOptions(source: string): Promise<ParamOption[]> {
    if (source === "frames") {
      const frames = this.config.documents.flatMap((d) => d.frames ?? []);
      return frames.map((f) => ({ value: f.name, label: `${f.name} (${f.width}×${f.height})` }));
    }
    return [];
  }

  async missingFonts(): Promise<string[]> {
    return [];
  }

  async openInApp(): Promise<void> {
    // Mock: nothing to open.
  }

  async closeDocument(): Promise<void> {}

  async connect(): Promise<AppStatus> {
    await this.config.setConnected(true);
    return this.getStatus();
  }
}

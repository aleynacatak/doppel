import type {
  AppId,
  AppStatus,
  DocumentRef,
  DocumentSummary,
  OutputDetail,
  OutputStatus,
  ParamDef,
  ParamOption,
  PreviewImage,
  QcLevel,
  RuleFinding,
  RuleFindingType,
  Stage,
} from "../core/types";

export type { RuleFinding };

/** One thing a routine produced: a file, a page, a Figma frame, or a report. */
export interface AdapterOutput {
  /** Stable key within one run, e.g. "page-3" or "format-instagram-post". */
  key: string;
  label: string;
  filePath?: string;
  page?: string;
  pageIndex?: number;
  /** Figma node id of a frame the routine made. */
  nodeId?: string;
  details?: OutputDetail[];
  preview?: PreviewImage;
  profile?: "print" | "web";
}

export interface Progress {
  /** Plain-language description of what is happening. */
  phase?: string;
  done?: number;
  total?: number;
  /** Per-output progress (adapters that know their outputs up front). */
  output?: AdapterOutput & { status: OutputStatus; error?: string };
}

export interface ScriptContext {
  runId: string;
  routineName: string;
  /** Document to run on. Defaults to the app's active document. */
  documentId?: string;
  /** "copy": run on a copy (InDesign: a saved copy of the file; Figma: a duplicate of the page). "trial": hidden copy, removed afterwards. */
  target: "copy" | "original" | "trial";
  /** Folder Doppl owns for temp files of this run (deleted afterwards). */
  workDir: string;
  /** Where copies of unsaved documents go (they have no folder of their own). */
  copiesDir: string;
  /** The routine edits the document (vs. only reading/exporting it). */
  modifiesDocument: boolean;
  /** Folders the designer picked for this run; routines may only write files there. */
  allowedFolders: string[];
  isCancelled: () => boolean;
}

export interface ScriptResult {
  outputs: AdapterOutput[];
  /** Document the script actually ran on (the copy when target is "copy"). */
  document?: { id: string; name: string };
  log: string[];
  data?: unknown;
  /** Rule/object findings the app computed during the run (Figma checks each frame it made). */
  findings?: RuleFinding[];
}

export interface RuleCheckOptions {
  /** The adapter reports every image below this resolution; QC filters per output. */
  minPpi: number;
  outputs: AdapterOutput[];
}

/** One automatic check an app supports, and which findings make it fail. */
export interface QcCheckDef {
  level: QcLevel;
  types: RuleFindingType[];
  label: (minPpi: number) => string;
}

// ---------- Stages (multi-app routines) ----------

/** Everything a stage run needs from the core; the same for every item of the stage. */
export interface StageRunContext {
  runId: string;
  routineName: string;
  stage: Stage;
  /** The document picked for this stage's app (stages with document "open"). */
  documentId?: string;
  /** "copy": on a copy (Figma: a copy of the page). "original": in place. "trial": a scratch copy that is removed afterwards. */
  target: "copy" | "original" | "trial";
  /** This stage's working folder (runs/<runId>/<stageId>/): files handed to later stages go here. */
  workDir: string;
  /** Where copies of unsaved documents go (they have no folder of their own). */
  copiesDir: string;
  /** Where the stage may write files: the working folder and the folder params picked for the run. */
  allowedFolders: string[];
  isCancelled: () => boolean;
}

/** One item of a stage (the whole stage when it doesn't repeat). Placeholders are already expanded. */
export interface StageItemInput {
  key: string;
  label: string;
  /** 0-based position among the stage's items. */
  index: number;
  item: unknown;
  params: Record<string, unknown>;
  /** Outputs of earlier stages: stages.<id>.outputs.<key>. */
  stages: Record<string, { outputs: Record<string, unknown[]> }>;
  /** Action list (Figma) or script (ExtendScript) for this item. */
  body: unknown;
}

export interface StageItemResult {
  ok: boolean;
  error?: string;
  /** The routine's own code failed (as opposed to the app being unavailable). */
  scriptFailure?: boolean;
  outputs: AdapterOutput[];
  /** Values for the stage's named outputs, e.g. { files: ["/…/label-1.png"] }. */
  values: Record<string, unknown[]>;
  findings: RuleFinding[];
  log: string[];
  /** Results of reading actions/scripts (for previews to the model and the dev panel). */
  data?: unknown;
}

/** Adapter-owned state for one stage run (a working copy, a page, documents opened along the way). */
export interface StageSession {
  state: Record<string, unknown>;
  /** What the stage runs on, for the Run screen, e.g. "Campaign · Labels (Doppl copy)". */
  documentName?: string;
}

/** Facts about a document's house style (for the style profile). */
export interface StyleFacts {
  name: string;
  facts: { label: string; value: string }[];
}

/** An example routine shown to the model (real, working code). */
export interface RoutineTemplate {
  id: string;
  appId: AppId;
  name: string;
  description: string;
  keywords: string[];
  steps: string[];
  params: ParamDef[];
  script: string;
  modifiesDocument: boolean;
  qcProfile: "print" | "web";
  builtInQc?: boolean;
  experimental?: boolean;
  requiredFonts: string[];
}

export interface DesignAppAdapter {
  id: AppId;
  name: string;
  /** e.g. "ExtendScript", "Figma Plugin API (JS)" */
  scriptLanguage: string;
  connection: "script-bridge" | "links-and-plugin";
  /** Notes for the AI about this app's scripting. */
  modelGuide: string;
  /** The automatic checks this app supports ("Automatic check" on the Run screen). */
  qcChecks: QcCheckDef[];

  getStatus(): Promise<AppStatus>;
  /** One line about the connection for the Connect screen and sidebar. */
  getDetail(): Promise<string | undefined>;
  /** Display version ("21.6") once connected; null when the app has no versions (Figma). */
  getAppVersion(): Promise<string | null>;
  listOpenDocuments(): Promise<DocumentRef[]>;
  inspectDocument(docId: string): Promise<DocumentSummary>;
  runScript(
    script: string,
    params: Record<string, unknown>,
    onProgress: (p: Progress) => void,
    ctx: ScriptContext,
  ): Promise<ScriptResult>;
  /** target: "file:<path>", "page:<docId>#<pageIndex>" or "node:<docId>#<nodeId>". */
  renderPreview(target: string): Promise<PreviewImage>;
  /** Batch page previews: pageIndex → preview. */
  renderPagePreviews(docId: string, pageIndexes: number[], workDir: string): Promise<Record<number, PreviewImage>>;
  /** Rule-level quality checks on the document a run produced. */
  ruleChecks(docId: string | undefined, options: RuleCheckOptions): Promise<RuleFinding[]>;
  /** Options for params with an optionsSource, e.g. "pdfExportPresets" or "frames" (per document). */
  getParamOptions(source: string, docId?: string): Promise<ParamOption[]>;
  /** Font families from the list that are not installed. */
  missingFonts(families: string[]): Promise<string[]>;
  /** Bring the app forward on a document (and page or node). */
  openInApp(docId: string, target?: { pageIndex?: number; nodeId?: string }): Promise<void>;
  /** Close a document without saving (trial-run copies). */
  closeDocument(docId: string): Promise<void>;
  /** "Check again" on the Connect screen. */
  connect(): Promise<AppStatus>;
  /** Problems in a routine script that must be fixed before it runs (syntax, unsupported or unsafe APIs). */
  lintScript?(script: string): string[];
  /** Reads house-style facts from a file (InDesign path or Figma link). */
  readStyleFacts?(source: string): Promise<StyleFacts>;

  // Stages of multi-app routines: the core calls begin → item × n → end.
  /** Kind of stage this app runs. */
  stageKind: "actions" | "script";
  beginStage(ctx: StageRunContext): Promise<StageSession>;
  runStageItem(session: StageSession, input: StageItemInput, ctx: StageRunContext, onProgress: (text: string) => void): Promise<StageItemResult>;
  /** Always called, also after failures or cancel. Closes working copies. */
  endStage(session: StageSession, ctx: StageRunContext): Promise<void>;
  /** After the last stage of a run (also after failures): removes scratch copies of trial runs. */
  endRun?(runId: string): Promise<void>;
  /** What the model needs to write stages for this app (action catalog, or script guide and helper library). */
  capabilityManifest(): string;
  /** Deeper look for the model ("inspect_<app>" tool), e.g. one Figma node with its children. */
  inspectForModel(docId: string, args: Record<string, unknown>): Promise<unknown>;
}

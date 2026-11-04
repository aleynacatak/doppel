import type {
  AppId,
  AppStatus,
  DocumentRef,
  DocumentSummary,
  FailureCause,
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
  /** Only listed when it finds something: for a check most routines have nothing to do with. */
  onlyWhenFound?: boolean;
}

// ---------- Running a routine (begin → item × n → end) ----------

/** Everything a routine run needs from the core; the same for every item. */
export interface StageRunContext {
  runId: string;
  routineName: string;
  stage: Stage;
  /** The document picked for the routine's app (routines with a document input). */
  documentId?: string;
  /** "copy": on a copy (Figma: a copy of the page). "original": in place. "trial": a scratch copy that is removed afterwards. */
  target: "copy" | "original" | "trial";
  /** The node's working folder (runs/<runId>/<nodeId>/): files handed to later routines go here. */
  workDir: string;
  /** Where copies of unsaved documents go (they have no folder of their own). */
  copiesDir: string;
  isCancelled: () => boolean;
}

/** One item of a routine run (the whole run when it doesn't iterate). Placeholders are already expanded. */
export interface StageItemInput {
  key: string;
  label: string;
  /** 0-based position among the items. */
  index: number;
  item: unknown;
  /** Per joined list input: the item paired with this one (ctx.matched.<key> in scripts). */
  matched?: Record<string, unknown>;
  /** Inputs and settings by key (params.<key> in scripts). */
  params: Record<string, unknown>;
  /** Action list (Figma) or script (ExtendScript) for this item. */
  body: unknown;
}

export interface StageItemResult {
  ok: boolean;
  error?: string;
  /** The routine's own code failed (as opposed to the app being unavailable). */
  scriptFailure?: boolean;
  /** Whose problem a failure is, when the adapter knows (a wrong barcode in the data is the files'). */
  cause?: FailureCause;
  outputs: AdapterOutput[];
  /** Values for the routine's named outputs, e.g. { files: ["/…/label-1.png"] }. */
  values: Record<string, unknown[]>;
  findings: RuleFinding[];
  log: string[];
  /** Results of reading actions/scripts (for previews to the model and the dev panel). */
  data?: unknown;
}

/** Adapter-owned state for one routine run (a working copy, a page, documents opened along the way). */
export interface StageSession {
  state: Record<string, unknown>;
  /** What the stage runs on, for the Run screen, e.g. "Campaign · Labels (Doppl copy)". */
  documentName?: string;
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

export interface ManifestOptions {
  helperDocs?: "full" | "index";
  /** The designer's request, to rank building blocks by. */
  request?: string;
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

  // Running a routine: the core calls begin → item × n → end.
  /** What this app's routines are: an action list (Figma) or a script. */
  stageKind: "actions" | "script";
  beginStage(ctx: StageRunContext): Promise<StageSession>;
  runStageItem(session: StageSession, input: StageItemInput, ctx: StageRunContext, onProgress: (text: string) => void): Promise<StageItemResult>;
  /** Always called, also after failures or cancel. Closes working copies. */
  endStage(session: StageSession, ctx: StageRunContext): Promise<void>;
  /** After the last routine of a run (also after failures): removes scratch copies of trial runs and copies that kept nothing. */
  endRun?(runId: string): Promise<void>;
  /**
   * What the model needs to write routines for this app (action catalog, or script guide and helper library).
   * helperDocs "index": a ranked index of the building blocks (by relevance to the request) instead of all their docs.
   */
  capabilityManifest(options?: ManifestOptions): string;
  /** Deeper look for the model ("inspect_<app>" tool), e.g. one Figma node with its children. */
  inspectForModel(docId: string, args: Record<string, unknown>): Promise<unknown>;
  /** What's inside a file a routine would open (an InDesign template's text), read without changing it. Null: not a file this app reads. */
  readFileForModel?(file: string): Promise<unknown>;
}

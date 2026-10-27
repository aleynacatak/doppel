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
  RuleFinding,
} from "../core/types";

export type { RuleFinding };

/** One thing a routine produced: a file, a page, or a report. */
export interface AdapterOutput {
  /** Stable key within one run, e.g. "page-3" or "format-instagram-post". */
  key: string;
  label: string;
  filePath?: string;
  page?: string;
  pageIndex?: number;
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
  /** "copy": save a copy next to the original and run there. "trial": hidden temp copy, closed afterwards. */
  target: "copy" | "original" | "trial";
  /** Folder Doppel owns for temp files of this run (deleted afterwards). */
  workDir: string;
  /** Where copies of unsaved documents go (they have no folder of their own). */
  copiesDir: string;
  /** The routine edits the document (vs. only reading/exporting it). */
  modifiesDocument: boolean;
  isCancelled: () => boolean;
  /** Mock delays are multiplied by this (dev panel). */
  speed: number;
}

export interface ScriptResult {
  outputs: AdapterOutput[];
  /** Document the script actually ran on (the copy when target is "copy"). */
  document?: { id: string; name: string };
  log: string[];
  data?: unknown;
}

export interface RuleCheckOptions {
  /** The adapter reports every image below this resolution; QC filters per output. */
  minPpi: number;
  outputs: AdapterOutput[];
}

/** A prebuilt routine the mock AI can pick from (and that seeds the library). */
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
  /** Param that holds a file naming pattern, and the pattern to use when the user keeps their house style. */
  naming?: { paramKey: string; houseStyle: string };
}

export interface DesignAppAdapter {
  id: AppId;
  name: string;
  /** e.g. "ExtendScript", "Figma Plugin API (JS)" */
  scriptLanguage: string;
  connection: "script-bridge" | "in-app-plugin";
  /** Notes for the AI about this app's scripting. */
  modelGuide: string;

  getStatus(): Promise<AppStatus>;
  /** Display version ("21.6") once connected. */
  getAppVersion(): Promise<string | null>;
  listOpenDocuments(): Promise<DocumentRef[]>;
  inspectDocument(docId: string): Promise<DocumentSummary>;
  runScript(
    script: string,
    params: Record<string, unknown>,
    onProgress: (p: Progress) => void,
    ctx: ScriptContext,
  ): Promise<ScriptResult>;
  /** target: "file:<path>", "page:<docId>#<pageIndex>" or a label for mock placeholders. */
  renderPreview(target: string): Promise<PreviewImage>;
  /** Batch page previews: pageIndex → preview. */
  renderPagePreviews(docId: string, pageIndexes: number[], workDir: string): Promise<Record<number, PreviewImage>>;
  /** Rule-level quality checks on the document a run produced. */
  ruleChecks(docId: string | undefined, options: RuleCheckOptions): Promise<RuleFinding[]>;
  /** Options for params with an optionsSource, e.g. "pdfExportPresets". */
  getParamOptions(source: string): Promise<ParamOption[]>;
  /** Font families from the list that are not installed. */
  missingFonts(families: string[]): Promise<string[]>;
  /** Bring the app forward on a document (and page). */
  openInApp(docId: string, pageIndex?: number): Promise<void>;
  /** Close a document without saving (trial-run copies). */
  closeDocument(docId: string): Promise<void>;
  /** "Check again" on the Connect screen. */
  connect(): Promise<AppStatus>;
  /** Problems in a routine script that must be fixed before it runs (syntax, unsupported or unsafe APIs). */
  lintScript?(script: string): string[];
}


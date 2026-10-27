// Domain types shared by the main process and the renderer.
// The renderer imports this file with `import type` only, so it must stay free of runtime code.

export type AppId = "indesign" | "figma" | "photoshop" | (string & {});

/** "awaiting-permission": the app is open, but macOS is still asking whether Doppl may control it. */
export type AppStatus = "connected" | "not-running" | "not-installed" | "permission-denied" | "awaiting-permission" | "needs-setup";

export interface App {
  id: AppId;
  name: string;
  scriptLanguage: string;
  /** InDesign, Photoshop: AppleScript bridge on this Mac. Figma: the Doppl plugin (plus optional file links). */
  connection: "script-bridge" | "links-and-plugin";
  status: AppStatus;
  /** Display version, e.g. "21.6". Only known while connected. */
  version?: string;
  /** One line about the connection, e.g. "Plugin open on Campaign · Page 1". */
  detail?: string;
}

// ---------- Figma ----------

/** A Figma file connected to Doppl by its link. */
export interface FigmaFile {
  key: string;
  url: string;
  name: string;
  lastModified?: string;
  thumbnailUrl?: string;
  addedAt: string;
}

/** One Figma file with the Doppl plugin running in it (a WebSocket session). */
export interface FigmaSession {
  id: string;
  /** Document id used across Doppl: "figma:<fileKey>" or "figma-name:<file name>". */
  documentId: string;
  fileName: string;
  fileKey?: string;
  pageName?: string;
  pluginVersion: string;
  connectedAt: string;
  /** What the plugin is doing right now, e.g. "setText · item 3 of 6". */
  activity?: string;
}

export interface FigmaSetup {
  token: { saved: boolean; hint: string | null };
  files: FigmaFile[];
  /** Files with the plugin open right now. */
  sessions: FigmaSession[];
  /** Typed once into the Doppl plugin in Figma, so only this Mac's Doppl can talk to it. */
  pairingCode: string;
  /** Local port the plugin connects to (ws://localhost:<port>). */
  port: number;
  /** Folder that holds the plugin's manifest.json (for Plugins → Development → Import plugin from manifest). */
  pluginFolder: string;
}

export interface DocumentRef {
  /** Stable for the session: the file path when saved, otherwise "untitled:<name>". */
  id: string;
  appId: AppId;
  name: string;
  path?: string;
  pageCount?: number;
  active?: boolean;
}

export interface LinkInfo {
  name: string;
  status: "ok" | "missing" | "modified" | "embedded" | "inaccessible";
  page?: string;
}

export interface FontInfo {
  name: string;
  status: "installed" | "missing" | "substituted" | "other";
}

export interface DocumentSummary {
  ref: DocumentRef;
  appVersion: string;
  pageCount: number;
  pageSize?: { width: number; height: number; unit: string };
  layers: string[];
  paragraphStyles: string[];
  characterStyles: string[];
  textFrameCount: number;
  links: LinkInfo[];
  fonts: FontInfo[];
  /** Figma top-level frames, with the page they're on. */
  frames?: { name: string; width: number; height: number; page?: string; id?: string }[];
}

export interface Task {
  id: string;
  request: string;
  references: string[];
  /** Folders the designer pointed at (only file names are shared with the model). */
  folders?: string[];
  /** The first (or only) app and its document. */
  appId: AppId;
  documentId?: string;
  /** Every app the routine may use, with the document picked in each. */
  apps?: TaskApp[];
  createdAt: string;
}

export interface TaskApp {
  appId: AppId;
  documentId?: string;
  /** The designer chose "No document": this app's stages open their own files. */
  noDocument?: boolean;
}

export interface RoutineStep {
  id: string;
  plainLanguage: string;
}

/** "dataFile": a CSV, JSON or Excel file whose rows a stage can repeat over ({{params.<key>.rows}}). */
export type ParamType = "text" | "file" | "folder" | "dataFile" | "number" | "select" | "formatList" | "boolean";

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  required: boolean;
  default?: string | number | boolean | string[];
  help?: string;
  /** Static options for select / formatList. */
  options?: ParamOption[];
  /** Options the adapter lists at run time, e.g. "pdfExportPresets". */
  optionsSource?: string;
  /** File type filter for type "file" or "folder" contents, e.g. ["txt", "docx"]. */
  extensions?: string[];
  /** dataFile: columns every row must have. */
  columns?: string[];
  /** folder: files are read from it ("input") or results are saved into it ("output"). */
  role?: "input" | "output";
  min?: number;
  max?: number;
}

export type ParamValue = string | number | boolean | string[] | null;
export type ParamValues = Record<string, ParamValue>;

// ---------- Stages (multi-app routines) ----------

/** One Figma action (validated against the action catalog in electron/shared/figmaActions.ts). */
export interface FigmaActionStep {
  action: string;
  /** Names the action's result so later actions can use it as "$id". */
  id?: string;
  [key: string]: unknown;
}

export interface FigmaActionList {
  actions: FigmaActionStep[];
}

export type StageKind = "actions" | "script";
export type StageOutputType = "fileList" | "file" | "nodeList" | "data";

export interface StageOutputDef {
  key: string;
  type: StageOutputType;
  label?: string;
}

/**
 * One part of a routine that runs in one app. Stages run in order and hand results to each other through
 * placeholders: {{params.<key>}}, {{item.<field>}} (repeated stages) and {{stage.<id>.outputs.<key>}}.
 */
export interface Stage {
  id: string;
  name: string;
  appId: AppId;
  /** Figma: "actions" (a declarative action list). InDesign, Photoshop: "script" (ExtendScript). */
  kind: StageKind;
  body: FigmaActionList | string;
  /** Run once per item of a list, e.g. "{{params.data.rows}}" or "{{stage.s1.outputs.files}}". */
  repeat?: { over: string };
  /** Placeholders the stage reads (params and earlier stages' outputs). */
  inputs: string[];
  outputs: StageOutputDef[];
  /** Plain-language steps for the routine page. */
  steps?: string[];
  /** "open": runs on a document the designer picks among those open in the app. "none": opens its own files. */
  document?: "open" | "none";
  /** The stage changes the document it runs on (vs. only reading or exporting). */
  modifiesDocument?: boolean;
}

export interface RoutineVersion {
  version: number;
  createdAt: string;
  aiCalls: number;
  note: string;
}

export interface Routine {
  id: string;
  name: string;
  appId: AppId;
  description: string;
  steps: RoutineStep[];
  params: ParamDef[];
  script: string;
  version: number;
  createdWithAiCalls: number;
  appVersion: string;
  requiredFonts: string[];
  runs: RunSummary[];
  createdAt: string;
  updatedAt: string;
  versions: RoutineVersion[];
  /** Example routine the routine was based on, if any. */
  templateId?: string;
  experimental?: boolean;
  /** Whether the routine edits the document (vs. only exporting or reading it). */
  modifiesDocument: boolean;
  /** Default image-resolution profile for rule checks. */
  qcProfile: "print" | "web";
  /** The routine itself reports rule-level findings (e.g. Preflight report). */
  builtInQc?: boolean;
  /** Portability problems the user chose to accept when saving. */
  portabilityIssues?: PortabilityIssue[];
  lastParams?: ParamValues;
  /** Objects that must stay fully visible in outputs (checked with SAM while creating). */
  keyObjects?: string[];
  /** Multi-app routines. Older single-app routines have none and run as one script stage. */
  stages?: Stage[];
  /** Object checks with SAM that the routine defines ("Automatic check + AI review" only). */
  objectChecks?: ObjectCheckDef[];
}

/** "Check that <object> is inside <region> in this output image" (SAM, counted as AI calls). */
export interface ObjectCheckDef {
  object: string;
  region: string;
}

export type RunStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type OutputStatus = "pending" | "running" | "done" | "failed";

export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  inputsSummary: string;
  qcStatus: "pass" | "flagged" | "not-checked";
  outputCount: number;
  flaggedCount: number;
  aiCalls: number;
  routineVersion: number;
}

export interface PreviewImage {
  kind: "image";
  /** data: URL */
  src: string;
  width?: number;
  height?: number;
  label: string;
}

export interface OutputDetail {
  label: string;
  value?: string;
}

export interface RunOutput {
  id: string;
  label: string;
  status: OutputStatus;
  preview?: PreviewImage;
  qc?: QcResult;
  error?: string;
  /** File written by the routine, if any. */
  filePath?: string;
  /** Page name as shown in the app, and its 1-based position. */
  page?: string;
  pageIndex?: number;
  /** Figma node the output is (a frame the routine made). */
  nodeId?: string;
  /** Multi-app routines: the stage and item that made this output. */
  stageId?: string;
  itemKey?: string;
  itemLabel?: string;
  details?: OutputDetail[];
  profile?: "print" | "web";
  markedOk?: boolean;
}

export type QcMode = "manual" | "auto" | "auto_ai";
export type QcLevel = "rule" | "object" | "visual";

export interface QcCheck {
  level: QcLevel;
  label: string;
  passed: boolean;
  reason?: string;
}

export interface QcResult {
  status: "pass" | "flagged";
  checks: QcCheck[];
}

export type RuleFindingType =
  | "overset"
  | "link-missing"
  | "link-modified"
  | "font-missing"
  | "low-res"
  /** InDesign: a text frame runs past the page edge. */
  | "off-page"
  /** InDesign: an image crosses the page edge but stops before the bleed. */
  | "short-of-bleed"
  /** Figma: text is clipped by its frame. */
  | "cut-off"
  /** Figma: an image is shown larger than its pixels (blurry). */
  | "upscaled-image"
  /** Text doesn't fit its own box or container. */
  | "text-overflow"
  /** An element sticks out of a boundary node. */
  | "outside-boundary"
  /** An image or data file a routine refers to doesn't exist. */
  | "file-missing"
  /** A font style (e.g. Bold) isn't available for the font. */
  | "font-style-missing"
  /** A barcode value has the wrong check digit or format. */
  | "barcode-invalid";

/** A rule-level problem found in a document. */
export interface RuleFinding {
  type: RuleFindingType;
  message: string;
  page?: string;
  pageIndex?: number;
  /** Ties a finding to one output when the adapter knows it (Figma frames). */
  outputKey?: string;
  /** Effective resolution for low-res images. */
  value?: number;
}

export interface QcOptions {
  minPpiPrint: number;
  minPpiWeb: number;
}

export interface RunOptions {
  /** InDesign: run on a copy saved next to the original (default) or on the original. Figma: on a copy of the page. */
  target: "copy" | "original";
  documentId?: string;
  /** Multi-app routines: the document picked per app. */
  documents?: Partial<Record<AppId, string>>;
  qcOptions?: QcOptions;
}

export type StageRunStatus = "pending" | "running" | "done" | "partial" | "failed" | "skipped" | "cancelled";

export interface StageItemProgress {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error?: string;
}

/** Progress and result of one stage in a run. */
export interface StageProgress {
  stageId: string;
  name: string;
  appId: AppId;
  status: StageRunStatus;
  total: number;
  done: number;
  failed: number;
  items: StageItemProgress[];
  error?: string;
  /** The document the stage ran on, e.g. "Campaign · Page 1 (Doppl copy)". */
  documentName?: string;
}

/** Whether a routine can run: per app, connected and with the right document. */
export interface ReadinessItem {
  appId: AppId;
  appName: string;
  status: AppStatus;
  ok: boolean;
  /** What to do, in plain language, when not ok. */
  message?: string;
  needsDocument: boolean;
  documents: DocumentRef[];
  documentId?: string;
  /** Names of the stages that use this app. */
  stages: string[];
}

export interface Run {
  id: string;
  routineId: string;
  routineName: string;
  routineVersion: number;
  appId: AppId;
  params: ParamValues;
  qcMode: QcMode;
  options: RunOptions;
  status: RunStatus;
  aiCalls: number;
  outputs: RunOutput[];
  startedAt: string;
  finishedAt?: string;
  /** What the run is doing right now, in plain language. */
  phase?: string;
  /** Plain-language failure message. */
  error?: string;
  errorDetail?: string;
  /** Document the routine actually ran on (the copy when running on a copy). */
  targetDocument?: { id: string; name: string };
  /** The routine edits the document, so InDesign has one "Doppl: …" undo step. */
  modifiesDocument?: boolean;
  log?: string[];
  /** Rule findings for the document, kept so retried outputs can be checked again. */
  findings?: RuleFinding[];
  /** Multi-app routines: progress per stage. */
  stages?: StageProgress[];
}

export interface StyleSource {
  id: string;
  kind: "indesign" | "figma";
  name: string;
  /** InDesign file path, or Figma file link. */
  path?: string;
  addedAt: string;
  /** Facts read from the file (styles, grid, margins…), used to build the rules. */
  facts?: { label: string; value: string }[];
  error?: string;
}

export interface StyleProfile {
  sources: StyleSource[];
  rules: { label: string; value: string }[];
}

// ---------- Creation (routine creation and repair sessions) ----------

export type CreationStageKey = "read" | "write" | "run" | "check" | "ready";
export type StageStatus = "pending" | "active" | "done" | "failed";

export interface CreationStage {
  key: CreationStageKey;
  status: StageStatus;
  detail?: string;
}

export interface ClarifyingQuestion {
  id: string;
  text: string;
  options: { id: string; label: string }[];
}

export interface RoutineDraft {
  name: string;
  description: string;
  appId: AppId;
  steps: RoutineStep[];
  params: ParamDef[];
  script: string;
  appVersion: string;
  requiredFonts: string[];
  templateId?: string;
  experimental?: boolean;
  modifiesDocument: boolean;
  qcProfile: "print" | "web";
  builtInQc?: boolean;
  keyObjects?: string[];
  stages?: Stage[];
  objectChecks?: ObjectCheckDef[];
}

/** A problem that keeps a routine from being saved (sent back to the model to fix). */
export interface ValidationError {
  /** Where, e.g. "stages[1].body.actions[3].node". */
  path: string;
  code:
    | "schema"
    | "lint"
    | "absolute-path"
    | "sample-data"
    | "unresolved-placeholder"
    | "unknown-app"
    | "stage-order"
    | "duplicate-id";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export interface PortabilityIssue {
  line: number;
  text: string;
  message: string;
}

export interface Creation {
  id: string;
  mode: "create" | "repair";
  task: Task;
  /** Repair: the routine being repaired and the run that failed. */
  routineId?: string;
  failedRunId?: string;
  status: "running" | "waiting" | "ready" | "failed" | "cancelled" | "saved";
  stages: CreationStage[];
  aiCalls: number;
  question?: ClarifyingQuestion;
  draft?: RoutineDraft;
  /** Result of the trial run, with QC. */
  outputs: RunOutput[];
  /** What the AI looked at and tried, in plain language ("Previewed Labels on item 1"). */
  activity?: string[];
  /** Trial run of a multi-app routine: progress per stage. */
  trialStages?: StageProgress[];
  error?: {
    message: string;
    detail?: string;
    kind?: "app-not-connected" | "plugin-not-connected" | "no-document" | "ai-access" | "validation" | "generic";
    /** AI error code (from the demo Worker or Meta), e.g. "quota_exhausted". */
    code?: string;
    action?: AiErrorAction;
  };
  savedRoutineId?: string;
  nextVersion?: number;
  /** Demo access: routine creations used / available on the access code. */
  quota?: { used: number; max: number };
}

export interface NewTaskInput {
  request: string;
  references: string[];
  folders?: string[];
  appId: AppId;
  documentId?: string;
  /** Multi-app tasks: every app to use, with its document. */
  apps?: TaskApp[];
}

export interface SaveRoutineInput {
  name: string;
  /** Save even if the script contains absolute paths (the routine is flagged). */
  acceptPortabilityIssues?: boolean;
}

export interface SaveRoutineResult {
  saved: boolean;
  routine?: Routine;
  issues: PortabilityIssue[];
}

export interface EnvironmentCheck {
  appStatus: AppStatus;
  currentVersion?: string;
  routineVersion: string;
  versionMismatch: boolean;
  missingFonts: string[];
}

// ---------- Settings ----------

/** Where AI requests go: the Doppl demo Worker (access code), Meta directly (own key), or a local model (later). */
export type AiProvider = "doppl-demo" | "meta-api" | "local";

export interface Settings {
  onboarded: boolean;
  aiProvider: AiProvider;
  /** Own Meta API key only: Doppl stops making AI calls once this month's estimated spend reaches it. 0 = no limit. */
  monthlySpendLimit: number;
  /** Estimated spend with the own key, per calendar month. */
  ownKeySpend: { month: string; estUsd: number };
  scriptTimeoutSec: number;
  /** Figma files connected by link. */
  figmaFiles: FigmaFile[];
  /** Pairing code the Doppl Figma plugin must send (see FigmaSetup). */
  figmaPairingCode: string;
  /** Local port the Doppl Figma plugin connects to. */
  figmaPort: number;
}

// ---------- AI access ----------

export interface DemoSession {
  label: string;
  creations: { used: number; max: number };
  samImages: { used: number; max: number };
  expiresAt: string;
  demoEnabled: boolean;
  checkedAt: string;
}

/** What the renderer may know about AI access. Codes and keys never leave the main process. */
export interface AiAccess {
  provider: AiProvider;
  model: string;
  workerUrl: string;
  encryptionAvailable: boolean;
  accessCode: { saved: boolean; hint: string | null };
  session: DemoSession | null;
  ownKey: { saved: boolean; hint: string | null };
  ownKeySpend: { month: string; estUsd: number; limit: number };
}

/** What to offer next to an AI error. */
export type AiErrorAction = "settings" | "own-key" | "retry" | "start-over";

export interface AiAccessError {
  code: string;
  message: string;
  action?: AiErrorAction;
}

export type CheckResult<T> = { ok: true; value: T } | { ok: false; error: AiAccessError };

// ---------- The API the preload exposes as window.doppel ----------

export type Unsubscribe = () => void;

export interface PickFileOptions {
  extensions?: string[];
  multiple?: boolean;
  /** Allow picking folders too (e.g. past projects). */
  allowFolders?: boolean;
}

export interface DoppelApi {
  // Apps
  listApps(): Promise<App[]>;
  checkApp(appId: AppId): Promise<App>;
  listOpenDocuments(appId: AppId): Promise<DocumentRef[]>;
  inspectDocument(appId: AppId, docId: string): Promise<DocumentSummary>;
  /** Brings the document forward in its app (Figma: the plugin, or the file link). */
  openDocument(appId: AppId, docId: string): Promise<void>;
  openAutomationSettings(): Promise<void>;

  // Figma (Connect screen)
  getFigmaSetup(): Promise<FigmaSetup>;
  /** Checks the personal access token with Figma; saves it (encrypted) only if it works. */
  saveFigmaToken(token: string): Promise<CheckResult<FigmaSetup>>;
  clearFigmaToken(): Promise<FigmaSetup>;
  /** Reads the file behind a Figma link and adds it. */
  addFigmaLink(url: string): Promise<CheckResult<FigmaSetup>>;
  removeFigmaFile(key: string): Promise<FigmaSetup>;
  /** Shows the plugin's manifest.json in Finder. */
  showFigmaPlugin(): Promise<void>;

  // Routine creation
  createRoutine(input: NewTaskInput): Promise<Creation>;
  getCreation(id: string): Promise<Creation | null>;
  answerQuestion(creationId: string, questionId: string, optionId: string): Promise<Creation>;
  cancelCreation(id: string): Promise<void>;
  retryCreation(id: string): Promise<Creation>;
  saveRoutine(creationId: string, input: SaveRoutineInput): Promise<SaveRoutineResult>;
  discardCreation(id: string): Promise<void>;
  repairRoutine(routineId: string, runId?: string): Promise<Creation>;

  // Routines
  listRoutines(): Promise<Routine[]>;
  getRoutine(id: string): Promise<Routine | null>;
  checkEnvironment(routineId: string): Promise<EnvironmentCheck>;
  /** Multi-app routines: whether every stage's app is connected with the right document. */
  checkReadiness(routineId: string, documents?: Partial<Record<AppId, string>>): Promise<ReadinessItem[]>;
  getParamOptions(routineId: string, paramKey: string, documentId?: string): Promise<ParamOption[]>;

  // Runs
  runRoutine(routineId: string, params: ParamValues, qcMode: QcMode, options: RunOptions): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  retryFailed(runId: string): Promise<Run>;
  markOutputOk(runId: string, outputId: string): Promise<Run>;
  openOutput(runId: string, outputId: string): Promise<void>;
  revealOutput(runId: string, outputId: string): Promise<void>;

  // Native pickers
  pickFiles(options?: PickFileOptions): Promise<string[]>;
  pickFolder(): Promise<string | null>;

  // Style profile
  getStyleProfile(): Promise<StyleProfile>;
  /** Pick InDesign files and read their styles (InDesign must be running). */
  addStyleSources(): Promise<StyleProfile>;
  addStyleFigmaLink(url: string): Promise<CheckResult<StyleProfile>>;
  removeStyleSource(id: string): Promise<StyleProfile>;

  // Settings
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;

  // AI access (Settings → AI access)
  getAiAccess(): Promise<AiAccess>;
  setAiProvider(provider: AiProvider): Promise<AiAccess>;
  /** Checks the code with the demo Worker; saves it (encrypted) only if it works. */
  saveAccessCode(code: string): Promise<CheckResult<AiAccess>>;
  refreshDemoSession(): Promise<CheckResult<AiAccess>>;
  clearAccessCode(): Promise<AiAccess>;
  /** Checks the key with Meta's API; saves it (encrypted) only if it works. */
  saveApiKey(key: string): Promise<CheckResult<AiAccess>>;
  clearApiKey(): Promise<AiAccess>;

  // Dev panel (hidden; Cmd+Shift+D)
  devRunFigmaActions(documentId: string, actionsJson: string, itemJson?: string): Promise<DevRunResult>;
  devRunPhotoshopScript(documentId: string | null, script: string): Promise<DevRunResult>;
  devBarcode(type: string, value: string): Promise<{ ok: boolean; value?: string; svg?: string; error?: string }>;
  devValidateRoutine(json: string): Promise<{ validation: ValidationResult; parseError?: string }>;
  devSaveRoutine(json: string): Promise<SaveRoutineResult>;
  getConnectionLog(): Promise<ConnectionLogEntry[]>;
  clearConnectionLog(): Promise<void>;

  // Events (main → renderer)
  onCreationProgress(cb: (creation: Creation) => void): Unsubscribe;
  onRunProgress(cb: (run: Run) => void): Unsubscribe;
  onAppStatusChange(cb: (apps: App[]) => void): Unsubscribe;
  onConnectionLog(cb: (entry: ConnectionLogEntry) => void): Unsubscribe;
}

/** Dev panel: result of running an action list or script once. */
export interface DevRunResult {
  ok: boolean;
  error?: string;
  /** Action results / script data, as JSON. */
  data?: unknown;
  log: string[];
  findings: RuleFinding[];
  previews: PreviewImage[];
  files: string[];
  ms: number;
}

/** Metadata about one exchange with a design app (dev panel). Never contains file contents. */
export interface ConnectionLogEntry {
  id: number;
  at: string;
  channel: "applescript" | "websocket";
  app: AppId;
  direction: "out" | "in" | "event";
  /** e.g. "probe", "run-script", "hello", "request:run-actions", "closed". */
  kind: string;
  bytes?: number;
  ms?: number;
  ok?: boolean;
  note?: string;
}

import type { BlockCandidate, HelperPins, HelperTestResult, StageBlocks } from "./blocks/types";
export type { BlockCandidate, HelperDef, HelperPins, HelperTestResult } from "./blocks/types";
import type { ContractChange, StepChange } from "../shared/routineDiff";
export type { ContractChange, StepChange };

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
  /** "tested": done with building blocks; "custom": code written for this routine. */
  kind?: "tested" | "custom";
  /** Building blocks the step uses (ids). */
  blocks?: string[];
}

/** Older routines' params (before inputs, outputs and settings); kept to read and migrate them. */
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
  /** dataFile: columns the file must have (a cell may be empty). */
  columns?: string[];
  /** folder: files are read from it ("input") or results are saved into it ("output"). */
  role?: "input" | "output";
  min?: number;
  max?: number;
}

export type ParamValue = string | number | boolean | string[] | null;
export type ParamValues = Record<string, ParamValue>;

// ---------- Routines: one app, with typed inputs and outputs ----------

/**
 * What a port carries. file / fileList take an extension list as sub-type (fileList<png> fits fileList<png|jpg>);
 * rows are tabular data (from CSV, JSON or Excel, or made by a routine); document is a document open in the
 * routine's app. Compatibility rules: electron/shared/ports.ts.
 */
export type PortType = "file" | "fileList" | "folder" | "rows" | "document" | "text" | "number" | "boolean";

/** One input or output of a routine (or a flow's input / output node). */
export interface PortDef {
  /** Identifier used in placeholders ({{inputs.<key>}}) and scripts (params.<key>). */
  key: string;
  /** Shown in the UI, e.g. "Product images". */
  label: string;
  type: PortType;
  required: boolean;
  description?: string;
  /** file, fileList: allowed extensions without dots, e.g. ["png", "jpg"]. Missing or empty: any file. */
  extensions?: string[];
  /** rows: columns the file must have (a cell may be empty; the row is made without it). */
  columns?: string[];
  /** rows: other columns the routine reads (found by Doppl in its code); matched by name like `columns`, but may be empty or missing. */
  uses?: string[];
}

/** Options that are set, not connected: export scale, quality, a naming pattern. */
export type SettingType = "text" | "number" | "boolean" | "select" | "formatList";

export interface SettingDef extends Omit<ParamDef, "type" | "extensions" | "columns" | "role"> {
  type: SettingType;
}

/** How items from two lists pair up for an iterating routine (a data row and its image). */
export type MatchRule = (
  | { by: "index" }
  /** Names match loosely (case, spaces, dashes, one-word names, suffixes; a name inside another when only one fits) unless loose is false. */
  | { by: "fileNameEqualsColumn"; column: string; ignoreExtension: boolean; loose?: boolean }
  | { by: "columnEquals"; leftColumn: string; rightColumn: string }
  /** Files with files by name (photo.jpg with photo_mask.png), loosely. */
  | { by: "sameFileName" }
) & {
  /** Items without a partner still run (without it) instead of failing. */
  optional?: boolean;
  /** Partners the designer picked by hand: an item's name (see itemName) → its partner's file or row name. They win over the rule. */
  pairs?: Record<string, string>;
};

/**
 * A value picked for an input at run time: a path (file, folder, data file, or a folder whose files make a file
 * list), several file paths, a document id, or a simple value.
 */
export type InputValue = string | string[] | number | boolean | null;

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

/** Figma routines run an action list ("actions"); InDesign and Photoshop routines run ExtendScript ("script"). */
export type StageKind = "actions" | "script";
export type StageOutputType = "fileList" | "file" | "nodeList" | "data";

export interface StageOutputDef {
  key: string;
  type: StageOutputType;
  label?: string;
  /** File outputs: the extensions the routine promises. */
  extensions?: string[];
}

/**
 * How one routine node runs in its app: what the adapters get (beginStage → runStageItem × items → endStage).
 * Built from a routine for each run; routines themselves have no stages.
 */
export interface Stage {
  id: string;
  name: string;
  appId: AppId;
  kind: StageKind;
  body: FigmaActionList | string;
  outputs: StageOutputDef[];
  /** "open": runs on a document open in the app. "none": opens its own files. */
  document?: "open" | "none";
  /** The routine changes the document it runs on (vs. only reading or exporting). */
  modifiesDocument?: boolean;
  /** The building blocks it runs with (the versions its routine pinned). */
  blocks?: StageBlocks;
  /** Figma: the page the routine was made on; runs start from it, whatever page is open. */
  page?: FigmaPageRef;
}

/** A Figma page: by id, and by name when the id is gone (the file was duplicated). */
export interface FigmaPageRef {
  id: string;
  name: string;
}

export interface RoutineVersion {
  version: number;
  createdAt: string;
  aiCalls: number;
  /** What changed, in a sentence (a refine's change summary). */
  note: string;
  /** The designer's words that asked for this version (Refine). */
  request?: string;
  /** Which model served each role while this version was made, and what it used. */
  provenance?: Provenance;
}

export interface RoleProvenance {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type Provenance = Partial<Record<AiRole, RoleProvenance>>;

export interface Routine {
  id: string;
  name: string;
  /** Exactly one app. */
  appId: AppId;
  description: string;
  steps: RoutineStep[];
  inputs: PortDef[];
  outputs: PortDef[];
  settings: SettingDef[];
  /** Run once per item of this list input (a data row or a file); outputs are collected into lists. */
  iterate?: { input: string };
  /** When the routine runs on its own: how each other list input pairs with the iterated items. In flows, the edge's rule applies. */
  matches?: Record<string, MatchRule>;
  kind: StageKind;
  /** Script routines (InDesign, Photoshop): the ExtendScript body. */
  script: string;
  /** Figma routines: the action list. */
  actions?: FigmaActionStep[];
  version: number;
  createdWithAiCalls: number;
  appVersion: string;
  requiredFonts: string[];
  runs: RunSummary[];
  createdAt: string;
  updatedAt: string;
  versions: RoutineVersion[];
  /** Whether the routine edits the document (vs. only exporting or reading it). */
  modifiesDocument: boolean;
  /** Default image-resolution profile for rule checks. */
  qcProfile: "print" | "web";
  /** The routine itself reports rule-level findings (e.g. Preflight report). */
  builtInQc?: boolean;
  /** Portability problems the user chose to accept when saving. */
  portabilityIssues?: PortabilityIssue[];
  /** Building block versions this routine runs (none: saved before blocks were pinned, runs their first versions). */
  helpers?: HelperPins;
  /** Objects that must stay fully visible in outputs (checked with SAM while creating). */
  keyObjects?: string[];
  /** Object checks with SAM that the routine defines ("Automatic check + AI review" only). */
  objectChecks?: ObjectCheckDef[];
  /** Example routine the routine was based on, if any. */
  templateId?: string;
  experimental?: boolean;
  /** Figma: the page the routine was made on (its template's page); runs copy it, whatever page is open. */
  figmaPage?: FigmaPageRef;
  /** Made by Doppl: a read-only starter routine from the app's resources. Converters are tagged "converter". */
  starter?: { tags: string[] };
  /** A copy of a starter routine (independent from later starter updates). */
  duplicatedFrom?: { routineId: string; version: number; name: string };
  /** 2: inputs, outputs and settings. Older routine files are migrated when Doppl starts. */
  format: 2;
}

/** "Check that <object> is inside <region> in this output image" (SAM, counted as AI calls). */
export interface ObjectCheckDef {
  object: string;
  region: string;
}

// ---------- Flows: routines connected in a graph ----------

export interface FlowPosition {
  x: number;
  y: number;
}

/** A flow-level input (picked when the flow runs), a routine, or an output ("Save to folder"). */
export type FlowNode =
  | { id: string; kind: "input"; port: PortDef; position: FlowPosition }
  | {
      id: string;
      kind: "routine";
      routineId: string;
      /** Routine nodes pin a version; a newer one shows "Update available". */
      routineVersion: number;
      /** Setting values for this node (defaults otherwise). */
      settings?: Record<string, ParamValue>;
      /** Values for text, number and yes/no inputs that aren't connected. */
      values?: Record<string, string | number | boolean>;
      position: FlowPosition;
    }
  | { id: string; kind: "output"; port: PortDef; position: FlowPosition };

export interface PortRef {
  nodeId: string;
  /** Routine nodes: the port key. Input and output nodes: their port's key. */
  port: string;
}

export interface FlowEdge {
  id: string;
  from: PortRef;
  to: PortRef;
  /** Joins (a second list into an iterating routine): how items pair up. */
  match?: MatchRule;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  runs: RunSummary[];
  /** AI calls used to create the flow and its routines. */
  createdWithAiCalls: number;
  /** Every app its routines use (filled in when flows are listed; not stored). */
  appIds?: AppId[];
}

/** A problem that keeps a flow from running, tied to a node or edge so the editor can highlight it. */
export interface FlowIssue {
  code:
    | "empty"
    | "cycle"
    | "missing-routine"
    | "missing-version"
    | "legacy-routine"
    | "unknown-port"
    | "incompatible"
    | "duplicate-input"
    | "needs-match"
    | "bad-match"
    | "missing-input"
    | "no-source";
  message: string;
  nodeId?: string;
  edgeId?: string;
  port?: string;
}

export interface FlowValidation {
  ok: boolean;
  issues: FlowIssue[];
}

/** What the flow editor needs besides the flow: each routine node's pinned routine, and the latest versions. */
export interface FlowContext {
  /** Per routine node id: the pinned version of its routine (missing when it doesn't exist). */
  routines: Record<string, Routine>;
  /** Per routine id: the newest version. */
  latest: Record<string, number>;
  validation: FlowValidation;
}

/** Pairs a join would make, for the edge inspector ("first 5 pairs"). */
export interface MatchPreview {
  pairs: { item: string; match: string | null; problem?: string }[];
  total: number;
  unmatched: number;
  /** Why there is nothing to preview yet, e.g. "Pick the data file in the input node first." */
  note?: string;
}

/** A converter that bridges an incompatible edge ("Insert a converter"). */
export interface ConverterOption {
  routineId: string;
  version: number;
  name: string;
  description: string;
}

/** Dev panel: the order a flow runs in, with item counts and join pairs, before running it. */
export interface ExecutionPlan {
  steps: { nodeId: string; name: string; kind: FlowNode["kind"]; appId?: AppId; items: number | null; iterates?: string; note?: string }[];
  joins: { edgeId: string; into: string; rule: MatchRule; preview: MatchPreview }[];
  issues: FlowIssue[];
}

/** The plan Doppl proposes for a request that needs several apps: single-app routines and how they connect. */
export interface FlowPlan {
  name: string;
  description: string;
  /** Flow inputs (picked at run time). */
  inputs: PortDef[];
  /** Results saved to a folder the designer picks. */
  outputs: PortDef[];
  routines: FlowPlanRoutine[];
  /** "input.<key>", "<routine id>.<port>" or "output.<key>" on each side. */
  connections: { from: string; to: string; match?: MatchRule }[];
}

export interface FlowPlanRoutine {
  id: string;
  name: string;
  appId: AppId;
  purpose: string;
  inputs: PortDef[];
  outputs: PortDef[];
  iterate?: { input: string };
}

// ---------- Runs ----------

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
  /** The routine's or flow's version. */
  routineVersion: number;
  /** In a routine's history: the flow it ran in (the summary is the flow run's). */
  inFlow?: string;
}

export interface PreviewImage {
  kind: "image";
  /** data: URL */
  src: string;
  width?: number;
  height?: number;
  label: string;
  /** The image has transparent areas, shown on a dark gray checkerboard. */
  transparent?: boolean;
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
  /** The raw error behind `error` (an app's own text), shown under "Details". */
  errorDetail?: string;
  /** Why it failed: the designer's files or data, the routine itself, or an app that wasn't ready. */
  cause?: FailureCause;
  /** File written by the routine, if any. */
  filePath?: string;
  /** Page name as shown in the app, and its 1-based position. */
  page?: string;
  pageIndex?: number;
  /** Figma node the output is (a frame the routine made). */
  nodeId?: string;
  /** The flow node (routine or output) and item that made this output. */
  node?: string;
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
  /** Doppl couldn't look (the routine closed its document first): neither a pass nor a flag. */
  skipped?: boolean;
}

export interface QcResult {
  /** "not-checked": every check was skipped. */
  status: "pass" | "flagged" | "not-checked";
  checks: QcCheck[];
}

export type RuleFindingType =
  | "overset"
  | "link-missing"
  | "link-modified"
  | "font-missing"
  /** InDesign: the font has no glyph for a letter in the text (it prints as a box or a loose accent). */
  | "glyph-missing"
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
  | "barcode-invalid"
  /** Photoshop: a cutout kept very little or nearly all of the picture, so it may have missed the subject. */
  | "cutout-suspect"
  /** The document an output came from couldn't be checked (the routine closed it first). */
  | "not-checked";

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
  /** The document picked per app (routines with a document input). */
  documents?: Partial<Record<AppId, string>>;
  qcOptions?: QcOptions;
}

/** What to run: a routine (as a one-node flow) or a flow. */
export interface RunTarget {
  kind: "routine" | "flow";
  id: string;
}

export interface RunRequest {
  /** Value per input node: paths, file lists, document ids, simple values. */
  inputs: Record<string, InputValue>;
  /** Folder per output node ("Save to folder"). For a routine on its own it's optional: files stay in the run folder. */
  outputFolders: Record<string, string>;
  /** Routine runs: setting values. */
  settings?: Record<string, ParamValue>;
  /** How lists pair, when it differs from what's saved: routine runs per input key, flow runs per connection id. */
  matches?: Record<string, MatchRule>;
  /** Per input node: columns the designer picked for ones Doppl couldn't find (expected name → the file's column). */
  columns?: Record<string, Record<string, string>>;
  qcMode: QcMode;
  options: RunOptions;
}

/**
 * What Doppl found in the picked inputs before a run: what it handled on its own, what needs the designer,
 * and what will be skipped. Nothing here stops the other items from running.
 */
export interface PreflightReport {
  fixed: PreflightNote[];
  needs: PreflightIssue[];
  skipped: PreflightNote[];
  /** Good to know, nothing to do: CMYK or very large images. */
  notes?: PreflightNote[];
  /** AI calls this check made (to match columns). */
  aiCalls?: number;
  /** Columns Doppl matched with AI, per input node (expected → the file's column): kept like picked ones. */
  columns?: Record<string, Record<string, string>>;
}

/** What the check before a run reads: the picks, and which of the picked columns Doppl matched with AI earlier. */
export type PreflightRequest = Pick<RunRequest, "inputs" | "matches" | "columns"> & { aiColumns?: Record<string, Record<string, string>> };

export interface PreflightNote {
  text: string;
  /** Technical detail, shown on request ("windows-1254"). */
  detail?: string;
  /** A column Doppl matched on its own that the designer can change. */
  change?: { inputNodeId: string; column: string; candidates: string[] };
}

export type PreflightIssue =
  /**
   * An item without a partner: pick one of the candidates (unused files, the likeliest first), or let it be skipped.
   * `files`: where each candidate file is, for its picture.
   */
  | { kind: "partner"; id: string; nodeId: string; port: string; item: string; key: string; text: string; candidates: string[]; files?: Record<string, string> }
  /** A column the routine needs that Doppl couldn't find: pick the file's column that holds it. */
  | { kind: "column"; id: string; inputNodeId: string; column: string; text: string; candidates: string[] }
  /** A file that can't be read at all. */
  | { kind: "file"; id: string; inputNodeId: string; text: string };

/**
 * After a run where items failed because of the routine, Doppl offers to fix it with AI and waits for the designer:
 * offered → (they say yes) fixing → ready (tried on the failed items and one that worked) → (they keep it) fixed: a
 * new version, and the failed items run again. Declined when they say no. The previous version stays restorable.
 */
export interface RunFix {
  status: "offered" | "fixing" | "ready" | "fixed" | "not-fixed" | "needs-review" | "declined";
  routineId: string;
  /** Offered: the most AI calls the fix may use. */
  maxCalls?: number;
  /** Flow runs: the flow and the routine node that was fixed (the flow now uses the new version). */
  flowId?: string;
  nodeId?: string;
  fromVersion: number;
  toVersion?: number;
  /** What changed, in one plain sentence. */
  summary?: string;
  aiCalls?: number;
  /** Why it wasn't fixed (not-fixed) or what needs a look (needs-review). */
  reason?: string;
  /** The refine that made the fix (ready: kept or discarded; needs-review: open it to look and save). */
  creationId?: string;
  /** The run of the failed items again, with the fixed version. */
  rerunId?: string;
}

/** Everything the Run screen asks for, for a routine or a flow. */
export interface RunSetup {
  target: RunTarget;
  name: string;
  version: number;
  /** The flow, or the routine as a one-node flow (its inputs and outputs as input and output nodes). */
  flow: Flow;
  /** Per routine node id: the routine version that runs. */
  routines: Record<string, Routine>;
  /** Routine runs: the routine's settings. */
  settings: SettingDef[];
  /** Values used last time on this Mac. */
  last: {
    inputs: Record<string, InputValue>;
    outputFolders: Record<string, string>;
    settings: Record<string, ParamValue>;
    matches: Record<string, MatchRule>;
    columns: Record<string, Record<string, string>>;
  };
  /** Problems that keep it from running (an invalid flow, a routine that no longer exists). */
  issues: FlowIssue[];
}

export type StageRunStatus = "pending" | "running" | "done" | "partial" | "failed" | "skipped" | "cancelled";

export interface StageItemProgress {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error?: string;
  errorDetail?: string;
  cause?: FailureCause;
}

/**
 * Why an item failed. "files": its files or data (no partner, an empty value, a format, a file that won't open):
 * the designer or Doppl's input handling fixes it, not the AI. "routine": the routine's own code. "app": the app
 * wasn't ready (not connected, no document).
 */
export type FailureCause = "files" | "routine" | "app";

/** Progress and result of one flow node in a run (per item for routines that iterate). */
export interface NodeProgress {
  nodeId: string;
  kind: FlowNode["kind"];
  name: string;
  appId?: AppId;
  status: StageRunStatus;
  total: number;
  done: number;
  failed: number;
  items: StageItemProgress[];
  error?: string;
  errorDetail?: string;
  /** Something to know that isn't a failure, e.g. "No folder picked: the results stay in the run folder." */
  note?: string;
  /** The document the routine ran on, e.g. "Campaign · Page 1 (Doppl copy)"; for "Save to folder", the folder. */
  documentName?: string;
}

/** What an edge carried in a run, for its label ("6 PNG"). */
export interface EdgeProgress {
  edgeId: string;
  count: number;
  label: string;
}

/** Whether a routine or flow can run: per app, connected and with the right document. */
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
  /** Names of the routines that use this app. */
  uses: string[];
}

export interface Run {
  id: string;
  target: RunTarget;
  /** The routine's or flow's name and version when it ran. */
  name: string;
  version: number;
  /** Every app the run uses. */
  appIds: AppId[];
  inputs: Record<string, InputValue>;
  outputFolders: Record<string, string>;
  /** Routine runs: setting values and how joined lists paired. */
  settings?: Record<string, ParamValue>;
  matches?: Record<string, MatchRule>;
  /** Columns picked per input node (see RunRequest). */
  columns?: Record<string, Record<string, string>>;
  /** Doppl's fix after this run, when items failed because of the routine (see RunFix). */
  fix?: RunFix;
  /** This run is the failed items of another run, again, after Doppl fixed the routine. */
  autoFixOf?: string;
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
  log?: string[];
  /** Rule findings, kept so retried outputs can be checked again. */
  findings?: RuleFinding[];
  /** Progress per flow node, in run order. */
  nodes: NodeProgress[];
  edges: EdgeProgress[];
  /** The run's working folder (userData/runs/<runId>/): each node's outputs stay there. */
  workDir?: string;
  /** Only these items ran (running failed items again). */
  onlyItems?: string[];
  /** Dev panel: every app was simulated. */
  mocked?: boolean;
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
  /** "inputs": Doppl's own question about the attached files, before the AI starts; otherwise the AI's. */
  kind?: "inputs" | "ai";
  text: string;
  /** A line under the question ("4 rows · 4 images (PNG, JPG)"). */
  detail?: string;
  /** The first option is the recommended one. */
  options: { id: string; label: string; detail?: string }[];
}

/** A routine before it is saved: what the AI proposed (or a repair), validated and tried once. */
export interface RoutineDraft {
  name: string;
  description: string;
  appId: AppId;
  steps: RoutineStep[];
  inputs: PortDef[];
  outputs: PortDef[];
  settings: SettingDef[];
  iterate?: { input: string };
  matches?: Record<string, MatchRule>;
  kind: StageKind;
  script: string;
  actions?: FigmaActionStep[];
  appVersion: string;
  requiredFonts: string[];
  templateId?: string;
  experimental?: boolean;
  modifiesDocument: boolean;
  qcProfile: "print" | "web";
  builtInQc?: boolean;
  keyObjects?: string[];
  objectChecks?: ObjectCheckDef[];
  /** Building block versions (set when it is tried, kept when it is saved). */
  helpers?: HelperPins;
  /** Figma: the page its trial started from (set when it is tried, kept when it is saved). */
  figmaPage?: FigmaPageRef;
}

/** A problem that keeps a routine from being saved (sent back to the model to fix). */
export interface ValidationError {
  /** Where, as the model wrote it, e.g. "actions[3].node" or "inputs[1].type". */
  path: string;
  code:
    | "schema"
    | "lint"
    | "absolute-path"
    | "sample-data"
    | "unresolved-placeholder"
    | "unknown-app"
    | "one-app"
    | "contract"
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

/** What Refine starts from: the change the designer asks for, screenshots, a problem output, the items to try it on. */
export interface RefineInput {
  routineId: string;
  request: string;
  /** Screenshots or images (paths) shown to the AI. */
  images: string[];
  /** An output from Results that isn't right. */
  problem?: { runId: string; outputId: string };
  /** Keys of the input items to preview the change on (up to 3). */
  testItems: string[];
  /** Started from a flow node's inspector. */
  flowLink?: { flowId: string; nodeId: string };
}

/** What the Refine screen offers: the routine, items to try the change on, and the problem output when there is one. */
export interface RefineSetup {
  routine: Routine;
  /** Input items the change can be tried on (from the problem's run, the last run, or values picked last time). */
  items: { key: string; label: string }[];
  defaultItems: string[];
  /** Where the items come from, in words. */
  itemsSource?: string;
  problem?: {
    runId: string;
    outputId: string;
    label: string;
    itemKey?: string;
    itemLabel?: string;
    /** The item it was made from: a data row or a file name. */
    input?: string;
    preview?: PreviewImage;
    qc?: QcResult;
    error?: string;
    errorDetail?: string;
  };
}

/** A refine waiting for review: what changed and what it would do to flows. */
export interface RefineReview {
  routineId: string;
  fromVersion: number;
  request: string;
  changeSummary: string;
  steps: StepChange[];
  contract: ContractChange[];
  /** Flows that use the routine and what updating them would do. */
  flows: { flowId: string; name: string; nodes: number; issues: string[] }[];
  /** The current version's results on the test items (before). */
  before: RunOutput[];
  /** The test items, in order. */
  items: { key: string; label: string }[];
  problemLabel?: string;
  /** An update to improved building blocks (no AI, so no follow-up). */
  blockUpdate?: boolean;
}

/** A building block as the dev panel lists it. */
export interface BlockInfo {
  id: string;
  app: AppId;
  set: string;
  call: string;
  summary: string;
  source: "builtin" | "promoted";
  version: number;
  versions: number[];
  tests: number;
}

/** A pinned building block with a newer version. */
export interface BlockUpdate {
  id: string;
  call: string;
  from: number;
  to: number;
  summary: string;
}

/** A flow that uses a routine: the versions its nodes pin and whether the newest one fits. */
export interface RoutineUsage {
  flowId: string;
  name: string;
  nodes: { nodeId: string; version: number }[];
  latest: number;
  /** Updating every node to the newest version keeps the flow's connections (no breaking change). */
  compatible: boolean;
  changes: ContractChange[];
}

export interface Creation {
  id: string;
  mode: "create" | "repair" | "refine";
  /** "flow": the request needs several apps, so Doppl plans a flow of single-app routines first. */
  kind: "routine" | "flow";
  task: Task;
  /** Repair: the routine being repaired and the run that failed. */
  routineId?: string;
  failedRunId?: string;
  status: "running" | "waiting" | "ready" | "failed" | "cancelled" | "saved";
  stages: CreationStage[];
  aiCalls: number;
  /** Steps of the current routine (an answer, and its code when written separately), out of 15. */
  steps?: number;
  question?: ClarifyingQuestion;
  draft?: RoutineDraft;
  /** Result of the trial run, with QC. */
  outputs: RunOutput[];
  /** What the AI looked at and tried, in plain language ("Previewed Labels on item 1"). */
  activity?: string[];
  /** Trial run on one sample item: progress per item. */
  trial?: NodeProgress;
  /** Something the designer can fix right away for creation to go on (status "waiting"). */
  needs?: {
    kind: "samples";
    message: string;
    /** The inputs that have no sample yet. */
    inputs: { key: string; label: string; type: PortType; extensions?: string[] }[];
    /** What the designer added so far (from as many places as needed), and which inputs each fills; nothing goes on until they confirm. */
    added?: { path: string; isFolder: boolean; fills: { key: string; label: string; count: number }[] }[];
  };
  /** Flow creation: the plan, shown for confirmation before anything is created. */
  plan?: FlowPlan;
  planConfirmed?: boolean;
  /** Flow creation: the routines of the plan, created one after another. */
  flowRoutines?: { id: string; name: string; appId: AppId; status: "pending" | "creating" | "saved" | "failed"; aiCalls: number; routineId?: string }[];
  savedFlowId?: string;
  /** Repair started from a flow ("Make compatible") or Refine from a flow node. */
  flowLink?: { flowId: string; nodeId: string; edgeId?: string };
  /** Refine: the change summary, step and contract diff, before results (when ready for review). */
  refine?: RefineReview;
  error?: {
    message: string;
    detail?: string;
    kind?: "app-not-connected" | "plugin-not-connected" | "no-document" | "ai-access" | "validation" | "needs-flow" | "not-a-task" | "generic";
    /** AI error code (from the demo Worker or Meta), e.g. "quota_exhausted". */
    code?: string;
    action?: AiErrorAction;
  };
  savedRoutineId?: string;
  nextVersion?: number;
  /** A failed or cancelled creation can continue where it stopped (a fresh AI budget). */
  canContinue?: boolean;
  /** Demo access: routine creations used / available on the access code. */
  quota?: { used: number; max: number };
}

export interface NewTaskInput {
  request: string;
  references: string[];
  folders?: string[];
  appId: AppId;
  documentId?: string;
  /** Every app to use, with its document. Several apps make a flow. */
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
  /** Settings → Advanced → AI models. Empty = Doppl picks the models. */
  aiModels: AiModelSettings;
  /** Dev panel: promote building blocks automatically when the rule says so (off by default). */
  autoPromoteBlocks: boolean;
}

export type AiRole = "planner" | "coder" | "reviewer" | "segmenter";
export type AiReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AiRoleBinding {
  model: string;
  reasoningEffort?: AiReasoningEffort;
}

/** A model reached through an OpenAI-compatible API at a base URL (OpenRouter, Fireworks, Ollama, LM Studio…). */
export interface AiCustomEndpoint {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  structuredOutput: boolean;
  vision: boolean;
}

export interface AiModelSettings {
  /** Per role: a model instead of Doppl's pick. */
  roleOverrides: Partial<Record<AiRole, AiRoleBinding>>;
  customEndpoints: AiCustomEndpoint[];
  /** Estimated spend per provider (other than Meta with the own key, kept in ownKeySpend) this month. */
  providerSpend: Record<string, { month: string; estUsd: number }>;
  /** Monthly limit per provider in USD (0 = none). */
  providerLimits: Record<string, number>;
}

/** A custom endpoint to add or change; "key" (when given) is stored encrypted, "" removes it. */
export type AiEndpointInput = Omit<AiCustomEndpoint, "id"> & { id?: string; key?: string };

/** Settings → Advanced → AI models, as the renderer sees it (no keys). */
export interface AiModelsInfo {
  models: {
    id: string;
    displayName: string;
    provider: string;
    location: "cloud" | "local";
    vision: boolean;
    structuredOutput: boolean;
    segmentation: boolean;
    reasoningEffort: AiReasoningEffort[];
    trainsOnData: boolean;
    experimental: boolean;
  }[];
  defaults: Record<AiRole, AiRoleBinding>;
  overrides: Partial<Record<AiRole, AiRoleBinding>>;
  customEndpoints: (AiCustomEndpoint & { key: { saved: boolean; hint: string | null } })[];
  providerSpend: { provider: string; displayName: string; month: string; estUsd: number; limit: number }[];
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
  /** One app: a routine. Several apps: a flow plan to confirm first. */
  createRoutine(input: NewTaskInput): Promise<Creation>;
  getCreation(id: string): Promise<Creation | null>;
  answerQuestion(creationId: string, questionId: string, optionId: string): Promise<Creation>;
  /** Flow creation: creates the plan's routines one after another, then saves the flow. */
  confirmPlan(creationId: string): Promise<Creation>;
  /** Sample files or folders attached while creation waits for them; it goes on without asking the AI again. */
  /** Adds sample files or folders to the list the creation waits for (see Creation.needs); confirmSamples goes on with them. */
  addSamples(creationId: string, samples: { files: string[]; folders: string[] }): Promise<Creation>;
  removeSample(creationId: string, path: string): Promise<Creation>;
  confirmSamples(creationId: string): Promise<Creation>;
  cancelCreation(id: string): Promise<void>;
  retryCreation(id: string): Promise<Creation>;
  /** Continues a failed creation where it stopped, with a fresh AI budget (one more demo creation). */
  continueCreation(id: string): Promise<Creation>;
  saveRoutine(creationId: string, input: SaveRoutineInput): Promise<SaveRoutineResult>;
  discardCreation(id: string): Promise<void>;
  repairRoutine(routineId: string, runId?: string): Promise<Creation>;
  /** Refine: what the screen offers for a routine (and a problem output from Results). */
  getRefineSetup(routineId: string, problem?: { runId: string; outputId: string }, flowLink?: { flowId: string; nodeId: string }): Promise<RefineSetup>;
  /** Refine: changes the routine as asked; saving makes a new version. */
  refineRoutine(input: RefineInput): Promise<Creation>;
  /** Refine: "Try again" with a follow-up instruction, in the same session. */
  refineFollowUp(creationId: string, instruction: string): Promise<Creation>;
  /** "Make compatible": adapts the edge's source or target routine with AI and saves it as a new version. */
  makeCompatible(flowId: string, edgeId: string, side: "source" | "target"): Promise<Creation>;

  // Routines
  /** My routines. */
  listRoutines(): Promise<Routine[]>;
  /** Starter routines made by Doppl (read-only). */
  listStarterRoutines(): Promise<Routine[]>;
  /** The newest version of a routine (mine or a starter). */
  getRoutine(id: string): Promise<Routine | null>;
  getRoutineVersion(id: string, version: number): Promise<Routine | null>;
  /** Copies a routine (a starter) into my routines; the copy is independent. */
  duplicateRoutine(id: string): Promise<Routine>;
  /** A new version with an earlier version's content (history is never rewritten). */
  restoreRoutineVersion(id: string, version: number): Promise<Routine>;
  /** Makes a flow's routine node use another version of its routine (Restore after Doppl's own fix). */
  pinFlowNodeVersion(flowId: string, nodeId: string, version: number): Promise<Flow>;
  /** Flows that use the routine, with the versions they pin. */
  getRoutineUsage(id: string): Promise<RoutineUsage[]>;
  /** Moves every flow node to the routine's newest version where that keeps the connections working. */
  updateFlowsToLatest(id: string): Promise<{ updated: string[]; skipped: { name: string; reason: string }[] }>;
  checkEnvironment(routineId: string): Promise<EnvironmentCheck>;
  getSettingOptions(routineId: string, settingKey: string, documentId?: string): Promise<ParamOption[]>;

  // Flows
  listFlows(): Promise<Flow[]>;
  getFlow(id: string): Promise<Flow | null>;
  createFlow(name: string): Promise<Flow>;
  /** Saves anytime; a flow only runs when it is valid. */
  saveFlow(flow: Flow): Promise<Flow>;
  deleteFlow(id: string): Promise<void>;
  /** Pinned routines, newest versions and validation for the editor (works on unsaved changes). */
  getFlowContext(flow: Flow): Promise<FlowContext>;
  /** The pairs a join makes; with no rule, the suggested rule and its pairs. Uses the input values picked on this Mac. */
  previewMatch(flow: Flow, edgeId: string, rule: MatchRule | null, inputs?: Record<string, InputValue>): Promise<MatchPreview & { rule: MatchRule | null }>;
  /** Starter converters that bridge an incompatible edge. */
  converterOptions(flow: Flow, edgeId: string): Promise<ConverterOption[]>;
  /** The flow with a converter placed on the edge (not saved yet). */
  insertConverter(flow: Flow, edgeId: string, routineId: string): Promise<Flow>;

  // Runs (routines and flows)
  getRunSetup(target: RunTarget): Promise<RunSetup>;
  /** Keeps values picked for inputs (in the flow editor) for the next run, on this Mac only. */
  rememberInputs(target: RunTarget, inputs: Record<string, InputValue>): Promise<void>;
  /** Whether every app the routine or flow uses is connected with the right document. */
  checkReadiness(target: RunTarget, documents?: Partial<Record<AppId, string>>): Promise<ReadinessItem[]>;
  /** Reads the picked inputs as the run would and reports what Doppl handled, what needs the designer, and what's skipped. AI only for a column no name rule can place. */
  preflightRun(target: RunTarget, request: PreflightRequest): Promise<PreflightReport>;
  /** "Let Doppl match them" (one AI call per input): files suggested for items without one, by issue id, for the designer to approve. */
  suggestPartners(target: RunTarget, request: Pick<RunRequest, "inputs" | "matches" | "columns">, ids?: string[]): Promise<Record<string, string>>;
  /** Small pictures of picked files, by path (to choose a file by its picture). */
  previewFiles(paths: string[]): Promise<Record<string, PreviewImage>>;
  startRun(target: RunTarget, request: RunRequest): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  /** A new run with only the items that failed. */
  retryFailed(runId: string): Promise<Run>;
  /** Doppl's offered fix of a run's routine: "fix" spends the AI, "keep" saves a fix that worked, "dismiss" says no. */
  answerRunFix(runId: string, answer: "fix" | "keep" | "dismiss"): Promise<void>;
  markOutputOk(runId: string, outputId: string): Promise<Run>;
  openOutput(runId: string, outputId: string): Promise<void>;
  revealOutput(runId: string, outputId: string): Promise<void>;

  // Native pickers
  pickFiles(options?: PickFileOptions): Promise<string[]>;
  pickFolder(): Promise<string | null>;

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
  /** Building blocks: the library, a routine's newer block versions, tests, and candidates (dev panel). */
  listBlocks(): Promise<BlockInfo[]>;
  getBlockUpdates(routineId: string): Promise<BlockUpdate[]>;
  /** Blocks promoted from this routine's own custom code that it doesn't use yet. */
  getAdoptableBlocks(routineId: string): Promise<{ id: string; call: string; summary: string }[]>;
  updateRoutineBlocks(routineId: string): Promise<Creation>;
  runBlockTests(ids?: string[]): Promise<HelperTestResult[]>;
  listBlockCandidates(): Promise<BlockCandidate[]>;
  generalizeBlockCandidate(id: string): Promise<BlockCandidate>;
  approveBlockCandidate(id: string): Promise<BlockCandidate>;
  dismissBlockCandidate(id: string): Promise<BlockCandidate>;
  exportBlockCandidate(id: string): Promise<{ file: string; warnings: string[] } | null>;
  /** Settings → Advanced → AI models. */
  getAiModels(): Promise<AiModelsInfo>;
  setAiRoleOverrides(overrides: Partial<Record<AiRole, AiRoleBinding | null>>): Promise<AiModelsInfo>;
  saveAiEndpoint(input: AiEndpointInput): Promise<AiModelsInfo>;
  removeAiEndpoint(id: string): Promise<AiModelsInfo>;
  setAiProviderLimit(provider: string, usd: number): Promise<AiModelsInfo>;
  testAiEndpoint(id: string): Promise<CheckResult<string>>;

  // Dev panel (hidden; Cmd+Shift+D)
  devRunFigmaActions(documentId: string, actionsJson: string, itemJson?: string): Promise<DevRunResult>;
  devRunPhotoshopScript(documentId: string | null, script: string): Promise<DevRunResult>;
  devBarcode(type: string, value: string): Promise<{ ok: boolean; value?: string; svg?: string; error?: string }>;
  devValidateRoutine(json: string): Promise<{ validation: ValidationResult; parseError?: string }>;
  devSaveRoutine(json: string): Promise<SaveRoutineResult>;
  /** Runs a flow with every app simulated (or real), with forced failures. Uses no AI. */
  devRunFlow(flowId: string, request: RunRequest, options: DevFlowOptions): Promise<Run>;
  /** The order, item counts and join pairs a flow would run with. */
  devExecutionPlan(flowId: string, inputs: Record<string, InputValue>): Promise<ExecutionPlan>;
  /** Writes one of my routines as a starter file (paths and personal data stripped). Null when cancelled. */
  devExportStarter(routineId: string, options: { converter: boolean }): Promise<{ path: string | null; removed: string[] }>;
  getConnectionLog(): Promise<ConnectionLogEntry[]>;
  devLastCreationTranscript(): Promise<CreationTranscript | null>;
  clearConnectionLog(): Promise<void>;

  // Events (main → renderer)
  onCreationProgress(cb: (creation: Creation) => void): Unsubscribe;
  onRunProgress(cb: (run: Run) => void): Unsubscribe;
  onAppStatusChange(cb: (apps: App[]) => void): Unsubscribe;
  onConnectionLog(cb: (entry: ConnectionLogEntry) => void): Unsubscribe;
}

/** Dev panel: forced failures and simulated apps for a flow run. */
export interface DevFlowOptions {
  mocked: boolean;
  /** Routine nodes that fail as a whole. */
  failNodes: string[];
  /** Per routine node: item numbers (1-based) that fail. */
  failItems: Record<string, number[]>;
}

/** Dev panel: the latest creation's exchange with the AI (kept in memory only, never saved). */
export interface CreationTranscript {
  creationId: string;
  request: string;
  at: string;
  entries: { role: "ai" | "doppl"; text: string }[];
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

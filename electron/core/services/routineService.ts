import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import type { RoutineTemplate } from "../../adapters/types";
import { layoutLeftToRight, topoOrder } from "../../shared/flowGraph";
import { compatible, describeSpec, inputSpec, isListType, outputSpec, typeTag } from "../../shared/ports";
import { DataFileError, listFolderFiles, readDataFile } from "../helpers/dataFiles";
import { suggestMatch } from "../flows/match";
import { NodeRunner, type NodeRunResult } from "../flows/nodeRunner";
import { checkReadiness } from "../flows/readiness";
import { edgeIssues, routineOf } from "../flows/validateFlow";
import { InputValueError, type PortValue, adaptValue, fileList, resolveInput } from "../flows/values";
import { type RoutineContract, type ValidationSamples, validateRoutine } from "../routines/contract";
import {
  RoutineFormatError,
  TURN_KEYS,
  errorsForModel,
  planEnd,
  planProblems,
  recoverKeys,
  routineForModel,
  toFlowPlan,
  toRoutineDraft,
} from "../routines/modelRoutine";
import type {
  AppId,
  PortDef,
  Provenance,
  RefineInput,
  RefineSetup,
  Creation,
  CreationStage,
  CreationStageKey,
  CreationTranscript,
  EnvironmentCheck,
  Flow,
  FlowEdge,
  FlowNode,
  FlowPlan,
  FlowPlanRoutine,
  InputValue,
  MatchRule,
  NewTaskInput,
  ParamOption,
  ParamValue,
  QcCheck,
  Routine,
  RoutineDraft,
  Run,
  RunOutput,
  SaveRoutineInput,
  SaveRoutineResult,
  StyleProfile,
  Task,
  TaskApp,
} from "../types";
import { CancelledError, compareVersions, errorMessage, newId, nowIso, plural } from "../util";
import type { AiAccessService } from "./aiAccessService";
import { needsCode } from "../ai/answer";
import { type Role, isModelImage } from "../ai/gateway";
import {
  PLAN_TURN_SCHEMA,
  type PromptFormat,
  type TaskFacts,
  type TurnFormat,
  codeRequestMessage,
  routineTurnSchema,
  planSystemPrompt,
  planTaskMessage,
  refineTaskMessage,
  routineSystemPrompt,
  routineTaskMessage,
} from "./aiPrompts";
import { contractChanges, diffSteps } from "../../shared/routineDiff";
import { workedExamplesText } from "./workedExamples";
import { tagSteps } from "../blocks/analysis";
import { blocks } from "../blocks/registry";
import { filePreview } from "../../adapters/previews";
import type { AiCallContext, AiService } from "./aiService";
import { AiError, type ChatMessage, type ContentPart } from "./aiTransport";
import type { AppStatusService } from "./appStatusService";
import { type FlowService, ROUTINE_NODE, inputNodeId } from "./flowService";
import type { LibraryService } from "./libraryService";
import type { QcService } from "./qcService";
import { DEFAULT_QC_OPTIONS, ExecutionError, toExecutionError } from "./runService";
import type { Storage } from "./storage";

const STAGES: CreationStageKey[] = ["read", "write", "run", "check", "ready"];

/**
 * Steps per creation (one model answer, or with code written separately, an answer and its code) and model answers
 * per routine or plan. The demo Worker also limits real calls per creation id (access.callLimit()).
 */
const MAX_CREATION_CALLS = 15;
const MAX_TURNS = 12;
const MAX_PLAN_TURNS = 6;
/** Inspect answers per routine or plan; the documents' first inspection is already in the task. */
const MAX_INSPECTIONS = 3;
/** Layers one inspect answer may look at. */
const MAX_NODES_PER_INSPECT = 8;
/** Calls kept for checking the trial result (visual review, key objects). */
const REVIEW_RESERVE = 3;
const RESULT_CHARS = 9000;
const DATA_EXTENSIONS = ["csv", "tsv", "txt", "json", "xlsx"];
const ROUTINE_ACTIONS = ["ask_question", "inspect", "preview_routine", "propose_routine"];
const REVISION_ACTIONS = ["ask_question", "decline", "inspect", "preview_routine", "propose_revision"];
/** Refine: images shown to the AI, and test items to try a change on. */
const MAX_REFINE_IMAGES = 3;
const MAX_TEST_ITEMS = 3;
const PLAN_ACTIONS = ["ask_question", "inspect", "propose_plan"];

/** AI errors where continuing can't help until the designer changes something in Settings. */
const NO_CONTINUE_CODES = new Set([
  "no_access",
  "invalid_code",
  "code_expired",
  "code_revoked",
  "quota_exhausted",
  "demo_paused",
  "own_key_invalid",
  "own_key_billing",
  "own_key_forbidden",
  "spend_limit",
]);

/**
 * How creation and refine talk to the model (evals compare them; the defaults are the current behavior):
 * - codeFormat: "separate" asks for the code in its own plain-text answer; "inline" keeps it in the JSON (as before).
 * - planField: the model writes a plan first (what, which helpers, edge cases).
 * - workedExamples: the app guides include worked examples.
 * - helperDocs: "full" catalog of helper docs, or a ranked "index" plus search_helpers / get_helper_docs.
 */
export interface CreationOptions extends TurnFormat {
  workedExamples: boolean;
  helperDocs: "full" | "index";
}

export const DEFAULT_CREATION_OPTIONS: CreationOptions = { codeFormat: "separate", planField: true, workedExamples: true, helperDocs: "index" };

/** One exchange with the model (a plan, or one routine): kept after a failure so it can continue there. */
interface LoopProgress {
  /** "plan", "routine", or "routine:<planned id>". */
  key: string;
  messages: ChatMessage[];
  asked: boolean;
  inspections: number;
  lastProblem: string;
}

/** What Doppl read for the task: documents, sample data, folders, house style. */
interface Gathered {
  facts: TaskFacts;
  samples: ValidationSamples;
  dataFiles: string[];
  versions: Record<string, string>;
}

/** A flow being created: its plan, and each planned routine once saved (with what its trial made). */
interface FlowWork {
  plan: FlowPlan;
  order: string[];
  done: Record<string, { routineId: string; version: number; values: Record<string, PortValue>; aiCalls: number }>;
}

interface CreationState {
  creation: Creation;
  cancelled: boolean;
  attempt: number;
  stage: CreationStageKey;
  answer?: (optionId: string) => void;
  confirm?: (ok: boolean) => void;
  /** Waiting for sample files the designer attaches (null: cancelled). */
  attach?: (added: { files: string[]; folders: string[] } | null) => void;
  gathered?: Gathered;
  loop?: LoopProgress;
  flow?: FlowWork;
  /** Repair, "Make compatible" and Refine: the routine as it is, the values its runs used, and what to change. */
  repair?: { routine: Routine; previous: Record<string, InputValue>; problems: string[] };
  /** Refine: what the designer asked, the images and problem shown to the AI, the items to try it on. */
  refine?: {
    input: RefineInput;
    items: Set<string>;
    itemLabels: { key: string; label: string }[];
    images: ContentPart[];
    problem?: RefineSetup["problem"];
    followUp?: string;
  };
  /** AI calls per budget (a creation id at the demo Worker). */
  calls: Map<string, number>;
  /** Model, calls and tokens per role, per budget (provenance of the versions this creation saves). */
  usage: Map<string, Provenance>;
  /** Trial folders, removed when the creation ends (a flow's trials feed the routines after them). */
  trialDirs: string[];
  /** Earlier loops of this creation (the plan, earlier routines), for the dev panel. */
  pastMessages: ChatMessage[];
}

function freshStages(): CreationStage[] {
  return STAGES.map((key) => ({ key, status: "pending" }));
}

const clip = (value: unknown, max = RESULT_CHARS) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
};

const copyItems = (n: number) => plural(n, "test item");
const withProvenance = (p: Provenance | undefined) => (p ? { provenance: p } : {});

/** Every app a task uses, with its document. */
const taskApps = (task: Task): TaskApp[] => (task.apps?.length ? task.apps : [{ appId: task.appId, documentId: task.documentId }]);

/** Every "name" in an inspection result (layer and frame names may appear in routines). */
function namesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => namesIn(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "name" || k === "fileName" || k === "pageName") && typeof v === "string") out.add(v);
      else if (out.size < 2000) namesIn(v, out);
    }
  }
  return out;
}

/** AI checks replace an existing check with the same label, or are added. */
function mergeChecks(output: RunOutput, checks: QcCheck[] | undefined) {
  if (!checks?.length) return;
  const list = [...(output.qc?.checks ?? [])];
  for (const check of checks) {
    const i = list.findIndex((c) => c.level === check.level && c.label === check.label);
    if (i >= 0) list[i] = check;
    else list.push(check);
  }
  output.qc = { status: list.every((c) => c.passed) ? "pass" : "flagged", checks: list };
}

/** A draft as a routine the runner can run (trials). */
function asRoutine(draft: RoutineDraft, id = "draft", version = 0): Routine {
  const now = nowIso();
  return { ...draft, id, version, createdWithAiCalls: 0, runs: [], createdAt: now, updatedAt: now, versions: [], format: 2 };
}

/** Where a planned routine differs from its contract in the plan (keys and types the flow relies on). */
function plannedProblems(draft: RoutineDraft, planned: FlowPlanRoutine): string[] {
  const problems: string[] = [];
  for (const p of planned.inputs) {
    const d = draft.inputs.find((x) => x.key === p.key);
    if (!d) problems.push(`inputs: keep the planned input "${p.key}" (${typeTag(inputSpec(p))}); the flow connects to it.`);
    else if (!compatible(inputSpec(p), inputSpec(d)).ok) problems.push(`inputs: "${p.key}" must take ${describeSpec(inputSpec(p))}, as planned.`);
  }
  for (const p of planned.outputs) {
    const d = draft.outputs.find((x) => x.key === p.key);
    if (!d) problems.push(`outputs: keep the planned output "${p.key}" (${typeTag(inputSpec(p))}); the flow connects to it.`);
    else if (!compatible(outputSpec(d, !!draft.iterate), outputSpec(p, !!planned.iterate)).ok) problems.push(`outputs: "${p.key}" must be ${describeSpec(outputSpec(p, !!planned.iterate))}, as planned.`);
  }
  if ((planned.iterate?.input ?? "") !== (draft.iterate?.input ?? "")) {
    problems.push(planned.iterate ? `iterate: the plan runs this routine once per item of "${planned.iterate.input}".` : "iterate: the plan runs this routine once, not per item.");
  }
  return problems;
}

/** Creation and repair of routines with the AI, flow plans, and saving. */
export class RoutineService {
  private creations = new Map<string, CreationState>();
  /** The latest creation's exchange with the AI, for the dev panel (memory only). */
  private transcript: CreationTranscript | null = null;

  constructor(
    private readonly deps: {
      storage: Storage;
      registry: AdapterRegistry;
      library: LibraryService;
      flows: FlowService;
      ai: AiService;
      access: AiAccessService;
      qc: QcService;
      getStyle: () => Promise<StyleProfile | null>;
      apps: AppStatusService;
      emit: (creation: Creation) => void;
      workRoot: string;
      /** Working InDesign routines shown to the model as examples. */
      templates: RoutineTemplate[];
      /** Evals: how creation talks to the model (default: DEFAULT_CREATION_OPTIONS). */
      options?: () => Partial<CreationOptions>;
      /** A routine was saved by a creation, refine or repair (with the version it replaced): building block candidates. */
      onSaved?: (routine: Routine, info: { request: string; trialItems: number; trialOk: number; inputs: string[] }, previous?: Routine) => void;
      /** "This isn't right" on an output of this routine. */
      onFeedback?: (routineIds: string[], kind: "notRight") => void;
    },
  ) {}

  /** What a saved routine's trial was made with, for building block candidates. */
  private savedInfo(state: CreationState) {
    const c = state.creation;
    const folders = state.gathered?.facts.folders.flatMap((f) => f.files.map((n) => path.join(f.path, n))) ?? [];
    return { request: c.task.request, trialItems: c.trial?.total ?? 0, trialOk: c.trial?.done ?? 0, inputs: [...c.task.references, ...folders].slice(0, 5) };
  }

  private options(): CreationOptions {
    return { ...DEFAULT_CREATION_OPTIONS, ...(this.deps.options?.() ?? {}) };
  }

  lastTranscript(): CreationTranscript | null {
    return this.transcript;
  }

  /** Keeps what the AI answered and what Doppl replied (not the instructions; images left out). */
  private record(state: CreationState, messages: ChatMessage[]) {
    const c = state.creation;
    const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n"));
    const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
    this.transcript = {
      creationId: c.id,
      request: c.task.request,
      at: nowIso(),
      entries: [...state.pastMessages, ...messages]
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? ("ai" as const) : ("doppl" as const), text: cap(text(m), m.role === "assistant" ? 40000 : 12000) })),
    };
  }

  // ---------- Library helpers ----------

  async checkEnvironment(routineId: string): Promise<EnvironmentCheck> {
    const routine = await this.deps.library.require(routineId);
    const adapter = this.deps.registry.get(routine.appId);
    const appStatus = await this.deps.apps.statusOf(routine.appId);
    let currentVersion: string | null = null;
    let missingFonts: string[] = [];
    if (appStatus === "connected") {
      currentVersion = await adapter.getAppVersion().catch(() => null);
      missingFonts = await adapter.missingFonts(routine.requiredFonts).catch(() => []);
    }
    const major = (v: string) => parseInt(v, 10) || 0;
    const versionMismatch =
      !!currentVersion && !!routine.appVersion && (major(currentVersion) !== major(routine.appVersion) || compareVersions(currentVersion, routine.appVersion) < 0);
    return { appStatus, currentVersion: currentVersion ?? undefined, routineVersion: routine.appVersion, versionMismatch, missingFonts };
  }

  async getSettingOptions(routineId: string, key: string, docId?: string): Promise<ParamOption[]> {
    const routine = await this.deps.library.require(routineId);
    const setting = routine.settings.find((s) => s.key === key);
    if (!setting) return [];
    if (setting.options) return setting.options;
    if (!setting.optionsSource) return [];
    const options = await this.deps.registry
      .get(routine.appId)
      .getParamOptions(setting.optionsSource, docId)
      .catch(() => []);
    if (options.length === 0 && typeof setting.default === "string") return [{ value: setting.default, label: setting.default }];
    return options;
  }

  /** The validator with this Mac's adapters. One sample data file's columns are what rows inputs must have. */
  validate(r: RoutineContract, samples?: ValidationSamples, expectedApp?: AppId, fedFromFlow: string[] = []) {
    const { registry } = this.deps;
    if (samples?.dataColumns?.length === 1) {
      const columns = samples.dataColumns[0];
      samples = { ...samples, columns: Object.fromEntries(r.inputs.filter((p) => p.type === "rows" && !fedFromFlow.includes(p.key)).map((p) => [p.key, columns])) };
    }
    return validateRoutine(
      r,
      {
        has: (appId) => registry.list().some((a) => a.id === appId),
        stageKind: (appId) => registry.get(appId).stageKind,
        lintScript: (appId, script) => registry.get(appId).lintScript?.(script) ?? [],
      },
      samples,
      expectedApp,
    );
  }

  // ---------- Creation ----------

  async create(input: NewTaskInput): Promise<Creation> {
    if (!input.request.trim()) throw new Error("Describe what the routine should do first.");
    const picked = (input.apps?.length ? input.apps : [{ appId: input.appId, documentId: input.documentId }]).filter((a) => a.appId);
    const apps = picked.filter((a, i) => picked.findIndex((b) => b.appId === a.appId) === i);
    if (apps.length === 0) throw new Error("Pick at least one app.");
    const task: Task = {
      id: newId(),
      request: input.request.trim(),
      references: input.references,
      folders: input.folders ?? [],
      appId: apps[0].appId,
      documentId: apps[0].documentId,
      apps,
      createdAt: nowIso(),
    };
    const kind = apps.length > 1 ? "flow" : "routine";
    const creation: Creation = { id: task.id, mode: "create", kind, task, status: "running", stages: freshStages(), aiCalls: 0, outputs: [] };
    const state = this.newState(creation);
    void (kind === "flow" ? this.runFlow(state) : this.runRoutine(state));
    return creation;
  }

  private newState(creation: Creation): CreationState {
    const state: CreationState = { creation, cancelled: false, attempt: 0, stage: "read", calls: new Map(), usage: new Map(), trialDirs: [], pastMessages: [] };
    this.creations.set(creation.id, state);
    return state;
  }

  /** Values a routine's earlier runs used, per input key: from a run of it, of a flow it's in, or the last ones picked. */
  private async previousInputs(routine: Routine, run: Run | null, flowId?: string, nodeId?: string): Promise<Record<string, InputValue>> {
    const out: Record<string, InputValue> = {};
    if (run?.target.kind === "routine") {
      for (const p of routine.inputs) if (run.inputs[inputNodeId(p.key)] !== undefined) out[p.key] = run.inputs[inputNodeId(p.key)];
      return out;
    }
    const flow = run?.target.kind === "flow" ? await this.deps.flows.get(run.target.id) : flowId ? await this.deps.flows.get(flowId) : null;
    const lastRun = run ?? (flow?.runs[0] ? await this.deps.storage.getRun(flow.runs[0].id) : null);
    const node = flow?.nodes.find((n) => (nodeId ? n.id === nodeId : n.kind === "routine" && n.routineId === routine.id));
    if (flow && node && lastRun) {
      for (const p of routine.inputs) {
        const edge = flow.edges.find((e) => e.to.nodeId === node.id && e.to.port === p.key);
        if (!edge) continue;
        const from = flow.nodes.find((n) => n.id === edge.from.nodeId);
        if (from?.kind === "input") out[p.key] = lastRun.inputs[from.id] ?? null;
        else {
          const files = lastRun.outputs.filter((o) => o.node === edge.from.nodeId && o.status === "done" && o.filePath).map((o) => o.filePath!);
          if (files.length) out[p.key] = p.type === "file" ? files[0] : files;
        }
      }
      return out;
    }
    const last = await this.deps.storage.getLastValues(`routine:${routine.id}`);
    for (const p of routine.inputs) if (last?.inputs[inputNodeId(p.key)] !== undefined) out[p.key] = last.inputs[inputNodeId(p.key)];
    return out;
  }

  async repair(routineId: string, runId?: string): Promise<Creation> {
    const routine = await this.deps.library.require(routineId);
    if (routine.starter) throw new Error("Starter routines can't be changed. Duplicate it into your routines first.");
    const run = runId ? await this.deps.storage.getRun(runId) : null;
    const nodeId = run?.target.kind === "routine" ? ROUTINE_NODE : run?.nodes.find((n) => n.kind === "routine" && n.name === routine.name)?.nodeId;
    const failed = (run?.outputs ?? []).filter((o) => o.status === "failed" && (!nodeId || o.node === nodeId)).slice(0, 8).map((o) => `${o.itemLabel ?? o.label}: ${o.error ?? ""}`);
    const problems = [run?.error, run?.errorDetail, ...failed].filter((x): x is string => !!x);
    if (problems.length === 0) problems.push("The designer asked for a repair; check the routine against the document and the data.");
    return this.startRepair(routine, { problems, previous: await this.previousInputs(routine, run), runId, documentId: run?.options.documents?.[routine.appId] });
  }

  private startRepair(routine: Routine, opts: { problems: string[]; previous: Record<string, InputValue>; runId?: string; documentId?: string; flowLink?: Creation["flowLink"]; request?: string }): Creation {
    const task: Task = {
      id: newId(),
      request: opts.request ?? (routine.description || routine.name),
      references: [],
      folders: [],
      appId: routine.appId,
      documentId: opts.documentId,
      apps: [{ appId: routine.appId, documentId: opts.documentId, noDocument: !routine.inputs.some((p) => p.type === "document") }],
      createdAt: nowIso(),
    };
    const creation: Creation = {
      id: task.id,
      mode: "repair",
      kind: "routine",
      task,
      routineId: routine.id,
      failedRunId: opts.runId,
      status: "running",
      stages: freshStages(),
      aiCalls: 0,
      outputs: [],
      nextVersion: routine.version + 1,
      ...(opts.flowLink ? { flowLink: opts.flowLink } : {}),
    };
    const state = this.newState(creation);
    state.repair = { routine, previous: opts.previous, problems: opts.problems };
    void this.runRoutine(state);
    return creation;
  }

  /** The run a refine looks at: the problem's run, or the routine's last run. */
  private async refineRun(routine: Routine, problem?: { runId: string; outputId: string }): Promise<Run | null> {
    if (problem) return this.deps.storage.getRun(problem.runId);
    return routine.runs[0] ? this.deps.storage.getRun(routine.runs[0].id) : null;
  }

  /** Input values for refine: from the problem's run (the node that made it, in a flow run), else the flow node or the routine's last run. */
  private async refineInputs(routine: Routine, run: Run | null, problem?: { runId: string; outputId: string }, flowLink?: { flowId: string; nodeId: string }) {
    if (problem && run) {
      const node = run.target.kind === "flow" ? run.outputs.find((o) => o.id === problem.outputId)?.node : undefined;
      return this.previousInputs(routine, run, undefined, node);
    }
    if (flowLink) return this.previousInputs(routine, null, flowLink.flowId, flowLink.nodeId);
    return this.previousInputs(routine, run);
  }

  /**
   * What the Refine screen offers: the input items the change can be tried on (from the problem's run, the last
   * run, or the values picked last time), the problem output when Refine comes from Results.
   */
  async refineSetup(routineId: string, from?: { runId: string; outputId: string }, flowLink?: { flowId: string; nodeId: string }): Promise<RefineSetup> {
    const routine = await this.deps.library.require(routineId);
    const run = await this.refineRun(routine, from);
    const previous = await this.refineInputs(routine, run, from, flowLink);
    const iterPort = routine.iterate ? routine.inputs.find((p) => p.key === routine.iterate!.input) : undefined;
    let items: RefineSetup["items"] = [];
    if (iterPort) {
      const { value } = await resolveInput(iterPort, previous[iterPort.key]).catch(() => ({ value: null }));
      if (value?.kind === "list") items = value.items.map((i) => ({ key: i.key, label: i.label }));
    } else if (Object.keys(previous).length || routine.inputs.every((p) => !p.required || p.type === "document")) {
      items = [{ key: "all", label: "The whole run" }];
    }
    let problem: RefineSetup["problem"];
    const output = from && run ? run.outputs.find((o) => o.id === from.outputId) : undefined;
    if (from && output) {
      const item = items.find((i) => i.key === output.itemKey || i.label === output.itemLabel);
      let input: string | undefined;
      if (iterPort && item) {
        const { value } = await resolveInput(iterPort, previous[iterPort.key]).catch(() => ({ value: null }));
        const raw = value?.kind === "list" ? value.items.find((i) => i.key === item.key)?.value : undefined;
        input = typeof raw === "string" ? path.basename(raw) : raw ? JSON.stringify(raw).slice(0, 400) : undefined;
      }
      problem = { runId: from.runId, outputId: output.id, label: output.label, itemKey: item?.key ?? output.itemKey, itemLabel: output.itemLabel, input, preview: output.preview, qc: output.qc, error: output.error };
    }
    const defaultItems = problem?.itemKey && items.some((i) => i.key === problem!.itemKey) ? [problem.itemKey] : items.slice(0, 1).map((i) => i.key);
    const itemsSource = !items.length ? undefined : from ? "the run with the problem" : flowLink ? "the flow's last run" : run ? "the last run" : "the values picked last time";
    return { routine, items, defaultItems, itemsSource, problem };
  }

  /** Refine: changes an existing routine as the designer asks; nothing changes until they save it as a new version. */
  async refine(input: RefineInput): Promise<Creation> {
    if (!input.request.trim()) throw new Error("Describe what should change first.");
    const routine = await this.deps.library.require(input.routineId);
    if (routine.starter) throw new Error("Starter routines can't be refined directly. Duplicate it first (Duplicate and refine).");
    if (input.problem) this.deps.onFeedback?.([routine.id], "notRight");
    const setup = await this.refineSetup(routine.id, input.problem, input.flowLink);
    const run = await this.refineRun(routine, input.problem);
    const keys = input.testItems.filter((k) => setup.items.some((i) => i.key === k)).slice(0, MAX_TEST_ITEMS);
    const images: ContentPart[] = [];
    for (const file of input.images.slice(0, MAX_REFINE_IMAGES)) {
      const preview = await filePreview(file).catch(() => undefined);
      if (preview) images.push({ type: "text", text: `Image the designer attached: ${path.basename(file)}` }, { type: "image_url", image_url: { url: preview.src, detail: "low" } });
    }
    if (setup.problem?.preview) {
      images.push({ type: "text", text: `Output that isn't right: ${setup.problem.label}${setup.problem.preview.transparent ? " (transparent areas shown on a dark gray checkerboard)" : ""}` }, { type: "image_url", image_url: { url: setup.problem.preview.src, detail: "low" } });
    }
    const task: Task = {
      id: newId(),
      request: input.request.trim(),
      references: [],
      folders: [],
      appId: routine.appId,
      documentId: run?.options.documents?.[routine.appId],
      apps: [{ appId: routine.appId, documentId: run?.options.documents?.[routine.appId], noDocument: !routine.inputs.some((p) => p.type === "document") }],
      createdAt: nowIso(),
    };
    const creation: Creation = {
      id: task.id,
      mode: "refine",
      kind: "routine",
      task,
      routineId: routine.id,
      status: "running",
      stages: freshStages(),
      aiCalls: 0,
      outputs: [],
      nextVersion: routine.version + 1,
      ...(input.flowLink ? { flowLink: input.flowLink } : {}),
    };
    const state = this.newState(creation);
    state.repair = { routine, previous: await this.refineInputs(routine, run, input.problem, input.flowLink), problems: [] };
    state.refine = {
      input,
      items: new Set(keys),
      itemLabels: setup.items.filter((i) => keys.includes(i.key)),
      images,
      problem: setup.problem,
    };
    void this.runRefine(state);
    return creation;
  }

  /**
   * "Improved building block available": the routine's test items with its building blocks as pinned (before) and
   * with their newest versions (after), shown like a refine. No AI; saving makes the next version.
   */
  async updateBlocks(routineId: string): Promise<Creation> {
    const routine = await this.deps.library.require(routineId);
    if (routine.starter) throw new Error("Starter routines can't change. Duplicate it first.");
    const updates = blocks.updates(routine.appId, routine.helpers);
    if (!updates.length) throw new Error("This routine's building blocks are up to date.");
    const setup = await this.refineSetup(routine.id);
    const run = await this.refineRun(routine);
    const keys = setup.defaultItems.length ? setup.items.slice(0, MAX_TEST_ITEMS).map((i) => i.key) : [];
    const request = `Use the improved building blocks: ${updates.map((u) => `${u.call} (version ${u.from} → ${u.to})`).join(", ")}`;
    const task: Task = {
      id: newId(),
      request,
      references: [],
      folders: [],
      appId: routine.appId,
      documentId: run?.options.documents?.[routine.appId],
      apps: [{ appId: routine.appId, documentId: run?.options.documents?.[routine.appId], noDocument: !routine.inputs.some((p) => p.type === "document") }],
      createdAt: nowIso(),
    };
    const creation: Creation = { id: task.id, mode: "refine", kind: "routine", task, routineId: routine.id, status: "running", stages: freshStages(), aiCalls: 0, outputs: [], nextVersion: routine.version + 1 };
    const state = this.newState(creation);
    state.repair = { routine, previous: await this.refineInputs(routine, run), problems: [] };
    state.refine = { input: { routineId: routine.id, request, images: [], testItems: keys }, items: new Set(keys), itemLabels: setup.items.filter((i) => keys.includes(i.key)), images: [] };
    void this.runBlockUpdate(state, updates);
    return creation;
  }

  private async runBlockUpdate(state: CreationState, updates: { id: string; call: string; from: number; to: number }[]) {
    const c = state.creation;
    const refine = state.refine!;
    const current = state.repair!.routine;
    const { ai, isCancelled } = this.aiContext(state, this.budget(state, 0));
    try {
      this.setStage(state, "read", "active", "Trying the current version on the test items");
      if (!state.gathered) state.gathered = await this.gather(c, isCancelled);
      const before = await this.trial(state, structuredClone(current), 0, { appId: current.appId }, ai, refine.items);
      if ("workDir" in before) state.trialDirs.push(before.workDir);
      const items = "res" in before ? before.res.progress.items.map((i) => ({ key: i.key, label: i.label })) : refine.itemLabels;
      c.refine = {
        routineId: current.id,
        fromVersion: current.version,
        request: c.task.request,
        changeSummary: `Uses the improved building blocks: ${updates.map((u) => `${u.call} ${u.from} → ${u.to}`).join(", ")}.`,
        steps: diffSteps(
          current.steps.map((s) => s.plainLanguage),
          current.steps.map((s) => s.plainLanguage),
        ),
        contract: [],
        flows: [],
        before: "res" in before ? before.res.outputs : [],
        items,
        blockUpdate: true,
      };
      this.setStage(state, "read", "done", `Version ${current.version} · ${copyItems(items.length)}`);
      const draft: RoutineDraft = { ...structuredClone(current), helpers: { ...current.helpers, ...Object.fromEntries(updates.map((u) => [u.id, u.to])) } };
      this.setStage(state, "run", "active", "Trying the improved building blocks");
      Object.assign(c, { outputs: [], trial: undefined });
      const after = await this.trial(state, draft, 0, { appId: current.appId }, ai, refine.items);
      if ("workDir" in after) state.trialDirs.push(after.workDir);
      this.setStage(state, "run", "done");
      c.draft = draft;
      this.setStage(state, "ready", "done");
      c.status = "ready";
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, err);
    }
  }

  /** Refine: "Try again" with a follow-up instruction; the AI keeps the session. */
  async refineFollowUp(id: string, instruction: string): Promise<Creation> {
    const state = this.requireState(id);
    const c = state.creation;
    if (c.mode !== "refine" || !state.refine || !state.loop) throw new Error("This can't be tried again here.");
    if (!["ready", "failed", "cancelled"].includes(c.status)) return c;
    state.cancelled = false;
    state.refine.followUp = instruction.trim() || "Try a different way to do the change.";
    Object.assign(c, { status: "running", error: undefined, outputs: [], trial: undefined, draft: undefined, canContinue: false });
    if (c.refine) c.refine = { ...c.refine, changeSummary: "" };
    c.stages = freshStages();
    this.emit(c);
    void this.runRefine(state, true);
    return c;
  }

  /**
   * Refine: read the documents, try the current version on the test items (the "before"), then the routine loop in
   * revision mode, then what the change does: step diff, contract changes, flows affected.
   */
  private async runRefine(state: CreationState, again = false) {
    const c = state.creation;
    const refine = state.refine!;
    const current = state.repair!.routine;
    const budget = this.budget(state, 0);
    const { ai, isCancelled } = this.aiContext(state, budget);
    try {
      this.setStage(state, "read", "active");
      await this.prepareAi(c);
      if (!state.gathered) state.gathered = await this.gather(c, isCancelled);
      if (!c.refine) {
        this.setStage(state, "read", "active", "Trying the current version on the test items");
        const before = await this.trial(state, { ...structuredClone(current), matches: current.matches }, 0, { appId: current.appId }, ai, refine.items);
        const outputs = "res" in before ? before.res.outputs : [];
        if ("workDir" in before) state.trialDirs.push(before.workDir);
        const tried = "res" in before ? before.res.progress.items.map((i) => ({ key: i.key, label: i.label })) : refine.itemLabels;
        if (!refine.items.size) for (const i of tried) refine.items.add(i.key);
        c.refine = {
          routineId: current.id,
          fromVersion: current.version,
          request: c.task.request,
          changeSummary: "",
          steps: [],
          contract: [],
          flows: [],
          before: outputs,
          items: tried,
          ...(refine.problem ? { problemLabel: refine.problem.itemLabel ?? refine.problem.label } : {}),
        };
        Object.assign(c, { outputs: [], trial: undefined });
      }
      this.setStage(state, "read", "done", again ? "Kept from before" : `Version ${current.version} · ${copyItems(c.refine.items.length)}`);
      const { draft, workDir, changeSummary } = await this.routineLoop(state, { appId: current.appId, budget, resume: again, revision: true });
      if (workDir) state.trialDirs.push(workDir);
      draft.name = current.name;
      c.draft = draft;
      c.refine = {
        ...c.refine,
        changeSummary: changeSummary || "Changed as asked.",
        steps: diffSteps(
          current.steps.map((st) => st.plainLanguage),
          draft.steps.map((st) => st.plainLanguage),
        ),
        contract: contractChanges(current, draft),
        flows: await this.deps.flows.impactOf(current.id, draft),
      };
      this.setStage(state, "ready", "done");
      c.status = "ready";
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, err);
    }
  }

  /**
   * "Make compatible": adapts the edge's source routine (its output) or target routine (its input) with the AI,
   * from the pinned version. Saving makes a new version, and the flow node pins it.
   */
  async makeCompatible(flowId: string, edgeId: string, side: "source" | "target"): Promise<Creation> {
    const flow = await this.deps.flows.require(flowId);
    const info = await this.deps.flows.routinesOf(flow);
    const edge = flow.edges.find((e) => e.id === edgeId);
    if (!edge) throw new Error("That connection isn't in the flow anymore.");
    const reason = edgeIssues(edge, flow, info).find((i) => i.code === "incompatible")?.message;
    if (!reason) throw new Error("These two already fit together.");
    const fromNode = flow.nodes.find((n) => n.id === edge.from.nodeId)!;
    const toNode = flow.nodes.find((n) => n.id === edge.to.nodeId)!;
    const node = side === "source" ? fromNode : toNode;
    if (node.kind !== "routine") throw new Error(side === "source" ? "An input node can't be changed with AI; change its type instead." : "A “Save to folder” node takes any files; change the routine before it.");
    const pinned = routineOf(info, node.id)!;
    const latest = await this.deps.library.require(pinned.id);
    if (pinned.starter) throw new Error("Starter routines can't change. Insert a converter, or duplicate the starter into your routines first.");
    const fromRoutine = fromNode.kind === "routine" ? routineOf(info, fromNode.id) : undefined;
    const toRoutine = toNode.kind === "routine" ? routineOf(info, toNode.id) : undefined;
    const fromLabel = fromNode.kind === "input" ? `the flow input “${fromNode.port.label}”` : `“${fromRoutine?.name}”`;
    const toPort = toNode.kind === "output" ? toNode.port : toRoutine?.inputs.find((p) => p.key === edge.to.port);
    const fromPort = fromNode.kind === "input" ? fromNode.port : fromRoutine?.outputs.find((p) => p.key === edge.from.port);
    const problems =
      side === "source"
        ? [
            `Make its output “${fromPort?.label ?? edge.from.port}” (key "${edge.from.port}") fit the input “${toPort?.label ?? edge.to.port}” of ${toRoutine ? `“${toRoutine.name}”` : "the next step"}: ${reason}`,
            ...(toRoutine ? [`That routine's contract: ${JSON.stringify({ inputs: toRoutine.inputs, iterate: toRoutine.iterate, outputs: toRoutine.outputs })}`] : []),
          ]
        : [
            `Make its input “${toPort?.label ?? edge.to.port}” (key "${edge.to.port}") take what ${fromLabel} gives: ${reason}`,
            ...(fromRoutine ? [`That routine's contract: ${JSON.stringify({ inputs: fromRoutine.inputs, iterate: fromRoutine.iterate, outputs: fromRoutine.outputs })}`] : []),
          ];
    problems.push("Keep every other input, output and setting as it is, so the rest of the flow keeps working.");
    const routine: Routine = { ...pinned, version: latest.version, versions: latest.versions, runs: latest.runs };
    return this.startRepair(routine, {
      problems,
      previous: await this.previousInputs(pinned, null, flowId, node.id),
      flowLink: { flowId, nodeId: node.id, edgeId },
      request: `Make “${pinned.name}” fit the flow “${flow.name}”`,
    });
  }

  getCreation(id: string): Creation | null {
    return this.creations.get(id)?.creation ?? null;
  }

  private requireState(id: string) {
    const state = this.creations.get(id);
    if (!state) throw new Error("This draft doesn't exist anymore.");
    return state;
  }

  async answer(id: string, questionId: string, optionId: string): Promise<Creation> {
    const state = this.requireState(id);
    if (state.creation.question?.id === questionId) state.answer?.(optionId);
    return state.creation;
  }

  /** Sample files attached while the creation waits for them; the trial goes on with them. */
  async addSamples(id: string, added: { files: string[]; folders: string[] }): Promise<Creation> {
    const state = this.requireState(id);
    if (!added.files.length && !added.folders.length) return state.creation;
    state.attach?.(added);
    return state.creation;
  }

  /** Flow creation: the designer confirmed the plan. */
  async confirmPlan(id: string): Promise<Creation> {
    const state = this.requireState(id);
    if (!state.creation.plan || state.creation.planConfirmed) return state.creation;
    state.confirm?.(true);
    return state.creation;
  }

  async cancel(id: string) {
    const state = this.creations.get(id);
    if (!state || ["ready", "saved", "failed"].includes(state.creation.status)) return;
    state.cancelled = true;
    state.answer?.("");
    state.confirm?.(false);
    state.attach?.(null);
    state.creation.needs = undefined;
    state.creation.status = "cancelled";
    state.creation.question = undefined;
    state.creation.canContinue = !!state.loop || (!!state.flow && !state.creation.planConfirmed);
    this.emit(state.creation);
  }

  /** Continues a failed or cancelled creation where it stopped: the model keeps what it saw and wrote, with a fresh budget. */
  async continue(id: string): Promise<Creation> {
    const state = this.requireState(id);
    const c = state.creation;
    if (!c.canContinue || (c.status !== "failed" && c.status !== "cancelled")) throw new Error("This can't continue where it stopped. Start it again instead.");
    state.cancelled = false;
    state.attempt += 1;
    state.answer?.("");
    state.attach?.(null);
    Object.assign(c, { status: "running", question: undefined, needs: undefined, error: undefined, outputs: [], trial: undefined, canContinue: false });
    if (c.kind === "routine") c.draft = undefined;
    c.stages = freshStages();
    for (const r of c.flowRoutines ?? []) if (r.status === "failed") r.status = "pending";
    this.emit(c);
    void (c.mode === "refine" ? this.runRefine(state, true) : c.kind === "flow" ? this.runFlow(state, true) : this.runRoutine(state, true));
    return c;
  }

  async retry(id: string): Promise<Creation> {
    const state = this.requireState(id);
    const c = state.creation;
    state.cancelled = false;
    state.attempt += 1;
    state.answer?.("");
    state.confirm?.(false);
    state.attach?.(null);
    state.loop = undefined;
    state.flow = undefined;
    state.gathered = undefined;
    state.pastMessages = [];
    await this.cleanTrials(state);
    Object.assign(c, {
      status: "running",
      stages: freshStages(),
      outputs: [],
      question: undefined,
      needs: undefined,
      error: undefined,
      draft: undefined,
      activity: [],
      trial: undefined,
      canContinue: false,
      plan: undefined,
      planConfirmed: undefined,
      flowRoutines: undefined,
      refine: undefined,
    });
    this.emit(c);
    void (c.mode === "refine" ? this.runRefine(state) : c.kind === "flow" ? this.runFlow(state) : this.runRoutine(state));
    return c;
  }

  async discard(id: string) {
    const state = this.creations.get(id);
    await this.cancel(id);
    if (state) await this.cleanTrials(state);
    this.creations.delete(id);
  }

  private async cleanTrials(state: CreationState) {
    for (const dir of state.trialDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** A saved routine from a draft: a new routine, or (repairs) a new version of the one being repaired. */
  async save(id: string, input: SaveRoutineInput): Promise<SaveRoutineResult> {
    const state = this.requireState(id);
    const c = state.creation;
    if (c.status !== "ready" || !c.draft) throw new Error("This routine isn't ready to save yet.");
    const draft = c.draft;
    const check = this.validate(draft, state.gathered?.samples, draft.appId);
    if (!check.ok) throw new Error(`This routine can't be saved yet: ${check.errors.slice(0, 3).map((e) => e.message).join(" ")}`);
    const name = input.name.trim() || draft.name;
    let routine: Routine;
    if (c.mode === "refine" && state.repair) {
      // Numbered after the newest version (it may have changed meanwhile); the previous one stays available.
      const latest = await this.deps.library.require(state.repair.routine.id);
      const version = latest.version + 1;
      routine = {
        ...latest,
        ...draft,
        id: latest.id,
        name: input.name.trim() || latest.name,
        version,
        createdWithAiCalls: latest.createdWithAiCalls + c.aiCalls,
        createdAt: latest.createdAt,
        updatedAt: nowIso(),
        runs: latest.runs,
        versions: [...latest.versions, { version, createdAt: nowIso(), aiCalls: c.aiCalls, note: c.refine?.changeSummary || "Refined", request: c.task.request, ...withProvenance(this.provenance(state)) }],
        portabilityIssues: undefined,
        format: 2,
      };
    } else if (c.mode === "repair" && state.repair) {
      const current = state.repair.routine;
      const version = current.version + 1;
      routine = {
        ...current,
        ...draft,
        id: current.id,
        name,
        version,
        createdWithAiCalls: current.createdWithAiCalls + c.aiCalls,
        createdAt: current.createdAt,
        updatedAt: nowIso(),
        runs: current.runs,
        versions: [...current.versions, { version, createdAt: nowIso(), aiCalls: c.aiCalls, note: c.flowLink ? "Made compatible with AI" : "Repaired with AI", ...withProvenance(this.provenance(state)) }],
        portabilityIssues: undefined,
        format: 2,
      };
    } else {
      routine = this.newRoutine(draft, name, c.aiCalls, `Created from “${c.task.request}”`, this.provenance(state));
    }
    await this.deps.library.save(routine);
    this.deps.onSaved?.(routine, this.savedInfo(state), state.repair?.routine);
    if (c.flowLink && c.mode === "repair") await this.deps.flows.pinVersion(c.flowLink.flowId, c.flowLink.nodeId, routine.version);
    // A refined copy of a starter takes the starter's place in the flow it was refined from, when it still fits.
    if (c.flowLink && c.mode === "refine" && routine.duplicatedFrom) {
      const flow = await this.deps.flows.get(c.flowLink.flowId);
      const node = flow?.nodes.find((n) => n.id === c.flowLink!.nodeId);
      if (node?.kind === "routine" && node.routineId === routine.duplicatedFrom.routineId) {
        await this.deps.flows.repointNode(c.flowLink.flowId, c.flowLink.nodeId, routine.id, routine.version).catch(() => false);
      }
    }
    c.status = "saved";
    c.savedRoutineId = routine.id;
    await this.cleanTrials(state);
    this.emit(c);
    return { saved: true, routine, issues: [] };
  }

  private newRoutine(draft: RoutineDraft, name: string, aiCalls: number, note: string, provenance?: Provenance): Routine {
    const now = nowIso();
    return {
      ...draft,
      id: newId(),
      name,
      version: 1,
      createdWithAiCalls: aiCalls,
      runs: [],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, createdAt: now, aiCalls, note, ...(provenance ? { provenance } : {}) }],
      format: 2,
    };
  }

  /**
   * Pins the building blocks a draft uses and tags its steps (tested or custom). New blocks get their newest version;
   * a refine keeps the versions the routine already ran (a routine without pins ran every block's first version).
   */
  private prepareDraft(draft: RoutineDraft, appId: AppId, previous?: Routine) {
    const newest = blocks.pinsFor(appId, draft);
    const kept = previous
      ? Object.fromEntries(Object.keys(newest).filter((id) => !previous.helpers || id in previous.helpers).map((id) => [id, previous.helpers?.[id] ?? blocks.versions(id)[0]]))
      : {};
    draft.helpers = { ...newest, ...kept };
    draft.steps = tagSteps(draft, blocks.latest(appId), Object.keys(draft.helpers)).steps;
  }

  /** Which model served each role, over the given budgets (default: all of this creation's). */
  private provenance(state: CreationState, budgets?: string[]): Provenance | undefined {
    const out: Provenance = {};
    for (const [budget, acc] of state.usage) {
      if (budgets && !budgets.includes(budget)) continue;
      for (const [role, r] of Object.entries(acc) as [Role, NonNullable<Provenance[Role]>][]) {
        const o = (out[role] ??= { model: r.model, provider: r.provider, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
        Object.assign(o, { model: r.model, provider: r.provider });
        o.calls += r.calls;
        o.inputTokens += r.inputTokens;
        o.outputTokens += r.outputTokens;
        o.costUsd = Math.round((o.costUsd + r.costUsd) * 1e6) / 1e6;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  // ---------- Pipelines ----------

  private emit(c: Creation) {
    this.deps.emit(c);
  }

  private setStage(state: CreationState, key: CreationStageKey, status: CreationStage["status"], detail?: string) {
    const c = state.creation;
    if (status === "active") state.stage = key;
    const stage = c.stages.find((s) => s.key === key)!;
    stage.status = status;
    if (detail !== undefined) stage.detail = detail;
    this.emit(c);
  }

  private note(c: Creation, text: string) {
    c.activity = [...(c.activity ?? []), text];
    this.emit(c);
  }

  private waitForAnswer(state: CreationState): Promise<string> {
    return new Promise((resolve) => {
      state.answer = (optionId) => {
        state.answer = undefined;
        resolve(optionId);
      };
    });
  }

  /** The creation id the demo Worker counts a budget by: one per routine (the plan shares the first routine's). */
  private budget(state: CreationState, part: number) {
    const base = state.attempt > 0 ? `${state.creation.id}-r${state.attempt + 1}` : state.creation.id;
    return part === 0 ? base : `${base}-${part + 1}`;
  }

  private aiContext(state: CreationState, budget: string, onCall?: () => void) {
    const attempt = state.attempt;
    const isCancelled = () => state.cancelled || state.attempt !== attempt;
    const ai: AiCallContext = {
      onAiCall: () => {
        if (isCancelled()) return;
        state.creation.aiCalls += 1;
        state.calls.set(budget, (state.calls.get(budget) ?? 0) + 1);
        onCall?.();
        this.emit(state.creation);
      },
      isCancelled,
      creationId: budget,
      onUsage: (u) => {
        const acc = state.usage.get(budget) ?? {};
        const r = (acc[u.role] ??= { model: u.model, provider: u.provider, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
        Object.assign(r, { model: u.model, provider: u.provider });
        r.calls += 1;
        r.inputTokens += u.usage?.input ?? 0;
        r.outputTokens += u.usage?.output ?? 0;
        r.costUsd = Math.round((r.costUsd + u.costUsd) * 1e6) / 1e6;
        state.usage.set(budget, acc);
      },
      onQuota: (q) => {
        state.creation.quota = q.creations;
        this.deps.access.noteQuota(q.creations, q.samImages);
        this.emit(state.creation);
      },
    };
    return { ai, isCancelled, used: () => state.calls.get(budget) ?? 0 };
  }

  /** Fails fast when AI access isn't set up, and shows the demo quota before the first call. */
  private async prepareAi(c: Creation) {
    await this.deps.access.ensureReady();
    if (this.deps.access.provider() !== "doppl-demo") return;
    const session = await this.deps.access.refreshSession();
    if (!session.ok) throw new AiError(session.error.code, session.error.message, session.error.action);
    const s = session.value.session;
    if (s && !s.demoEnabled) throw new AiError("demo_paused", "The demo is paused right now. Saved routines still rerun without AI.", "own-key");
    if (s) {
      c.quota = s.creations;
      this.emit(c);
    }
  }

  private fail(state: CreationState, err: unknown) {
    const c = state.creation;
    const appName = this.deps.registry.get(c.task.appId).name;
    const mapped = toExecutionError(err, appName);
    this.setStage(state, state.stage, "failed");
    c.status = "failed";
    c.question = undefined;
    c.error =
      mapped instanceof AiError
        ? { message: mapped.message, detail: mapped.detail, kind: "ai-access", code: mapped.code, action: mapped.action }
        : mapped instanceof ExecutionError
          ? { message: mapped.message, detail: mapped.detail, kind: mapped.kind }
          : { message: "Something went wrong.", detail: errorMessage(err), kind: "generic" };
    for (const r of c.flowRoutines ?? []) if (r.status === "creating") r.status = "failed";
    // Once the model has started, the work so far can be kept, unless AI access itself needs fixing first.
    c.canContinue = !!state.loop && !(mapped instanceof AiError && NO_CONTINUE_CODES.has(mapped.code));
    this.emit(c);
  }

  /** What the model gets to start: the apps' documents (inspected), sample data, folder file names, house style. */
  private async gather(c: Creation, isCancelled: () => boolean): Promise<Gathered> {
    const { registry } = this.deps;
    const apps = taskApps(c.task);
    const readiness = await checkReadiness(
      registry,
      this.deps.apps,
      apps.map((a) => ({ appId: a.appId, name: a.appId, needsDocument: false })),
      Object.fromEntries(apps.filter((a) => a.documentId).map((a) => [a.appId, a.documentId!])),
    );
    const documents: TaskFacts["documents"] = [];
    for (const r of readiness) {
      if (r.status !== "connected") {
        throw new ExecutionError(
          r.appId === "figma" ? "Start the Doppl plugin in your Figma file first." : (r.message ?? `${r.appName} isn't connected.`),
          undefined,
          r.appId === "figma" ? "plugin-not-connected" : "app-not-connected",
        );
      }
      const app = apps.find((a) => a.appId === r.appId);
      if (app?.noDocument) {
        // The designer chose "No document": don't read (or touch) whatever happens to be open.
        app.documentId = undefined;
        documents.push({ appId: r.appId, id: "", name: "no document", inspection: "The designer chose no document for this app: the routine has no document input and opens files from its inputs." });
        continue;
      }
      const doc = r.documents.find((d) => d.id === app?.documentId) ?? r.documents.find((d) => d.active) ?? r.documents[0];
      if (!doc) continue;
      if (isCancelled()) throw new CancelledError();
      if (app) app.documentId = doc.id;
      // Deep enough that the model rarely needs to inspect again (Figma also details the designer's selection).
      const inspection = await registry.get(r.appId).inspectForModel(doc.id, { depth: 3 }).catch((err) => ({ error: errorMessage(err) }));
      documents.push({ appId: r.appId, id: doc.id, name: doc.name, inspection });
    }
    c.task.apps = apps;

    const read = await this.readSamples(c.task);
    const versions: Record<string, string> = {};
    for (const a of apps) versions[a.appId] = (await registry.get(a.appId).getAppVersion().catch(() => null)) ?? "";
    const style = await this.deps.getStyle().catch(() => null);
    return {
      facts: { request: c.task.request, references: c.task.references, folders: read.folders, samples: read.samples, documents, style },
      samples: { values: read.values, allowed: documents.flatMap((d) => [...namesIn(d.inspection)]), dataColumns: read.dataColumns },
      dataFiles: read.dataFiles,
      versions,
    };
  }

  /** Sample data (attached, or in attached folders) and the file names of attached folders. */
  private async readSamples(task: Task) {
    const samples: TaskFacts["samples"] = [];
    const values: string[] = [];
    const dataColumns: string[][] = [];
    const dataFiles: string[] = [];
    const readSample = async (file: string, share: boolean) => {
      const table = await readDataFile(file);
      dataFiles.push(file);
      samples.push({
        file: path.basename(file),
        columns: table.columns,
        rows: share ? table.rows.slice(0, 5) : [],
        totalRows: table.rows.length,
        errors: share ? table.errors.slice(0, 5).map((e) => `Row ${e.row}: ${e.message}`) : [],
      });
      dataColumns.push(table.columns);
      for (const row of table.rows.slice(0, 200)) for (const v of Object.values(row)) if (v !== null && v !== undefined) values.push(String(v));
    };
    for (const ref of task.references) {
      const ext = path.extname(ref).slice(1).toLowerCase();
      values.push(path.basename(ref), path.basename(ref, path.extname(ref)));
      if (!DATA_EXTENSIONS.includes(ext) || (ext === "txt" && !(await this.looksTabular(ref)))) continue;
      try {
        await readSample(ref, true);
      } catch (err) {
        samples.push({ file: path.basename(ref), columns: [], rows: [], totalRows: 0, errors: [err instanceof DataFileError ? err.message : errorMessage(err)] });
      }
    }
    const folders: TaskFacts["folders"] = [];
    for (const folder of task.folders ?? []) {
      const files = await listFolderFiles(folder).catch(() => []);
      folders.push({ path: folder, files: files.map((f) => f.name) });
      for (const f of files) values.push(f.name, f.stem);
      // Data files inside a folder are sample data too. The model gets their columns and row count only:
      // from folders, only names are shared. The trial and the literal-data check use every row, on this Mac.
      for (const f of files.filter((x) => DATA_EXTENSIONS.includes(x.ext) && x.ext !== "txt")) await readSample(f.path, false).catch(() => undefined);
    }
    return { samples, values, dataColumns, dataFiles, folders };
  }

  /**
   * The trial is missing sample files: ask the designer to attach them, and wait. What they attach is added to the
   * task (as if attached in New task) and the same trial goes on, without asking the AI again. Null: cancelled.
   */
  private async waitForSamples(state: CreationState, ports: PortDef[]): Promise<boolean> {
    const c = state.creation;
    const labels = ports.map((p) => `“${p.label}”`).join(", ");
    c.needs = {
      kind: "samples",
      message: `Doppl needs sample ${labels} to try this routine. Attach them to go on; the AI's work so far is kept.`,
      inputs: ports.map((p) => ({ key: p.key, label: p.label, type: p.type, ...(p.extensions?.length ? { extensions: p.extensions } : {}) })),
    };
    c.status = "waiting";
    this.setStage(state, state.stage, "active", "Waiting for sample files");
    const added = await new Promise<{ files: string[]; folders: string[] } | null>((resolve) => (state.attach = resolve));
    state.attach = undefined;
    c.needs = undefined;
    if (!added || state.cancelled) return false;
    c.status = "running";
    const task = c.task;
    task.references = [...new Set([...task.references, ...added.files])];
    task.folders = [...new Set([...(task.folders ?? []), ...added.folders])];
    const read = await this.readSamples(task);
    const g = state.gathered!;
    state.gathered = {
      ...g,
      facts: { ...g.facts, references: task.references, folders: read.folders, samples: read.samples },
      samples: { ...g.samples, values: read.values, dataColumns: read.dataColumns },
      dataFiles: read.dataFiles,
    };
    this.note(c, `Added ${[...added.files.map((f) => path.basename(f)), ...added.folders.map((f) => `${path.basename(f)} (folder)`)].join(", ")}`);
    return true;
  }

  private async looksTabular(file: string) {
    const head = await fs.readFile(file, "utf8").then((t) => t.slice(0, 2000)).catch(() => "");
    const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 3);
    return lines.length > 1 && lines.every((l) => /[,;\t]/.test(l));
  }

  /** The InDesign example routines that fit the request best. */
  private examples(request: string): RoutineTemplate[] {
    const text = request.toLowerCase();
    return this.deps.templates
      .map((t) => ({ t, score: t.keywords.filter((k) => text.includes(k)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.t);
  }

  // ---------- One routine ----------

  /** A routine (or a repair): read, then the routine loop, then ready to save. */
  private async runRoutine(state: CreationState, resume = false) {
    const c = state.creation;
    const budget = this.budget(state, 0);
    const { isCancelled } = this.aiContext(state, budget);
    try {
      this.setStage(state, "read", "active");
      await this.prepareAi(c);
      if (!state.gathered) state.gathered = await this.gather(c, isCancelled);
      const g = state.gathered;
      this.setStage(state, "read", "done", resume ? "Kept from before" : `${plural(g.facts.documents.filter((d) => d.id).length, "document")} · ${plural(g.facts.samples.length, "data file")}`);
      const { draft, workDir } = await this.routineLoop(state, { appId: c.task.appId, budget, resume });
      state.trialDirs.push(workDir);
      c.draft = draft;
      this.setStage(state, "ready", "done");
      c.status = "ready";
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, err);
    }
  }

  /** A sample value for an input, for trials: what earlier runs used, attached data and files, the task's folders. */
  private async sampleFor(state: CreationState, port: Routine["inputs"][number]): Promise<PortValue | null> {
    const g = state.gathered!;
    const task = state.creation.task;
    const previous = state.repair?.previous[port.key];
    if (previous !== undefined && previous !== null && previous !== "") {
      const { value } = await resolveInput(port, previous).catch(() => ({ value: null }));
      if (value) return value;
    }
    const wanted = (file: string) => {
      const ext = path.extname(file).slice(1).toLowerCase();
      return port.extensions?.length ? port.extensions.includes(ext === "jpeg" ? "jpg" : ext) : !DATA_EXTENSIONS.includes(ext);
    };
    const folderFiles = async () => {
      const out: string[] = [];
      for (const f of task.folders ?? []) out.push(...(await listFolderFiles(f).catch(() => [])).map((x) => x.path));
      return out;
    };
    switch (port.type) {
      case "rows": {
        let firstProblem: string | null = null;
        for (const file of g.dataFiles) {
          try {
            const { value } = await resolveInput(port, file);
            if (value) return value;
          } catch (err) {
            firstProblem ??= errorMessage(err);
          }
        }
        if (firstProblem) throw new InputValueError(`The sample data doesn't fit "${port.key}": ${firstProblem}`);
        return null;
      }
      case "fileList": {
        const files = [...task.references.filter(wanted), ...(await folderFiles()).filter(wanted)];
        return files.length ? fileList(files) : null;
      }
      case "file": {
        const file = [...task.references, ...(await folderFiles())].find(wanted);
        return file ? { kind: "value", type: "file", value: file } : null;
      }
      case "folder": {
        const folder = task.folders?.[0] ?? (task.references[0] ? path.dirname(task.references[0]) : null);
        return folder ? { kind: "value", type: "folder", value: folder } : null;
      }
      case "text":
        return { kind: "value", type: "text", value: "sample" };
      case "number":
        return { kind: "value", type: "number", value: 1 };
      case "boolean":
        return { kind: "value", type: "boolean", value: false };
      case "document":
        return null;
    }
  }

  /**
   * Runs a draft once in scratch copies: on one sample item, with sample inputs (or, in a flow, what the routines
   * before it made in their trials). Rule-level checks run on the result (no AI).
   */
  private async trial(
    state: CreationState,
    draft: RoutineDraft,
    sampleIndex: number,
    spec: { appId: AppId; planned?: PlannedRoutine },
    ai: AiCallContext,
    /** Refine: only these input items (empty: the first one). */
    onlyItems?: Set<string>,
  ): Promise<{ res: NodeRunResult; workDir: string } | { skipped: string }> {
    const c = state.creation;
    const trialId = `trial-${c.id}-${newId().slice(0, 8)}`;
    const workDir = path.join(this.deps.workRoot, trialId);
    const docId = taskApps(c.task).find((a) => a.appId === spec.appId)?.documentId;
    let inputs: Record<string, PortValue | undefined> = {};
    for (;;) {
      inputs = {};
      const missing: PortDef[] = [];
      for (const port of draft.inputs) {
        let value: PortValue | null = null;
        if (port.type === "document") {
          if (!docId) throw new InputValueError(`The designer picked no document in ${this.deps.registry.get(spec.appId).name}, so the routine can't have a document input. Remove "${port.key}" and open files from the inputs.`);
          value = { kind: "value", type: "document", value: docId };
        } else if (spec.planned?.upstream[port.key]) {
          value = await adaptValue(spec.planned.upstream[port.key], port);
        } else {
          value = await this.sampleFor(state, port);
        }
        if (value) inputs[port.key] = value;
        else if (port.required) missing.push(port);
      }
      if (missing.length === 0) break;
      if (state.repair && !state.refine) return { skipped: `Doppl needs sample ${missing.map((m) => `“${m.label}”`).join(", ")} to try this routine. It wasn't tried.` };
      // Missing samples are quick to fix: ask for them, then go on with the same routine.
      if (!(await this.waitForSamples(state, missing))) throw new CancelledError();
    }
    // A second list pairs with the iterated items: the plan's rule, or the one that fits the samples best.
    const joins: Record<string, MatchRule> = {};
    const iterValue = draft.iterate ? inputs[draft.iterate.input] : undefined;
    for (const port of draft.inputs) {
      if (!draft.iterate || port.key === draft.iterate.input || !isListType(port.type)) continue;
      const joined = inputs[port.key];
      const planned = spec.planned?.joins[port.key];
      if (planned) joins[port.key] = planned;
      else if (iterValue?.kind === "list" && joined?.kind === "list") joins[port.key] = suggestMatch(iterValue, joined);
      else joins[port.key] = { by: "index" };
    }
    if (Object.keys(joins).length) draft.matches = joins;
    await fs.mkdir(workDir, { recursive: true });
    const adapter = this.deps.registry.get(spec.appId);
    const settings: Record<string, ParamValue> = Object.fromEntries(draft.settings.map((s) => [s.key, (s.default ?? (s.type === "boolean" ? false : null)) as ParamValue]));
    let res: NodeRunResult;
    try {
      res = await new NodeRunner(this.deps.registry).run(
        {
          runId: trialId,
          nodeId: "trial",
          name: draft.name,
          routine: asRoutine(draft),
          inputs,
          joins,
          settings,
          documentId: docId,
          target: "trial",
          workDir: path.join(workDir, "routine"),
          copiesDir: path.join(workDir, "copies"),
          allowedFolders: draft.inputs.filter((p) => p.type === "folder" && inputs[p.key]?.kind === "value").map((p) => String((inputs[p.key] as { value: unknown }).value)),
          isCancelled: ai.isCancelled,
          failed: new Map(),
          ...(onlyItems?.size ? { onlyItems } : { sampleIndex }),
        },
        {
          onProgress: (p, phase) => {
            c.trial = { ...p, items: [...p.items] };
            this.setStage(state, state.stage, "active", phase);
          },
          onOutputs: (outputs) => {
            c.outputs = [...outputs];
            this.emit(c);
          },
        },
      );
    } finally {
      await adapter.endRun?.(trialId).catch(() => undefined);
    }
    const ids = new Set(res.outputs.map((o) => o.id));
    await this.deps.qc.evaluate(adapter, { qcMode: "auto", qcOptions: DEFAULT_QC_OPTIONS, qcProfile: draft.qcProfile }, res.outputs, res.findings.filter((f) => f.outputKey && ids.has(f.outputKey)), ai);
    c.outputs = res.outputs;
    c.trial = res.progress;
    this.emit(c);
    return { res, workDir };
  }

  /** The trial result as the model sees it: per item, with errors, findings and a few previews. */
  private describeTrial(res: NodeRunResult, label: string): ContentPart[] {
    const summary = {
      status: res.progress.status,
      error: res.progress.error,
      items: res.items.map((i) => ({
        item: i.label,
        ok: i.ok,
        error: i.error,
        findings: i.findings.map((f) => `${f.type}: ${f.message}`),
        log: i.log.slice(0, 10),
        files: res.outputs.filter((o) => i.outputIds.includes(o.id) && o.filePath).map((o) => path.basename(o.filePath!)),
        result: i.data,
      })),
      skipped: res.progress.items.filter((i) => i.status === "skipped").map((i) => `${i.label}: ${i.error ?? ""}`),
      outputs: Object.fromEntries(
        Object.entries(res.values).map(([k, v]) => [k, v.kind === "list" ? v.items.map((i) => (typeof i.value === "string" && i.value.startsWith("/") ? path.basename(i.value) : i.value)) : v.value]),
      ),
    };
    const images = res.outputs.filter((o) => o.preview?.kind === "image" && isModelImage(o.preview.src)).slice(0, 2);
    return [
      { type: "text", text: `${label}\n${clip(summary)}` },
      ...images.flatMap((o): ContentPart[] => [
        { type: "text", text: `Preview of ${o.label}${o.preview!.transparent ? " (transparent areas shown on a dark gray checkerboard)" : ""}:` },
        { type: "image_url", image_url: { url: o.preview!.src, detail: "low" } },
      ]),
    ];
  }

  /**
   * The routine loop: the model works in turns, each one AI call. It can inspect the document, preview its draft
   * on one sample item, and propose the routine; Doppl validates proposals and runs a trial on the first sample
   * item, sending problems back until the routine is valid and works. Then the result gets an AI review.
   */
  private async routineLoop(
    state: CreationState,
    spec: { appId: AppId; budget: string; resume: boolean; planned?: PlannedRoutine; onCall?: () => void; revision?: boolean },
  ): Promise<{ draft: RoutineDraft; trial: NodeRunResult | null; workDir: string; changeSummary?: string }> {
    const c = state.creation;
    const g = state.gathered!;
    const { ai, isCancelled, used } = this.aiContext(state, spec.budget, spec.onCall);
    const { registry } = this.deps;
    const adapter = registry.get(spec.appId);
    const key = spec.planned ? `routine:${spec.planned.routine.id}` : "routine";
    const opts = this.options();
    const separate = opts.codeFormat === "separate" && !!this.deps.ai.writeCode;
    // With code written separately, the structured turns are the planner's and the code is the coder's.
    const turnRole: Role = separate ? "planner" : "coder";
    const first = opts.planField ? ["plan"] : [];
    const fieldKey = (f: string) => this.deps.ai.fieldKey?.(turnRole, f, first) ?? f;
    const helperTools = opts.helperDocs === "index";
    const canonical = [
      ...first,
      ...["action", "app", ...(spec.revision ? ["changeSummary"] : []), "depth", "document", ...(helperTools ? ["ids"] : []), "nodes", ...(helperTools ? ["query"] : []), "question", "reason", "routine", "sampleItemIndex"],
    ];
    const format: PromptFormat = {
      codeFormat: separate ? "separate" : "inline",
      planField: opts.planField,
      helperTools,
      fields: canonical.map(fieldKey),
      planKey: opts.planField ? fieldKey("plan") : undefined,
    };
    const turnActions = [...(spec.revision ? REVISION_ACTIONS : ROUTINE_ACTIONS), ...(helperTools ? ["get_helper_docs", "search_helpers"] : [])];
    const turnSchema = routineTurnSchema(!!spec.revision, format);
    const codeKind = adapter.stageKind === "actions" ? "actions" : "script";
    // The demo Worker counts real calls per creation id; a step with separate code makes two.
    const callCap = this.deps.access.callLimit?.();
    let p = state.loop;
    if (!p || p.key !== key || !spec.resume) {
      if (p && p.key !== key) state.pastMessages.push(...p.messages);
      const facts = { ...g.facts, documents: g.facts.documents.filter((d) => d.appId === spec.appId) };
      const current = state.repair ? { routine: routineForModel(state.repair.routine), problems: state.repair.problems } : undefined;
      const refine = spec.revision && state.refine && state.repair ? this.refineMessage(state, facts) : null;
      p = state.loop = {
        key,
        messages: [
          {
            role: "system",
            content: routineSystemPrompt(
              {
                adapter,
                manifest:
                  adapter.capabilityManifest({ helperDocs: opts.helperDocs, request: c.task.request }) +
                  (opts.workedExamples ? workedExamplesText(spec.appId, separate) : ""),
              },
              MAX_TURNS,
              spec.appId === "indesign" ? this.examples(c.task.request) : [],
              !!spec.revision,
              format,
            ),
          },
          {
            role: "user",
            content:
              refine ??
              routineTaskMessage(facts, {
                current,
                flow: spec.planned ? { plan: spec.planned.summary, routine: spec.planned.routine, upstream: spec.planned.notes } : undefined,
              }),
          },
        ],
        asked: false,
        inspections: 0,
        lastProblem: "",
      };
      spec.resume = false;
    }
    const progress = p;
    const { messages } = progress;
    const fed = spec.planned ? Object.keys(spec.planned.upstream) : [];

    this.setStage(state, "write", "active");
    let turn = 0;
    const budgetLine = () => `[${Math.max(0, MAX_TURNS - turn)} of ${MAX_TURNS} answers left]`;
    const reply = (content: string | ContentPart[]) => {
      messages.push({ role: "user", content: typeof content === "string" ? `${budgetLine()} ${content}` : [{ type: "text", text: budgetLine() }, ...content] });
      this.record(state, messages);
    };
    this.record(state, messages);
    const followUp = spec.revision ? state.refine?.followUp : undefined;
    if (followUp) {
      state.refine!.followUp = undefined;
      this.note(c, `Asked again: ${followUp.slice(0, 160)}`);
      reply(`The designer looked at your revision and wants this: "${followUp}". Change the routine accordingly (still the smallest change) and propose the revision again.`);
    } else if (spec.resume) {
      this.note(c, "Continued where it left off, with a fresh AI budget");
      reply(`Doppl continues where you left off, with a fresh budget of ${MAX_TURNS} answers.${progress.lastProblem ? ` The last problem was: ${clip(progress.lastProblem, 4000)}` : ""} Fix it and propose the complete ${spec.revision ? "revision" : "routine"}.`);
    }
    let result: { draft: RoutineDraft; res: NodeRunResult | null; workDir: string } | null = null;
    let changeSummary: string | undefined;
    // Steps: with separate code, one per answer (its code included); before, the real calls.
    const spent = () => (separate ? turn - 1 : used());
    const outOfCalls = () => !!callCap && used() >= callCap - REVIEW_RESERVE - (separate ? 1 : 0);
    for (turn = 1; !result; turn++) {
      if (isCancelled()) throw new CancelledError();
      c.steps = turn;
      if (turn > MAX_TURNS || spent() >= MAX_CREATION_CALLS - REVIEW_RESERVE || outOfCalls()) {
        throw new ExecutionError(
          `Doppl couldn't finish this routine within the AI limit for one creation (${MAX_CREATION_CALLS} calls). Try describing it in smaller steps.`,
          progress.lastProblem || undefined,
          "validation",
        );
      }
      this.setStage(state, state.stage, "active", `Step ${turn}`);
      let t: Record<string, any>;
      try {
        t = recoverKeys(
          await this.deps.ai.turn(
            messages,
            { name: spec.revision ? "doppl_revision_turn" : "doppl_routine_turn", schema: turnSchema },
            turnActions,
            ai,
            { role: turnRole, first },
          ),
          TURN_KEYS,
        );
      } catch (err) {
        // An answer that was cut off or wasn't JSON: ask for a shorter one while the budget lasts.
        const unusable = err instanceof AiError && (err.code === "ai_output_cut" || err.code === "ai_output");
        if (!unusable || turn >= MAX_TURNS || spent() >= MAX_CREATION_CALLS - REVIEW_RESERVE || outOfCalls()) throw err;
        progress.lastProblem = (err as AiError).message;
        this.note(c, (err as AiError).code === "ai_output_cut" ? "The AI's answer was too long and got cut off; asked for a shorter one" : "The AI's answer wasn't readable; asked again");
        reply("Your last answer couldn't be used: it was cut off or wasn't complete JSON. Answer again with the complete JSON, shorter: keep scripts brief, no comments, no repeated explanations.");
        continue;
      }
      messages.push({ role: "assistant", content: JSON.stringify(t) });
      this.record(state, messages);
      if (typeof t.reason === "string" && t.reason.trim()) this.note(c, t.reason.trim().slice(0, 160));

      if (t.action === "ask_question") {
        const answer = await this.askQuestion(state, progress, t, turn, !!spec.planned);
        reply(answer !== null ? `Answer: ${answer}. Continue.` : "Don't ask now. Decide yourself and continue (propose_routine).");
        continue;
      }
      if (t.action === "inspect") {
        reply(await this.inspect(state, progress, t, [spec.appId]));
        continue;
      }
      if (t.action === "search_helpers") {
        const found = blocks.search(spec.appId, String(t.query ?? ""));
        this.note(c, `Looked for building blocks: ${String(t.query ?? "").slice(0, 80)}`);
        reply(found.length ? `Building blocks for "${t.query}":\n${found.map((d) => blocks.line(d)).join("\n")}` : `No building block matches "${t.query}". Use the ones in the guide, or write the code yourself.`);
        continue;
      }
      if (t.action === "get_helper_docs") {
        const ids = Array.isArray(t.ids) ? t.ids.slice(0, 6).map(String) : [];
        reply(ids.length ? blocks.docs(ids) : 'Give the blocks\' ids in "ids".');
        continue;
      }
      if (t.action === "decline") {
        // The change needs another app: the routine stays as it is.
        throw new ExecutionError(
          `This change needs another app, so Doppl didn't put it into this routine. ${typeof t.reason === "string" && t.reason.trim() ? t.reason.trim() : ""} A routine works in one app: add a routine for the other app in a flow instead.`.replace(/\s+/g, " "),
          undefined,
          "needs-flow",
        );
      }

      // preview_routine and propose_routine (propose_revision) carry a routine; with separate code, the coder writes
      // its code now (a model that wrote it inline anyway saves the call).
      if (separate && t.routine && typeof t.routine === "object" && needsCode(t.routine, codeKind)) {
        const lang = codeKind === "actions" ? "json" : "javascript";
        messages.push({ role: "user", content: codeRequestMessage(codeKind, String(t.action)) });
        let code: string;
        try {
          code = await this.deps.ai.writeCode!(messages, lang, ai);
        } catch (err) {
          messages.pop();
          const unusable = err instanceof AiError && (err.code === "ai_output_cut" || err.code === "ai_output");
          if (!unusable || turn >= MAX_TURNS || spent() + 1 >= MAX_CREATION_CALLS - REVIEW_RESERVE || outOfCalls()) throw err;
          progress.lastProblem = (err as AiError).message;
          this.note(c, "The AI's code was too long and got cut off; asked for a shorter one");
          reply("Your code was cut off. Propose the routine again and keep its code shorter: no comments, the helpers instead of long code.");
          continue;
        }
        messages.push({ role: "assistant", content: `\`\`\`${lang}\n${code}\n\`\`\`` });
        this.record(state, messages);
        t.routine = { ...t.routine, [codeKind]: code };
        delete t.routine.body;
      }
      let draft: RoutineDraft;
      try {
        draft = toRoutineDraft(t.routine, spec.appId, adapter.stageKind, g.versions[spec.appId] ?? "");
      } catch (err) {
        const reason = err instanceof RoutineFormatError ? err.message : errorMessage(err);
        this.note(c, `The routine couldn't be read, sent back: ${reason}`);
        reply(`The routine couldn't be read: ${reason} Send the complete routine again.`);
        continue;
      }
      this.prepareDraft(draft, spec.appId, spec.revision ? state.repair?.routine : undefined);
      const proposal = t.action === "propose_routine" || t.action === "propose_revision";
      const check = this.validate(draft, proposal ? g.samples : undefined, spec.appId, fed);
      const errors = errorsForModel(check.errors, draft).map((e) => `${e.path}: ${e.message}`);
      if (spec.planned) errors.push(...plannedProblems(draft, spec.planned.routine));
      if (errors.length) {
        progress.lastProblem = errors.join(" · ");
        const shown = errors.slice(0, 2).join(" · ");
        this.note(c, `${proposal ? "Proposal" : "Preview"} had ${plural(errors.length, "problem")}, sent back to fix: ${shown.length > 240 ? `${shown.slice(0, 237)}…` : shown}`);
        reply(`Validation failed. Fix these and send the whole routine again:\n${clip(errors, 6000)}`);
        continue;
      }

      let attempt;
      const index = proposal ? 0 : Math.max(0, Math.floor(Number(t.sampleItemIndex) || 0));
      if (proposal) {
        c.draft = draft;
        this.setStage(state, "write", "done", `${plural(draft.inputs.length, "input")} · ${plural(draft.outputs.length, "output")} · ${plural(draft.settings.length, "setting")}`);
        this.setStage(state, "run", "active", "Trial on the first sample item");
      } else {
        this.note(c, `Previewed the routine on sample item ${index + 1}`);
      }
      try {
        attempt = await this.trial(state, draft, index, spec, ai, spec.revision ? state.refine?.items : undefined);
      } catch (err) {
        if (!(err instanceof InputValueError)) throw err;
        progress.lastProblem = err.message;
        this.note(c, `The samples don't fit the routine, sent back: ${err.message}`);
        if (proposal) {
          this.setStage(state, "run", "pending", "");
          this.setStage(state, "write", "active");
        }
        reply(`${err.message} Change the routine's inputs to fit and send it again.`);
        continue;
      }
      if ("skipped" in attempt) {
        if (!proposal) {
          reply(`${attempt.skipped} Propose the routine.`);
          continue;
        }
        this.note(c, attempt.skipped);
        this.setStage(state, "run", "done", "Not tried: no sample inputs");
        result = { draft, res: null, workDir: "" };
        break;
      }
      const { res, workDir } = attempt;
      if (!proposal) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        reply(this.describeTrial(res, spec.revision ? "Preview on the test items:" : `Preview on sample item ${index}:`));
        continue;
      }
      if (res.cancelled) throw new CancelledError();
      const problems = res.items.filter((i) => !i.ok);
      if (problems.length || res.progress.status === "failed") {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        progress.lastProblem = [res.progress.error, ...problems.map((i) => `${i.label}: ${i.error}`)].filter(Boolean).join(" · ") || "The trial failed.";
        this.deps.ai.noteFailedTrial?.(spec.budget);
        if (spent() >= MAX_CREATION_CALLS - REVIEW_RESERVE || turn >= MAX_TURNS || outOfCalls()) throw new ExecutionError("The trial run of the routine failed.", progress.lastProblem, "generic", true);
        this.note(c, `The trial run failed, sent back to fix: ${progress.lastProblem.length > 240 ? `${progress.lastProblem.slice(0, 237)}…` : progress.lastProblem}`);
        this.setStage(state, "run", "pending", "");
        this.setStage(state, "write", "active", "Fixing problems from the trial run");
        reply(this.describeTrial(res, "The trial run on the first sample item failed. Fix the routine and propose it again:"));
        continue;
      }
      this.setStage(state, "run", "done", `${plural(res.outputs.length, "output")} from ${spec.revision ? copyItems(res.progress.total) : "1 sample item"}`);
      result = { draft, res, workDir };
      if (typeof t.changeSummary === "string") changeSummary = t.changeSummary.trim().slice(0, 300);
    }

    this.setStage(state, "check", "active");
    if (result.res) {
      // Steps written as custom code get a closer look from the reviewer (rule checks already ran on every output).
      const customSteps = result.draft.steps.filter((s) => s.kind === "custom").map((s) => s.plainLanguage);
      const extra = await this.deps.ai.reviewTrial(c.task, { ...result.draft, customSteps }, c.outputs, ai);
      for (const output of c.outputs) mergeChecks(output, extra[output.id]);
    }
    const flagged = c.outputs.filter((o) => o.qc?.status === "flagged").length;
    this.setStage(state, "check", "done", !result.res ? "Not tried" : flagged ? `${flagged} flagged` : "All checks passed");
    return { draft: result.draft, trial: result.res, workDir: result.workDir, changeSummary };
  }

  /** The first message of a refine: the routine, the request, the problem item, attached images. */
  private refineMessage(state: CreationState, facts: TaskFacts): ContentPart[] {
    const refine = state.refine!;
    const routine = state.repair!.routine;
    const p = refine.problem;
    const text = refineTaskMessage(facts, {
      request: state.creation.task.request,
      current: routineForModel(routine),
      version: routine.version,
      history: routine.versions.map((v) => `v${v.version}: ${v.note}`),
      problem: p
        ? {
            item: p.itemLabel ?? p.label,
            input: p.input,
            output: p.label,
            checks: (p.qc?.checks ?? []).filter((ch) => !ch.passed).map((ch) => ch.reason ?? ch.label),
            error: p.error,
          }
        : undefined,
      testItems: (state.creation.refine?.items ?? refine.itemLabels).map((i) => i.label),
      attachments: refine.input.images.slice(0, MAX_REFINE_IMAGES).map((f) => path.basename(f)),
    });
    return [{ type: "text", text }, ...refine.images];
  }

  /** ask_question: only as the first answer, once, and not while a flow's routines are made. The designer's answer, or null. */
  private async askQuestion(state: CreationState, progress: LoopProgress, t: Record<string, any>, turn: number, inFlow: boolean): Promise<string | null> {
    const c = state.creation;
    const q = recoverKeys((t.question ?? {}) as Record<string, any>, ["options", "text"]);
    const options = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
    if (progress.asked || turn > 1 || inFlow || !q.text || options.length < 2) return null;
    progress.asked = true;
    c.question = { id: `q-${newId()}`, text: String(q.text), options: options.map((o: any, i: number) => ({ id: String(o?.id ?? i), label: String(o?.label ?? o?.id ?? o) })) };
    c.status = "waiting";
    this.emit(c);
    const optionId = await this.waitForAnswer(state);
    if (state.cancelled) throw new CancelledError();
    const label = c.question.options.find((o) => o.id === optionId)?.label ?? optionId;
    c.question = undefined;
    c.status = "running";
    this.note(c, `Answer: ${label}`);
    return label;
  }

  /** inspect: a deeper look at a document of one of the apps. Returns the reply for the model. */
  private async inspect(state: CreationState, progress: LoopProgress, t: Record<string, any>, apps: AppId[]): Promise<string> {
    const c = state.creation;
    const appId = String(t.app ?? apps[0]);
    const doc = taskApps(c.task).find((a) => a.appId === appId);
    if (!apps.includes(appId) || !(t.document || doc?.documentId)) return `Can't inspect: app must be ${apps.join(" or ")} with an open document.`;
    if (++progress.inspections > MAX_INSPECTIONS) return `You've used your ${MAX_INSPECTIONS} inspections. Propose now with what you know.`;
    const nodes: (string | undefined)[] = Array.isArray(t.nodes) && t.nodes.length ? t.nodes.slice(0, MAX_NODES_PER_INSPECT).map(String) : [undefined];
    const depth = Number.isFinite(Number(t.depth)) ? Number(t.depth) : undefined;
    this.note(c, `Looked at ${this.deps.registry.get(appId).name}${nodes[0] ? ` · ${nodes.join(", ")}` : ""}`);
    const results: Record<string, unknown> = {};
    for (const node of nodes) {
      results[node ?? "document"] = await this.deps.registry
        .get(appId)
        .inspectForModel(String(t.document || doc!.documentId), { node, depth })
        .catch((err) => ({ error: errorMessage(err) }));
    }
    return `Inspection of ${appId} (${progress.inspections} of ${MAX_INSPECTIONS} inspections used): ${clip(results, 14000)}`;
  }

  // ---------- Flows: a plan, then each routine ----------

  /** Several apps: plan the flow, wait for the designer's go, create each routine in order, then save the flow. */
  private async runFlow(state: CreationState, resume = false) {
    const c = state.creation;
    const { isCancelled } = this.aiContext(state, this.budget(state, 0));
    try {
      this.setStage(state, "read", "active");
      await this.prepareAi(c);
      if (!state.gathered) state.gathered = await this.gather(c, isCancelled);
      this.setStage(state, "read", "done", resume ? "Kept from before" : `${plural(state.gathered.facts.documents.filter((d) => d.id).length, "document")} · ${plural(state.gathered.facts.samples.length, "data file")}`);

      if (!state.flow) {
        const plan = await this.planLoop(state, resume);
        resume = false;
        const { order } = topoOrder(
          plan.routines.map((r) => r.id),
          plan.connections.flatMap((x) => {
            const from = planEnd(x.from);
            const to = planEnd(x.to);
            return from?.kind === "routine" && to?.kind === "routine" ? [{ from: { nodeId: from.id }, to: { nodeId: to.id } }] : [];
          }),
        );
        state.flow = { plan, order, done: {} };
        c.plan = plan;
        c.flowRoutines = order.map((id) => {
          const r = plan.routines.find((x) => x.id === id)!;
          return { id, name: r.name, appId: r.appId, status: "pending", aiCalls: 0 };
        });
        state.pastMessages.push(...(state.loop?.messages ?? []));
        state.loop = undefined;
      }
      const work = state.flow;
      if (!c.planConfirmed) {
        c.status = "waiting";
        this.emit(c);
        const ok = await new Promise<boolean>((resolve) => (state.confirm = resolve));
        state.confirm = undefined;
        if (!ok || isCancelled()) throw new CancelledError();
        c.planConfirmed = true;
        c.status = "running";
        this.emit(c);
      }

      for (const [i, id] of work.order.entries()) {
        if (work.done[id]) continue;
        const planned = work.plan.routines.find((r) => r.id === id)!;
        const entry = c.flowRoutines!.find((r) => r.id === id)!;
        entry.status = "creating";
        if (!resume) {
          c.stages = freshStages();
          this.setStage(state, "read", "done", `${planned.name} · ${this.deps.registry.get(planned.appId).name}`);
        }
        Object.assign(c, { outputs: [], trial: undefined, draft: undefined });
        this.emit(c);
        const before = c.aiCalls;
        const { draft, trial } = await this.routineLoop(state, {
          appId: planned.appId,
          budget: this.budget(state, i),
          resume: resume && state.loop?.key === `routine:${id}`,
          planned: this.plannedContext(work, planned),
          onCall: () => (entry.aiCalls += 1),
        });
        resume = false;
        const routine = this.newRoutine(
          { ...draft, name: planned.name },
          planned.name,
          c.aiCalls - before,
          `Created as part of the flow “${work.plan.name}” from “${c.task.request}”`,
          this.provenance(state, [this.budget(state, i)]),
        );
        await this.deps.library.save(routine);
        this.deps.onSaved?.(routine, this.savedInfo(state));
        work.done[id] = { routineId: routine.id, version: routine.version, values: trial?.values ?? {}, aiCalls: c.aiCalls - before };
        entry.status = "saved";
        entry.routineId = routine.id;
        this.note(c, `Saved the routine “${routine.name}”`);
        state.pastMessages.push(...(state.loop?.messages ?? []));
        state.loop = undefined;
      }

      const flow = this.assembleFlow(work, c.aiCalls);
      const saved = await this.deps.flows.save(flow);
      c.savedFlowId = saved.id;
      this.setStage(state, "ready", "done", `${plural(work.order.length, "routine")} · ${plural(c.aiCalls, "AI call")}`);
      c.status = "saved";
      await this.cleanTrials(state);
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, err);
    }
  }

  /** A planned routine's place in the flow: the plan in a sentence, the trial values its inputs get, and its joins. */
  private plannedContext(work: FlowWork, routine: FlowPlanRoutine): PlannedRoutine {
    const upstream: Record<string, PortValue> = {};
    const joins: Record<string, MatchRule> = {};
    const notes: string[] = [];
    for (const conn of work.plan.connections) {
      const to = planEnd(conn.to);
      const from = planEnd(conn.from);
      if (!to || !from || to.kind !== "routine" || to.id !== routine.id) continue;
      if (conn.match) joins[to.port] = conn.match;
      if (from.kind === "routine") {
        const value = work.done[from.id]?.values[from.port];
        const source = work.plan.routines.find((r) => r.id === from.id);
        if (value) upstream[to.port] = value;
        const names = value?.kind === "list" ? value.items.slice(0, 5).map((i) => i.label).join(", ") : "";
        notes.push(`Input "${to.port}" comes from "${source?.name ?? from.id}" (its output "${from.port}")${names ? `; in its trial it made: ${names}` : ""}.`);
      } else {
        notes.push(`Input "${to.port}" is the flow input "${from.port}" the designer picks at run time.`);
      }
    }
    const summary = `"${work.plan.name}": ${work.plan.routines.map((r) => `${r.id} (${r.appId}: ${r.purpose})`).join(" → ")}.`;
    return { routine, summary, upstream, joins, notes };
  }

  /** The flow from a confirmed plan and its saved routines, laid out left to right. */
  private assembleFlow(work: FlowWork, aiCalls: number): Flow {
    const { plan } = work;
    const nodeOf = (ref: string) => {
      const end = planEnd(ref)!;
      if (end.kind === "input") return { nodeId: `input-${end.port}`, port: end.port };
      if (end.kind === "output") return { nodeId: `output-${end.port}`, port: end.port };
      return { nodeId: `node-${end.id}`, port: end.port };
    };
    const nodes: FlowNode[] = [
      ...plan.inputs.map((port): FlowNode => ({ id: `input-${port.key}`, kind: "input", port, position: { x: 0, y: 0 } })),
      ...work.order.map((id): FlowNode => ({ id: `node-${id}`, kind: "routine", routineId: work.done[id].routineId, routineVersion: work.done[id].version, position: { x: 0, y: 0 } })),
      ...plan.outputs.map((port): FlowNode => ({ id: `output-${port.key}`, kind: "output", port, position: { x: 0, y: 0 } })),
    ];
    const edges: FlowEdge[] = plan.connections
      .filter((x) => planEnd(x.from) && planEnd(x.to))
      .map((x) => ({ id: newId(), from: nodeOf(x.from), to: nodeOf(x.to), ...(x.match ? { match: x.match } : {}) }));
    const positions = layoutLeftToRight(
      nodes.map((n) => n.id),
      edges,
    );
    for (const n of nodes) n.position = positions.get(n.id)!;
    const now = nowIso();
    return { id: newId(), name: plan.name, description: plan.description, version: 1, createdAt: now, updatedAt: now, nodes, edges, runs: [], createdWithAiCalls: aiCalls };
  }

  /** The plan loop: inspect, then propose_plan until the plan connects. Budget shared with the first routine. */
  private async planLoop(state: CreationState, resume: boolean): Promise<FlowPlan> {
    const c = state.creation;
    const g = state.gathered!;
    const apps = taskApps(c.task).map((a) => a.appId);
    const { ai, isCancelled, used } = this.aiContext(state, this.budget(state, 0));
    let p = state.loop;
    if (!p || p.key !== "plan" || !resume) {
      p = state.loop = {
        key: "plan",
        messages: [
          { role: "system", content: planSystemPrompt(apps, MAX_PLAN_TURNS) },
          { role: "user", content: planTaskMessage(g.facts) },
        ],
        asked: false,
        inspections: 0,
        lastProblem: "",
      };
      resume = false;
    }
    const progress = p;
    const { messages } = progress;
    this.setStage(state, "write", "active", "Planning the flow");
    let turn = 0;
    const reply = (content: string) => {
      messages.push({ role: "user", content: `[${Math.max(0, MAX_PLAN_TURNS - turn)} of ${MAX_PLAN_TURNS} answers left] ${content}` });
      this.record(state, messages);
    };
    this.record(state, messages);
    if (resume) reply(`Doppl continues where you left off.${progress.lastProblem ? ` The last problem was: ${clip(progress.lastProblem, 4000)}` : ""} Propose the complete plan.`);
    for (turn = 1; ; turn++) {
      if (isCancelled()) throw new CancelledError();
      if (turn > MAX_PLAN_TURNS || used() >= MAX_CREATION_CALLS - REVIEW_RESERVE) {
        throw new ExecutionError("Doppl couldn't plan this flow within the AI limit. Try describing it in smaller steps.", progress.lastProblem || undefined, "validation");
      }
      this.setStage(state, "write", "active", `Planning · step ${turn}`);
      let t: Record<string, any>;
      try {
        t = recoverKeys(await this.deps.ai.turn(messages, { name: "doppl_plan_turn", schema: PLAN_TURN_SCHEMA }, PLAN_ACTIONS, ai), TURN_KEYS);
      } catch (err) {
        const unusable = err instanceof AiError && (err.code === "ai_output_cut" || err.code === "ai_output");
        if (!unusable || turn >= MAX_PLAN_TURNS) throw err;
        progress.lastProblem = (err as AiError).message;
        reply("Your last answer couldn't be used: it was cut off or wasn't complete JSON. Answer again, shorter.");
        continue;
      }
      messages.push({ role: "assistant", content: JSON.stringify(t) });
      this.record(state, messages);
      if (typeof t.reason === "string" && t.reason.trim()) this.note(c, t.reason.trim().slice(0, 160));
      if (t.action === "ask_question") {
        const answer = await this.askQuestion(state, progress, t, turn, false);
        reply(answer !== null ? `Answer: ${answer}. Continue.` : "Don't ask now. Decide yourself and propose the plan.");
        continue;
      }
      if (t.action === "inspect") {
        reply(await this.inspect(state, progress, t, apps));
        continue;
      }
      let plan: FlowPlan;
      try {
        plan = toFlowPlan(t.plan);
      } catch (err) {
        const reason = err instanceof RoutineFormatError ? err.message : errorMessage(err);
        progress.lastProblem = reason;
        this.note(c, `The plan couldn't be read, sent back: ${reason}`);
        reply(`The plan couldn't be read: ${reason} Send the complete plan again.`);
        continue;
      }
      const problems = planProblems(plan, apps);
      if (problems.length) {
        progress.lastProblem = problems.join(" · ");
        this.note(c, `The plan had ${plural(problems.length, "problem")}, sent back to fix: ${problems[0].slice(0, 200)}`);
        reply(`The plan doesn't connect yet. Fix these and send the whole plan again:\n${clip(problems, 6000)}`);
        continue;
      }
      this.setStage(state, "write", "done", `Plan: ${plural(plan.routines.length, "routine")}`);
      return plan;
    }
  }
}

/** A planned routine's place in a flow being created. */
interface PlannedRoutine {
  routine: FlowPlanRoutine;
  summary: string;
  /** Per input key: what the routines before it made in their trials. */
  upstream: Record<string, PortValue>;
  joins: Record<string, MatchRule>;
  notes: string[];
}

import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import type {
  AppId,
  Creation,
  CreationStage,
  CreationStageKey,
  DocumentSummary,
  ParamDef,
  Stage,
  StyleProfile,
  TaskApp,
  ValidationError,
  EnvironmentCheck,
  NewTaskInput,
  ParamOption,
  ParamValues,
  QcCheck,
  Routine,
  RoutineDraft,
  RunOutput,
  SaveRoutineInput,
  SaveRoutineResult,
  Task,
} from "../types";
import { CancelledError, compareVersions, errorMessage, newId, nowIso, plural } from "../util";
import type { AiAccessService } from "./aiAccessService";
import type { AiCallContext, AiService } from "./aiService";
import { AiError } from "./aiTransport";
import type { AppStatusService } from "./appStatusService";
import { findPortabilityIssues } from "./portability";
import { DEFAULT_QC_OPTIONS, ExecutionError, type RoutineExecutor, folderParams, toExecutionError } from "./runService";
import type { Storage } from "./storage";
import { DataFileError, listFolderFiles, readDataFile } from "../helpers/dataFiles";
import { stageSystemPrompt, stageTaskMessage, type StageTaskFacts } from "./aiPrompts";
import { AiOutputError, toStagedDraft } from "./modelAiService";
import type { ChatMessage, ContentPart } from "./aiTransport";
import type { QcService } from "./qcService";
import { checkReadiness } from "../stages/readiness";
import type { StageRunResult, StageRunner } from "../stages/stageRunner";
import { type ValidationSamples, validateRoutine } from "../stages/validator";

const STAGES: CreationStageKey[] = ["read", "write", "run", "check", "ready"];

const SAMPLE_TEXT = Array.from(
  { length: 14 },
  (_, i) =>
    `Sample paragraph ${i + 1}. Doppl placed this text during a trial run to check that the routine flows copy into your template, adds pages when the text is longer than the frame, and keeps your paragraph styles. Nothing here is saved to your document.`,
).join("\n\n");

interface CreationState {
  creation: Creation;
  cancelled: boolean;
  attempt: number;
  answer?: (optionId: string) => void;
  /** Multi-app creation: sample values for the validator (literal-data check). */
  samples?: ValidationSamples;
}

function freshStages(): CreationStage[] {
  return STAGES.map((key) => ({ key, status: "pending" }));
}

function describe(summary: DocumentSummary): string {
  if (summary.frames?.length) return `${summary.ref.name} · ${plural(summary.frames.length, "frame")}`;
  return [
    summary.ref.name,
    plural(summary.pageCount, "page"),
    plural(summary.paragraphStyles.length, "paragraph style"),
    plural(summary.layers.length, "layer"),
  ].join(" · ");
}

const major = (v: string) => parseInt(v, 10) || 0;

/** Model fix attempts per creation (after the lint or a failed trial run). */
const MAX_FIXES = 2;

/** Multi-app creation: AI calls per creation (the demo Worker's limit) and model turns in the tool loop. */
const MAX_CREATION_CALLS = 15;
const MAX_TURNS = 12;
/** Inspect answers per creation; the documents' first inspection is already in the task. */
const MAX_INSPECTIONS = 3;
/** Layers one inspect answer may look at. */
const MAX_NODES_PER_INSPECT = 8;
/** Calls kept for checking the trial result (visual review, key objects). */
const REVIEW_RESERVE = 3;
const RESULT_CHARS = 9000;
const DATA_EXTENSIONS = ["csv", "tsv", "txt", "json", "xlsx"];

const clip = (value: unknown, max = RESULT_CHARS) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
};

/** Every app a task uses, with its document. */
const taskApps = (task: Task): TaskApp[] => (task.apps?.length ? task.apps : [{ appId: task.appId, documentId: task.documentId }]);

/**
 * InDesign-only tasks on an open document keep the single-script flow; anything with Figma, Photoshop, several
 * apps, or no document (stages that open their own files) uses stages.
 */
const usesStages = (task: Task) => {
  const apps = taskApps(task);
  return apps.length > 1 || apps.some((a) => a.appId !== "indesign" || a.noDocument);
};

/**
 * Validation errors in the shape the model writes routines in: a stage's "actions" or "script", not Doppl's
 * internal "body". (Doppl's paths made the model move its actions to "body.actions", where they weren't read.)
 */
export function errorsForModel(errors: ValidationError[], draft: RoutineDraft): ValidationError[] {
  return errors.map((e) => {
    const m = e.path.match(/^stages\[(\d+)\]\.body(.*)$/);
    if (!m) return e;
    const stage = draft.stages?.[Number(m[1])];
    if (stage?.kind !== "actions") return { ...e, path: `stages[${m[1]}].script${m[2]}` };
    const path = `stages[${m[1]}].actions${m[2].replace(/^\.actions/, "")}`;
    if (m[2] === ".actions" && /too small|>=\s*1/i.test(e.message)) {
      return {
        ...e,
        path,
        message: `Stage "${stage.id}" (${stage.appId}) has no actions. Put its action list in the stage's "actions" array, e.g. "actions": [{ "action": "duplicateNode", "id": "label", "node": "Label" }, …].`,
      };
    }
    return { ...e, path };
  });
}

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

/** Library (list/get), routine creation and repair with the AI, saving with portability checks. */
export class RoutineService {
  private creations = new Map<string, CreationState>();

  constructor(
    private readonly deps: {
      storage: Storage;
      registry: AdapterRegistry;
      ai: AiService;
      access: AiAccessService;
      executor: RoutineExecutor;
      stageRunner: StageRunner;
      qc: QcService;
      getStyle: () => Promise<StyleProfile | null>;
      apps: AppStatusService;
      emit: (creation: Creation) => void;
      workRoot: string;
    },
  ) {}

  // ---------- Library ----------

  async list(): Promise<Routine[]> {
    const routines = await this.deps.storage.listRoutines();
    return routines.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string) {
    return this.deps.storage.getRoutine(id);
  }

  private async requireRoutine(id: string) {
    const routine = await this.deps.storage.getRoutine(id);
    if (!routine) throw new Error("This routine doesn't exist anymore.");
    return routine;
  }

  async checkEnvironment(routineId: string): Promise<EnvironmentCheck> {
    const routine = await this.requireRoutine(routineId);
    const adapter = this.deps.registry.get(routine.appId);
    const appStatus = await this.deps.apps.statusOf(routine.appId);
    let currentVersion: string | null = null;
    let missingFonts: string[] = [];
    if (appStatus === "connected") {
      currentVersion = await adapter.getAppVersion().catch(() => null);
      missingFonts = await adapter.missingFonts(routine.requiredFonts).catch(() => []);
    }
    const versionMismatch =
      !!currentVersion &&
      !!routine.appVersion &&
      (major(currentVersion) !== major(routine.appVersion) || compareVersions(currentVersion, routine.appVersion) < 0);
    return { appStatus, currentVersion: currentVersion ?? undefined, routineVersion: routine.appVersion, versionMismatch, missingFonts };
  }

  async getParamOptions(routineId: string, key: string, docId?: string): Promise<ParamOption[]> {
    const routine = await this.requireRoutine(routineId);
    const param = routine.params.find((p) => p.key === key);
    if (!param) return [];
    if (param.options) return param.options;
    if (!param.optionsSource) return [];
    const options = await this.deps.registry
      .get(routine.appId)
      .getParamOptions(param.optionsSource, docId)
      .catch(() => []);
    if (options.length === 0 && typeof param.default === "string") return [{ value: param.default, label: param.default }];
    return options;
  }

  // ---------- Creation ----------

  async create(input: NewTaskInput): Promise<Creation> {
    if (!input.request.trim()) throw new Error("Describe what the routine should do first.");
    const apps = input.apps?.filter((a) => a.appId) ?? [];
    const task: Task = {
      id: newId(),
      request: input.request.trim(),
      references: input.references,
      folders: input.folders ?? [],
      appId: apps[0]?.appId ?? input.appId,
      documentId: apps[0]?.documentId ?? input.documentId,
      apps: apps.length ? apps : undefined,
      createdAt: nowIso(),
    };
    const creation: Creation = { id: task.id, mode: "create", task, status: "running", stages: freshStages(), aiCalls: 0, outputs: [] };
    const state: CreationState = { creation, cancelled: false, attempt: 0 };
    this.creations.set(creation.id, state);
    void (usesStages(task) ? this.runStaged(state) : this.runCreate(state));
    return creation;
  }

  async repair(routineId: string, runId?: string): Promise<Creation> {
    const routine = await this.requireRoutine(routineId);
    const run = runId ? await this.deps.storage.getRun(runId) : null;
    const stagedApps = routine.stages?.length ? [...new Set(routine.stages.map((s) => s.appId))] : [];
    const task: Task = {
      id: newId(),
      request: routine.stages?.length ? routine.description || routine.name : `Repair "${routine.name}"`,
      references: [],
      appId: routine.appId,
      documentId: run?.options.documentId,
      apps: stagedApps.length ? stagedApps.map((appId) => ({ appId, documentId: run?.options.documents?.[appId] })) : undefined,
      createdAt: nowIso(),
    };
    const creation: Creation = {
      id: task.id,
      mode: "repair",
      task,
      routineId,
      failedRunId: runId,
      status: "running",
      stages: freshStages(),
      aiCalls: 0,
      outputs: [],
      nextVersion: routine.version + 1,
    };
    const state: CreationState = { creation, cancelled: false, attempt: 0 };
    this.creations.set(creation.id, state);
    void (routine.stages?.length ? this.runStaged(state) : this.runRepair(state));
    return creation;
  }

  getCreation(id: string): Creation | null {
    return this.creations.get(id)?.creation ?? null;
  }

  private requireState(id: string) {
    const state = this.creations.get(id);
    if (!state) throw new Error("This routine draft doesn't exist anymore.");
    return state;
  }

  async answer(id: string, questionId: string, optionId: string): Promise<Creation> {
    const state = this.requireState(id);
    if (state.creation.question?.id === questionId) state.answer?.(optionId);
    return state.creation;
  }

  async cancel(id: string) {
    const state = this.creations.get(id);
    if (!state || ["ready", "saved", "failed"].includes(state.creation.status)) return;
    state.cancelled = true;
    state.answer?.("");
    state.creation.status = "cancelled";
    state.creation.question = undefined;
    this.emit(state.creation);
  }

  async retry(id: string): Promise<Creation> {
    const state = this.requireState(id);
    const c = state.creation;
    state.cancelled = false;
    state.attempt += 1;
    state.answer?.("");
    Object.assign(c, { status: "running", stages: freshStages(), outputs: [], question: undefined, error: undefined, draft: undefined, activity: [], trialStages: undefined });
    this.emit(c);
    const staged = usesStages(c.task) || !!(c.mode === "repair" && (await this.deps.storage.getRoutine(c.routineId!))?.stages?.length);
    void (staged ? this.runStaged(state) : c.mode === "repair" ? this.runRepair(state) : this.runCreate(state));
    return c;
  }

  async discard(id: string) {
    await this.cancel(id);
    this.creations.delete(id);
  }

  async save(id: string, input: SaveRoutineInput): Promise<SaveRoutineResult> {
    const { storage } = this.deps;
    const state = this.requireState(id);
    const c = state.creation;
    if (c.status !== "ready" || !c.draft) throw new Error("This routine isn't ready to save yet.");
    const draft = c.draft;
    if (draft.stages?.length) {
      const check = this.validate(draft, state.samples);
      if (!check.ok) throw new Error(`This routine can't be saved yet: ${check.errors.slice(0, 3).map((e) => e.message).join(" ")}`);
    }
    const issues = draft.stages?.length ? [] : findPortabilityIssues(draft.script);
    if (issues.length && !input.acceptPortabilityIssues) return { saved: false, issues };
    const name = input.name.trim() || draft.name;
    const now = nowIso();

    let routine: Routine;
    if (c.mode === "repair") {
      routine = await this.requireRoutine(c.routineId!);
      const version = routine.version + 1;
      Object.assign(routine, {
        name,
        description: draft.description,
        steps: draft.steps,
        params: draft.params,
        script: draft.script,
        appVersion: draft.appVersion,
        requiredFonts: draft.requiredFonts,
        version,
        createdWithAiCalls: routine.createdWithAiCalls + c.aiCalls,
        updatedAt: now,
        portabilityIssues: issues.length ? issues : undefined,
        keyObjects: draft.keyObjects,
        stages: draft.stages,
        objectChecks: draft.objectChecks,
        qcProfile: draft.qcProfile,
      });
      routine.versions = [...routine.versions, { version, createdAt: now, aiCalls: c.aiCalls, note: "Repaired with AI" }];
    } else {
      routine = {
        id: newId(),
        name,
        appId: draft.appId,
        description: draft.description,
        steps: draft.steps,
        params: draft.params,
        script: draft.script,
        version: 1,
        createdWithAiCalls: c.aiCalls,
        appVersion: draft.appVersion,
        requiredFonts: draft.requiredFonts,
        runs: [],
        createdAt: now,
        updatedAt: now,
        versions: [{ version: 1, createdAt: now, aiCalls: c.aiCalls, note: `Created from “${c.task.request}”` }],
        templateId: draft.templateId,
        experimental: draft.experimental,
        modifiesDocument: draft.modifiesDocument,
        qcProfile: draft.qcProfile,
        builtInQc: draft.builtInQc,
        portabilityIssues: issues.length ? issues : undefined,
        keyObjects: draft.keyObjects,
        stages: draft.stages,
        objectChecks: draft.objectChecks,
      };
    }
    await storage.saveRoutine(routine);
    c.status = "saved";
    c.savedRoutineId = routine.id;
    this.emit(c);
    return { saved: true, routine, issues };
  }

  // ---------- Pipelines ----------

  private emit(c: Creation) {
    this.deps.emit(c);
  }

  private setStage(c: Creation, key: CreationStageKey, status: CreationStage["status"], detail?: string) {
    const stage = c.stages.find((s) => s.key === key)!;
    stage.status = status;
    if (detail !== undefined) stage.detail = detail;
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

  private context(state: CreationState) {
    const attempt = state.attempt;
    const isCancelled = () => state.cancelled || state.attempt !== attempt;
    const ai: AiCallContext = {
      onAiCall: () => {
        if (isCancelled()) return;
        state.creation.aiCalls += 1;
        this.emit(state.creation);
      },
      isCancelled,
      // Retries of the same creation keep its id; a repair is a new creation with its own id.
      // Each attempt has its own call budget at the demo service ("Try again" starts a new creation there).
      creationId: state.attempt > 0 ? `${state.creation.id}-r${state.attempt + 1}` : state.creation.id,
      onQuota: (q) => {
        state.creation.quota = q.creations;
        this.deps.access.noteQuota(q.creations, q.samImages);
        this.emit(state.creation);
      },
    };
    return { isCancelled, ai, attempt };
  }

  /** Fails fast when AI access isn't set up, and shows the demo quota before the first call. */
  private async prepareAi(c: Creation) {
    await this.deps.access.transport();
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

  /** Problems that must be fixed before a draft runs: unsafe or unsupported script code, fixed file locations. */
  private lintDraft(draft: RoutineDraft) {
    const adapter = this.deps.registry.get(draft.appId);
    return {
      blocking: adapter.lintScript?.(draft.script) ?? [],
      portability: findPortabilityIssues(draft.script).map((i) => `Line ${i.line}: ${i.message} (${i.text})`),
    };
  }

  /**
   * Lint → trial run, sending problems back to the model to fix (up to MAX_FIXES times).
   */
  private async buildAndTrial(
    state: CreationState,
    summary: DocumentSummary | null,
    stage: { current: CreationStageKey },
    previousParams?: ParamValues,
  ) {
    const c = state.creation;
    const { ai } = this.context(state);
    for (let attempt = 0; ; attempt++) {
      const lint = this.lintDraft(c.draft!);
      const problems = [...lint.blocking, ...lint.portability];
      if (problems.length) {
        if (attempt >= MAX_FIXES) {
          throw new ExecutionError("The routine Doppl wrote didn't pass the safety check, so it wasn't run.", problems.join(" · "));
        }
        this.setStage(c, stage.current, "active", `Fixing ${plural(problems.length, "problem")} in the script`);
        c.draft = await this.deps.ai.fixRoutine(c.task, summary, c.draft!, { kind: "lint", messages: problems }, ai);
        continue;
      }
      if (stage.current === "write") {
        this.setStage(c, "write", "done", `${plural(c.draft!.steps.length, "step")} · ${plural(c.draft!.params.length, "parameter")}`);
      }
      try {
        await this.trialRun(state, c.draft!, stage, previousParams);
        return;
      } catch (err) {
        if (!(err instanceof ExecutionError && err.scriptFailure && attempt < MAX_FIXES)) throw err;
        c.outputs = [];
        this.setStage(c, "check", "pending", "");
        stage.current = "run";
        this.setStage(c, "run", "active", "Fixing an error from the trial run");
        c.draft = await this.deps.ai.fixRoutine(c.task, summary, c.draft!, { kind: "run", messages: [err.detail ?? err.message] }, ai);
      }
    }
  }

  private fail(state: CreationState, stage: CreationStageKey, err: unknown) {
    const c = state.creation;
    const appName = this.deps.registry.get(c.task.appId).name;
    const mapped = toExecutionError(err, appName);
    this.setStage(c, stage, "failed");
    c.status = "failed";
    c.question = undefined;
    c.error =
      mapped instanceof AiError
        ? { message: mapped.message, kind: "ai-access", code: mapped.code, action: mapped.action }
        : mapped instanceof ExecutionError
          ? { message: mapped.message, detail: mapped.detail, kind: mapped.kind }
          : { message: "Something went wrong.", detail: errorMessage(err), kind: "generic" };
    this.emit(c);
  }

  private async runCreate(state: CreationState) {
    const c = state.creation;
    const { isCancelled, ai } = this.context(state);
    const stage = { current: "read" as CreationStageKey };
    try {
      this.setStage(c, "read", "active");
      await this.prepareAi(c);
      const adapter = this.deps.registry.get(c.task.appId);
      const status = await this.deps.apps.statusOf(c.task.appId);
      if (status !== "connected") {
        throw new ExecutionError(
          status === "permission-denied"
            ? `Doppl isn't allowed to control ${adapter.name} yet.`
            : status === "awaiting-permission"
              ? `macOS is asking whether Doppl may control ${adapter.name}. Click OK in that prompt, then try again.`
              : `${adapter.name} isn't connected.`,
          undefined,
          "app-not-connected",
        );
      }
      const docs = await adapter.listOpenDocuments();
      const doc = docs.find((d) => d.id === c.task.documentId) ?? docs.find((d) => d.active) ?? docs[0];
      if (!doc) throw new ExecutionError(`Open a document in ${adapter.name}, then try again.`, undefined, "no-document");
      c.task.documentId = doc.id;
      const summary = await adapter.inspectDocument(doc.id);
      this.setStage(c, "read", "active", describe(summary));
      await this.deps.ai.readDocument(c.task, summary, ai);
      this.setStage(c, "read", "done");

      stage.current = "write";
      this.setStage(c, "write", "active");
      let drafting = await this.deps.ai.draftRoutine(c.task, summary, ai);
      while (drafting.question) {
        c.question = drafting.question;
        c.status = "waiting";
        this.emit(c);
        const optionId = await this.waitForAnswer(state);
        if (isCancelled()) throw new CancelledError();
        c.question = undefined;
        c.status = "running";
        this.emit(c);
        drafting = await this.deps.ai.answerQuestion(c.task, summary, drafting, optionId, ai);
      }
      c.draft = drafting.draft!;
      await this.buildAndTrial(state, summary, stage);
      this.setStage(c, "ready", "done");
      c.status = "ready";
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, stage.current, err);
    }
  }

  private async runRepair(state: CreationState) {
    const c = state.creation;
    const { isCancelled, ai } = this.context(state);
    const stage = { current: "read" as CreationStageKey };
    try {
      this.setStage(c, "read", "active");
      await this.prepareAi(c);
      const routine = await this.requireRoutine(c.routineId!);
      const run = c.failedRunId ? await this.deps.storage.getRun(c.failedRunId) : null;
      const env = await this.checkEnvironment(routine.id).catch(() => null);
      const diagnosis = await this.deps.ai.explainFailure(routine, run, env, ai);
      this.setStage(c, "read", "done", diagnosis);

      stage.current = "write";
      this.setStage(c, "write", "active");
      c.draft = await this.deps.ai.repairRoutine(routine, run, env, ai);
      this.setStage(c, "write", "active", `Version ${routine.version + 1} · ${plural(c.draft.steps.length, "step")}`);
      await this.buildAndTrial(state, null, stage, run?.params);
      this.setStage(c, "ready", "done");
      c.status = "ready";
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, stage.current, err);
    }
  }

  // ---------- Multi-app creation (stages) ----------

  /** The validator with this Mac's adapters and the samples used while creating. */
  validate(draft: { params: ParamDef[]; stages?: Stage[] }, samples?: ValidationSamples) {
    const { registry } = this.deps;
    // With one sample data file, its columns are what every data-file param must provide.
    if (samples?.dataColumns?.length === 1) {
      samples = { ...samples, columns: Object.fromEntries(draft.params.filter((p) => p.type === "dataFile").map((p) => [p.key, samples!.dataColumns![0]])) };
    }
    return validateRoutine(
      { params: draft.params, stages: draft.stages ?? [] },
      {
        has: (appId) => registry.list().some((a) => a.id === appId),
        stageKind: (appId) => registry.get(appId).stageKind,
        lintScript: (appId, script) => registry.get(appId).lintScript?.(script) ?? [],
      },
      samples,
    );
  }

  /** What the model gets to start: documents (inspected), sample data, folder file names, house style. */
  private async gatherFacts(c: Creation, isCancelled: () => boolean): Promise<{ facts: StageTaskFacts; samples: ValidationSamples; apps: AppId[] }> {
    const { registry } = this.deps;
    const apps = taskApps(c.task);
    const readiness = await checkReadiness(
      registry,
      this.deps.apps,
      apps.map((a) => ({ id: a.appId, name: a.appId, appId: a.appId, kind: registry.get(a.appId).stageKind, body: "", inputs: [], outputs: [], document: "none" as const })),
      Object.fromEntries(apps.filter((a) => a.documentId).map((a) => [a.appId, a.documentId!])),
    );
    const documents: StageTaskFacts["documents"] = [];
    for (const r of readiness) {
      if (r.status !== "connected") {
        throw new ExecutionError(
          r.appId === "figma" ? "Start the Doppl plugin in your Figma file first." : r.message ?? `${r.appName} isn't connected.`,
          undefined,
          r.appId === "figma" ? "plugin-not-connected" : "app-not-connected",
        );
      }
      const app = apps.find((a) => a.appId === r.appId);
      if (app?.noDocument) {
        // The designer chose "No document": don't read (or touch) whatever happens to be open.
        app.documentId = undefined;
        documents.push({
          appId: r.appId,
          id: "",
          name: "no document",
          inspection: 'The designer chose no document for this app: its stages open their own files from params (document "none").',
        });
        continue;
      }
      const picked = app?.documentId;
      const doc = r.documents.find((d) => d.id === picked) ?? r.documents.find((d) => d.active) ?? r.documents[0];
      if (!doc) continue;
      if (isCancelled()) throw new CancelledError();
      if (app) app.documentId = doc.id;
      // Deep enough that the model rarely needs to inspect again (Figma also details the designer's selection).
      const inspection = await registry.get(r.appId).inspectForModel(doc.id, { depth: 3 }).catch((err) => ({ error: errorMessage(err) }));
      documents.push({ appId: r.appId, id: doc.id, name: doc.name, inspection });
    }
    c.task.apps = apps;

    const samples: StageTaskFacts["samples"] = [];
    const values: string[] = [];
    const columns: Record<string, string[]> = {};

    for (const ref of c.task.references) {
      const ext = path.extname(ref).slice(1).toLowerCase();
      values.push(path.basename(ref), path.basename(ref, path.extname(ref)));
      if (!DATA_EXTENSIONS.includes(ext) || (ext === "txt" && !(await this.looksTabular(ref)))) continue;
      try {
        const table = await readDataFile(ref);
        samples.push({
          file: path.basename(ref),
          columns: table.columns,
          rows: table.rows.slice(0, 5),
          totalRows: table.rows.length,
          errors: table.errors.slice(0, 5).map((e) => `Row ${e.row}: ${e.message}`),
        });
        columns[path.basename(ref)] = table.columns;
        for (const row of table.rows.slice(0, 200)) for (const v of Object.values(row)) if (v !== null && v !== undefined) values.push(String(v));
      } catch (err) {
        samples.push({ file: path.basename(ref), columns: [], rows: [], totalRows: 0, errors: [err instanceof DataFileError ? err.message : errorMessage(err)] });
      }
    }
    const folders: StageTaskFacts["folders"] = [];
    for (const folder of c.task.folders ?? []) {
      const files = await listFolderFiles(folder).catch(() => []);
      folders.push({ path: folder, files: files.map((f) => f.name) });
      for (const f of files) values.push(f.name, f.stem);
    }
    const allowed = [...documents.flatMap((d) => [...namesIn(d.inspection)])];
    const style = await this.deps.getStyle().catch(() => null);
    return {
      facts: { request: c.task.request, references: c.task.references, folders, samples, documents, style },
      samples: { values, allowed, dataColumns: Object.values(columns) },
      apps: apps.map((a) => a.appId),
    };
  }

  private async looksTabular(file: string) {
    const head = await fs.readFile(file, "utf8").then((t) => t.slice(0, 2000)).catch(() => "");
    const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 3);
    return lines.length > 1 && lines.every((l) => /[,;\t]/.test(l));
  }

  /** Values for a trial or preview: sample data and folders from the task, temp folders for output. */
  private async stagedTrialParams(draft: RoutineDraft, task: Task, workDir: string, previous?: ParamValues): Promise<ParamValues> {
    const values: ParamValues = {};
    const refs = task.references;
    for (const p of draft.params) {
      const prev = previous?.[p.key];
      if (p.type === "dataFile") {
        values[p.key] = (prev as string) ?? refs.find((r) => DATA_EXTENSIONS.includes(path.extname(r).slice(1).toLowerCase())) ?? null;
      } else if (p.type === "folder") {
        const output = p.role === "output" || (p.role !== "input" && /out|export|save|result|destination|deliver/i.test(`${p.key} ${p.label}`));
        if (output) {
          values[p.key] = path.join(workDir, `output-${p.key}`);
          await fs.mkdir(String(values[p.key]), { recursive: true });
        } else {
          values[p.key] = (prev as string) ?? task.folders?.[0] ?? (refs.length ? path.dirname(refs[0]) : null);
        }
      } else if (p.type === "file") {
        values[p.key] = (prev as string) ?? refs.find((r) => !p.extensions || p.extensions.includes(path.extname(r).slice(1).toLowerCase())) ?? null;
      } else if (p.type === "select") {
        const options = p.options ?? [];
        values[p.key] = options.find((o) => o.value === (prev ?? p.default))?.value ?? options[0]?.value ?? (p.default as string) ?? null;
      } else if (p.type === "formatList") {
        values[p.key] = ((p.default as string[] | undefined) ?? p.options?.map((o) => o.value) ?? []).slice(0, 3);
      } else {
        values[p.key] = prev ?? (p.default as ParamValues[string]) ?? (p.type === "text" ? "sample" : null);
      }
    }
    return values;
  }

  /** Runs the draft's stages on one sample item in scratch copies (preview_stage, and the trial before "ready"). */
  private async runStagedTrial(state: CreationState, draft: RoutineDraft, sampleIndex: number, stopAfter: string | undefined, previous?: ParamValues) {
    const c = state.creation;
    const { isCancelled, ai } = this.context(state);
    const trialId = `trial-${c.id}-${newId().slice(0, 8)}`;
    const workDir = path.join(this.deps.workRoot, trialId);
    await fs.mkdir(workDir, { recursive: true });
    const values = await this.stagedTrialParams(draft, c.task, workDir, previous);
    const documents = Object.fromEntries(taskApps(c.task).filter((a) => a.documentId).map((a) => [a.appId, a.documentId!]));
    const res = await this.deps.stageRunner.run(
      {
        runId: trialId,
        routineName: draft.name,
        stages: draft.stages!,
        params: draft.params,
        values,
        target: "trial",
        documents,
        runDir: workDir,
        copiesDir: path.join(workDir, "copies"),
        isCancelled,
        sampleIndex,
        stopAfter,
      },
      {
        onProgress: (stages, phase) => {
          c.trialStages = stages;
          this.setStage(c, c.stages.find((s) => s.status === "active")?.key ?? "run", "active", phase);
        },
        onOutputs: (outputs) => {
          c.outputs = outputs;
          this.emit(c);
        },
      },
    );
    // Rule-level checks on what the trial made (no AI).
    for (const stage of draft.stages!) {
      const mine = res.outputs.filter((o) => o.stageId === stage.id);
      const ids = new Set(mine.map((o) => o.id));
      await this.deps.qc.evaluate(
        this.deps.registry.get(stage.appId),
        { qcMode: "auto", qcOptions: DEFAULT_QC_OPTIONS, qcProfile: draft.qcProfile },
        mine,
        res.findings.filter((f) => f.outputKey && ids.has(f.outputKey)),
        ai,
      );
    }
    c.outputs = res.outputs;
    c.trialStages = res.stages;
    this.emit(c);
    return { res, workDir };
  }

  /** The trial result as the model sees it: per stage, per item, with errors, findings and a few previews. */
  private describeTrial(res: StageRunResult, stageId: string | undefined, label: string): ContentPart[] {
    const items = res.items.filter((i) => !stageId || i.stageId === stageId);
    const summary = {
      status: res.status,
      stages: res.stages.map((s) => ({ id: s.stageId, status: s.status, done: s.done, failed: s.failed, error: s.error })),
      items: items.map((i) => ({
        stage: i.stageId,
        item: i.label,
        ok: i.ok,
        error: i.error,
        findings: i.findings.map((f) => `${f.type}: ${f.message}`),
        log: i.log.slice(0, 10),
        files: res.outputs.filter((o) => i.outputIds.includes(o.id) && o.filePath).map((o) => path.basename(o.filePath!)),
        result: i.data,
      })),
      outputs: Object.fromEntries(Object.entries(res.stageOutputs).map(([id, s]) => [id, Object.fromEntries(Object.entries(s.outputs).map(([k, v]) => [k, v.map((x) => (typeof x === "string" && x.startsWith("/") ? path.basename(x) : x))]))])),
    };
    const images = res.outputs.filter((o) => (!stageId || o.stageId === stageId) && o.preview?.kind === "image").slice(0, 2);
    return [
      { type: "text", text: `${label}\n${clip(summary)}` },
      ...images.flatMap((o): ContentPart[] => [
        { type: "text", text: `Preview of ${o.label}:` },
        { type: "image_url", image_url: { url: o.preview!.src, detail: "low" } },
      ]),
    ];
  }

  private note(c: Creation, text: string) {
    c.activity = [...(c.activity ?? []), text];
    this.emit(c);
  }

  /** The routine as the model wrote it (for repairs). */
  private routineForModel(r: { name: string; description: string; params: ParamDef[]; stages?: Stage[]; qcProfile: string; keyObjects?: string[]; objectChecks?: unknown }) {
    return {
      name: r.name,
      description: r.description,
      params: r.params,
      qcProfile: r.qcProfile,
      keyObjects: r.keyObjects ?? [],
      objectChecks: r.objectChecks ?? [],
      stages: (r.stages ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        app: s.appId,
        kind: s.kind,
        document: s.document,
        repeat: s.repeat,
        inputs: s.inputs,
        outputs: s.outputs,
        steps: s.steps,
        modifiesDocument: s.modifiesDocument,
        ...(s.kind === "actions" ? { actions: (s.body as { actions: unknown[] }).actions } : { script: s.body }),
      })),
    };
  }

  /**
   * Multi-app creation (and repair of multi-app routines): the model works in turns, each one AI call. It can
   * inspect documents, preview a stage on one sample item, and propose the routine; Doppl validates proposals
   * and runs a trial on the first sample item, sending problems back until the routine is valid and works.
   */
  private async runStaged(state: CreationState) {
    const c = state.creation;
    const { isCancelled, ai } = this.context(state);
    const stage = { current: "read" as CreationStageKey };
    const versions: Record<string, string> = {};
    try {
      this.setStage(c, "read", "active");
      await this.prepareAi(c);
      const { facts, samples, apps } = await this.gatherFacts(c, isCancelled);
      state.samples = samples;
      let previous: ParamValues | undefined;
      if (c.mode === "repair") {
        const routine = await this.requireRoutine(c.routineId!);
        const run = c.failedRunId ? await this.deps.storage.getRun(c.failedRunId) : null;
        previous = run?.params;
        const failed = run?.outputs.filter((o) => o.status === "failed").slice(0, 8).map((o) => `${o.itemLabel ?? o.label}: ${o.error ?? ""}`) ?? [];
        facts.current = { routine: this.routineForModel(routine), problems: [run?.error, run?.errorDetail, ...failed].filter((x): x is string => !!x) };
        if (facts.current.problems.length === 0) facts.current.problems.push("The designer asked for a repair; check the routine against the documents.");
      }
      for (const appId of apps) versions[appId] = (await this.deps.registry.get(appId).getAppVersion().catch(() => null)) ?? "";
      this.setStage(c, "read", "done", `${plural(facts.documents.length, "document")} · ${plural(facts.samples.length, "data file")}`);

      stage.current = "write";
      this.setStage(c, "write", "active");
      const registry = this.deps.registry;
      const messages: ChatMessage[] = [
        { role: "system", content: stageSystemPrompt(apps.map((id) => ({ adapter: registry.get(id), manifest: registry.get(id).capabilityManifest() })), MAX_TURNS) },
        { role: "user", content: stageTaskMessage(facts) },
      ];
      let asked = false;
      let lastProblem = "";
      let inspections = 0;
      let turn = 0;
      // Every reply says how many answers are left, so the model proposes in time.
      const budget = () => `[${Math.max(0, MAX_TURNS - turn)} of ${MAX_TURNS} answers left]`;
      const reply = (content: string | ContentPart[]) =>
        messages.push({
          role: "user",
          content: typeof content === "string" ? `${budget()} ${content}` : [{ type: "text", text: budget() }, ...content],
        });
      for (turn = 1; ; turn++) {
        if (isCancelled()) throw new CancelledError();
        if (turn > MAX_TURNS || c.aiCalls >= MAX_CREATION_CALLS - REVIEW_RESERVE) {
          throw new ExecutionError(
            `Doppl couldn't finish this routine within the AI limit for one creation (${MAX_CREATION_CALLS} calls). Try describing it in smaller steps.`,
            lastProblem || undefined,
            "validation",
          );
        }
        this.setStage(c, stage.current, "active", `Step ${turn}`);
        const t = await this.deps.ai.stageTurn(messages, ai);
        messages.push({ role: "assistant", content: JSON.stringify(t) });
        if (typeof t.reason === "string" && t.reason.trim()) this.note(c, t.reason.trim().slice(0, 160));

        if (t.action === "ask_question") {
          const options = Array.isArray(t.question?.options) ? t.question.options.slice(0, 4) : [];
          if (asked || turn > 1 || !t.question?.text || options.length < 2) {
            reply("Don't ask now. Decide yourself and continue (propose_routine).");
            continue;
          }
          asked = true;
          c.question = { id: `q-${newId()}`, text: String(t.question.text), options: options.map((o: any, i: number) => ({ id: String(o.id ?? i), label: String(o.label ?? o.id) })) };
          c.status = "waiting";
          this.emit(c);
          const optionId = await this.waitForAnswer(state);
          if (isCancelled()) throw new CancelledError();
          const label = c.question.options.find((o) => o.id === optionId)?.label ?? optionId;
          c.question = undefined;
          c.status = "running";
          this.emit(c);
          reply(`Answer: ${label}. Continue.`);
          continue;
        }

        if (t.action === "inspect") {
          const appId = String(t.app ?? "");
          const doc = taskApps(c.task).find((a) => a.appId === appId);
          if (!apps.includes(appId) || !(t.document || doc?.documentId)) {
            reply(`Can't inspect: app must be one of ${apps.join(", ")} with an open document.`);
            continue;
          }
          if (++inspections > MAX_INSPECTIONS) {
            reply(`You've used your ${MAX_INSPECTIONS} inspections. Propose the complete routine now with what you know.`);
            continue;
          }
          const nodes: (string | undefined)[] = Array.isArray(t.nodes) && t.nodes.length ? t.nodes.slice(0, MAX_NODES_PER_INSPECT).map(String) : [t.node];
          this.note(c, `Looked at ${registry.get(appId).name}${nodes[0] ? ` · ${nodes.join(", ")}` : ""}`);
          const results: Record<string, unknown> = {};
          for (const node of nodes) {
            results[node ?? "document"] = await registry
              .get(appId)
              .inspectForModel(String(t.document || doc!.documentId), { node, depth: t.depth })
              .catch((err) => ({ error: errorMessage(err) }));
          }
          reply(`Inspection of ${appId} (${inspections} of ${MAX_INSPECTIONS} inspections used): ${clip(results, 14000)}`);
          continue;
        }

        // preview_stage and propose_routine both carry a routine.
        let draft: RoutineDraft;
        try {
          draft = toStagedDraft(t.routine, versions);
        } catch (err) {
          reply(`The routine couldn't be read: ${err instanceof AiOutputError ? err.message : errorMessage(err)} Send the complete routine again.`);
          continue;
        }
        const check = this.validate(draft, t.action === "propose_routine" ? samples : undefined);
        if (!check.ok) {
          const errors = errorsForModel(check.errors, draft);
          lastProblem = errors.map((e) => `${e.path}: ${e.message}`).join(" · ");
          this.note(c, `${t.action === "propose_routine" ? "Proposal" : "Preview"} had ${plural(errors.length, "problem")}; sent back to fix`);
          reply(`Validation failed. Fix these and send the whole routine again:\n${clip(errors, 6000)}`);
          continue;
        }

        if (t.action === "preview_stage") {
          const stageId = String(t.stageId ?? draft.stages![0].id);
          if (!draft.stages!.some((s) => s.id === stageId)) {
            reply(`There is no stage "${stageId}" in the routine.`);
            continue;
          }
          const index = Math.max(0, Math.floor(Number(t.sampleItemIndex) || 0));
          this.note(c, `Previewed ${draft.stages!.find((s) => s.id === stageId)!.name} on sample item ${index + 1}`);
          const { res, workDir } = await this.runStagedTrial(state, draft, index, stageId, previous);
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          reply(this.describeTrial(res, stageId, `Preview of stage "${stageId}" on sample item ${index}:`));
          continue;
        }

        // propose_routine: valid; run the whole routine once on the first sample item.
        c.draft = draft;
        this.setStage(c, "write", "done", `${plural(draft.stages!.length, "stage")} · ${plural(draft.params.length, "parameter")}`);
        stage.current = "run";
        this.setStage(c, "run", "active", "Trial on the first sample item");
        const { res, workDir } = await this.runStagedTrial(state, draft, 0, undefined, previous);
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        const scriptProblems = res.items.filter((i) => !i.ok && i.scriptFailure);
        const stageErrors = res.stages.filter((s) => s.error);
        if (res.status === "cancelled") throw new CancelledError();
        if (scriptProblems.length || stageErrors.length || res.status === "failed") {
          lastProblem = [...stageErrors.map((s) => `${s.name}: ${s.error}`), ...scriptProblems.map((i) => `${i.label}: ${i.error}`)].join(" · ") || res.error || "";
          if (c.aiCalls >= MAX_CREATION_CALLS - REVIEW_RESERVE || turn >= MAX_TURNS) {
            throw new ExecutionError("The trial run of the routine failed.", lastProblem, "generic", true);
          }
          this.note(c, "The trial run failed; sent the errors back to fix");
          this.setStage(c, "run", "pending", "");
          stage.current = "write";
          this.setStage(c, "write", "active", "Fixing problems from the trial run");
          reply(this.describeTrial(res, undefined, "The trial run on the first sample item failed. Fix the routine and propose it again:"));
          continue;
        }
        this.setStage(c, "run", "done", `${plural(res.outputs.length, "output")} from 1 sample item`);
        break;
      }

      stage.current = "check";
      this.setStage(c, "check", "active");
      const extra = await this.deps.ai.reviewTrial(c.task, c.draft!, c.outputs, ai);
      for (const output of c.outputs) mergeChecks(output, extra[output.id]);
      const flagged = c.outputs.filter((o) => o.qc?.status === "flagged").length;
      this.setStage(c, "check", "done", flagged ? `${flagged} flagged` : "All checks passed");
      this.setStage(c, "ready", "done");
      c.status = "ready";
      this.emit(c);
    } catch (err) {
      if (isCancelled()) return;
      this.fail(state, stage.current, err);
    }
  }

  /** Runs the draft once (on a hidden temporary copy for InDesign) and checks the result. */
  private async trialRun(state: CreationState, draft: RoutineDraft, stage: { current: CreationStageKey }, previousParams?: ParamValues) {
    const c = state.creation;
    const { isCancelled, ai } = this.context(state);
    const trialId = `${c.id}-${newId().slice(0, 8)}`;
    stage.current = "run";
    this.setStage(c, "run", "active");

    const workDir = path.join(this.deps.workRoot, `trial-${trialId}`);
    await fs.mkdir(workDir, { recursive: true });
    try {
      const params = await this.trialParams(draft, c.task, workDir, previousParams);
      const res = await this.deps.executor.execute(
        {
          runId: `trialrun-${trialId}`,
          appId: draft.appId,
          routineName: draft.name,
          script: draft.script,
          modifiesDocument: draft.modifiesDocument,
          qcProfile: draft.qcProfile,
          builtInQc: draft.builtInQc,
          params,
          qcMode: "auto",
          qcOptions: DEFAULT_QC_OPTIONS,
          target: "trial",
          documentId: c.task.documentId,
          allowedFolders: folderParams(draft.params, params),
          isCancelled,
        },
        {
          onPhase: (phase) => this.setStage(c, stage.current, "active", phase),
          onOutputs: (outputs) => {
            c.outputs = outputs;
            this.emit(c);
          },
          onAiCall: ai.onAiCall,
          onStage: (s) => {
            if (s === "check" && stage.current === "run") {
              this.setStage(c, "run", "done", `${plural(c.outputs.length, "output")} on a temporary copy`);
              stage.current = "check";
              this.setStage(c, "check", "active");
            }
          },
        },
      );
      c.outputs = res.outputs;
      const extra = await this.deps.ai.reviewTrial(c.task, draft, res.outputs, ai);
      for (const output of res.outputs) mergeChecks(output, extra[output.id]);
      this.emit(c);
      const flagged = res.outputs.filter((o) => o.qc?.status === "flagged").length;
      this.setStage(c, "check", "done", flagged ? `${flagged} flagged` : "All checks passed");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Values for a trial run: temp folders, sample files, the first preset, three sample formats. */
  private async trialParams(draft: RoutineDraft, task: Task, workDir: string, previous?: ParamValues): Promise<ParamValues> {
    const adapter = this.deps.registry.get(draft.appId);
    const values: ParamValues = {};
    for (const p of draft.params) {
      const prev = previous?.[p.key];
      switch (p.type) {
        case "folder":
          values[p.key] = path.join(workDir, "output");
          break;
        case "file": {
          const ref = task.references.find((r) => !p.extensions || p.extensions.includes(path.extname(r).slice(1).toLowerCase()));
          if (ref) {
            values[p.key] = ref;
          } else {
            const sample = path.join(workDir, "sample.txt");
            await fs.writeFile(sample, SAMPLE_TEXT, "utf8");
            values[p.key] = sample;
          }
          break;
        }
        case "select": {
          const options = p.options ?? (p.optionsSource ? await adapter.getParamOptions(p.optionsSource, task.documentId).catch(() => []) : []);
          values[p.key] = options.find((o) => o.value === (prev ?? p.default))?.value ?? options[0]?.value ?? (p.default as string) ?? null;
          break;
        }
        case "formatList": {
          // A trial needs only a few of the formats.
          const all = (p.default as string[] | undefined) ?? p.options?.map((o) => o.value) ?? [];
          values[p.key] = all.slice(0, 3);
          break;
        }
        case "text":
          if (p.key === "pageRange") values[p.key] = "1-3";
          else values[p.key] = (prev as string) ?? (p.default as string) ?? (/pattern/i.test(p.key) ? "{doc}_{format}{page}" : "sample");
          break;
        default:
          values[p.key] = prev ?? (p.default as ParamValues[string]) ?? null;
      }
    }
    return values;
  }
}

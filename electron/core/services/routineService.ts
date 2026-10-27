import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import type { DevFlagsStore } from "../mock/devFlags";
import type {
  Creation,
  CreationStage,
  CreationStageKey,
  DocumentSummary,
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
import { CancelledError, compareVersions, delay, errorMessage, newId, nowIso, plural } from "../util";
import type { AiAccessService } from "./aiAccessService";
import type { AiCallContext, AiService } from "./aiService";
import { AiError } from "./aiTransport";
import type { AppStatusService } from "./appStatusService";
import { findPortabilityIssues } from "./portability";
import { DEFAULT_QC_OPTIONS, ExecutionError, type RoutineExecutor, toExecutionError } from "./runService";
import type { Storage } from "./storage";

const STAGES: CreationStageKey[] = ["read", "write", "run", "check", "ready"];

const SAMPLE_TEXT = Array.from(
  { length: 14 },
  (_, i) =>
    `Sample paragraph ${i + 1}. Doppel placed this text during a trial run to check that the routine flows copy into your template, adds pages when the text is longer than the frame, and keeps your paragraph styles. Nothing here is saved to your document.`,
).join("\n\n");

interface CreationState {
  creation: Creation;
  cancelled: boolean;
  attempt: number;
  answer?: (optionId: string) => void;
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

/** AI checks replace the mocked check with the same label, or are added. */
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

/** Library (list/get), routine creation with the mock AI, repair, saving with portability checks. */
export class RoutineService {
  private creations = new Map<string, CreationState>();

  constructor(
    private readonly deps: {
      storage: Storage;
      registry: AdapterRegistry;
      ai: AiService;
      access: AiAccessService;
      executor: RoutineExecutor;
      apps: AppStatusService;
      flags: DevFlagsStore;
      emit: (creation: Creation) => void;
      workRoot: string;
    },
  ) {}

  // ---------- Library ----------

  async list(): Promise<Routine[]> {
    if (this.deps.flags.get().emptyLibrary) return [];
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
    if (this.deps.flags.get().envMismatch) {
      currentVersion = `${Math.max(1, major(routine.appVersion) - 1)}.5`;
      if (!missingFonts.includes("Inter")) missingFonts = [...missingFonts, "Inter"];
    }
    const versionMismatch =
      !!currentVersion &&
      !!routine.appVersion &&
      (major(currentVersion) !== major(routine.appVersion) || compareVersions(currentVersion, routine.appVersion) < 0);
    return { appStatus, currentVersion: currentVersion ?? undefined, routineVersion: routine.appVersion, versionMismatch, missingFonts };
  }

  async getParamOptions(routineId: string, key: string): Promise<ParamOption[]> {
    const routine = await this.requireRoutine(routineId);
    const param = routine.params.find((p) => p.key === key);
    if (!param) return [];
    if (param.options) return param.options;
    if (!param.optionsSource) return [];
    const options = await this.deps.registry
      .get(routine.appId)
      .getParamOptions(param.optionsSource)
      .catch(() => []);
    if (options.length === 0 && typeof param.default === "string") return [{ value: param.default, label: param.default }];
    return options;
  }

  // ---------- Creation ----------

  async create(input: NewTaskInput): Promise<Creation> {
    if (!input.request.trim()) throw new Error("Describe what the routine should do first.");
    const task: Task = {
      id: newId(),
      request: input.request.trim(),
      references: input.references,
      appId: input.appId,
      documentId: input.documentId,
      createdAt: nowIso(),
    };
    const creation: Creation = { id: task.id, mode: "create", task, status: "running", stages: freshStages(), aiCalls: 0, outputs: [] };
    const state: CreationState = { creation, cancelled: false, attempt: 0 };
    this.creations.set(creation.id, state);
    void this.runCreate(state);
    return creation;
  }

  async repair(routineId: string, runId?: string): Promise<Creation> {
    const routine = await this.requireRoutine(routineId);
    const run = runId ? await this.deps.storage.getRun(runId) : null;
    const task: Task = {
      id: newId(),
      request: `Repair "${routine.name}"`,
      references: [],
      appId: routine.appId,
      documentId: run?.options.documentId,
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
    void this.runRepair(state);
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
    Object.assign(c, { status: "running", stages: freshStages(), outputs: [], question: undefined, error: undefined, draft: undefined });
    this.emit(c);
    void (c.mode === "repair" ? this.runRepair(state) : this.runCreate(state));
    return c;
  }

  async discard(id: string) {
    await this.cancel(id);
    this.creations.delete(id);
  }

  async save(id: string, input: SaveRoutineInput): Promise<SaveRoutineResult> {
    const { storage, flags } = this.deps;
    const c = this.requireState(id).creation;
    if (c.status !== "ready" || !c.draft) throw new Error("This routine isn't ready to save yet.");
    const draft = c.draft;
    const issues = findPortabilityIssues(draft.script);
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
      });
      routine.versions = [...routine.versions, { version, createdAt: now, aiCalls: c.aiCalls, note: "Repaired with AI" }];
      // The simulated problem is fixed now.
      if (flags.get().runOutcome === "fail") flags.set({ runOutcome: "auto" });
      if (flags.get().envMismatch) flags.set({ envMismatch: false });
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
      speed: this.deps.flags.get().speed,
      // Retries of the same creation keep its id; a repair is a new creation with its own id.
      creationId: state.creation.id,
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
    if (this.deps.flags.get().mockAi) return;
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
   * The mock AI can't fix scripts: its drafts go straight to the trial run.
   */
  private async buildAndTrial(
    state: CreationState,
    summary: DocumentSummary | null,
    stage: { current: CreationStageKey },
    previousParams?: ParamValues,
  ) {
    const c = state.creation;
    const { ai } = this.context(state);
    const canFix = this.deps.ai.canFixScripts;
    for (let attempt = 0; ; attempt++) {
      const lint = this.lintDraft(c.draft!);
      const problems = canFix ? [...lint.blocking, ...lint.portability] : lint.blocking;
      if (problems.length) {
        if (!canFix || attempt >= MAX_FIXES) {
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
        if (!(err instanceof ExecutionError && err.scriptFailure && canFix && attempt < MAX_FIXES)) throw err;
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
          status === "permission-denied" ? `Doppel isn't allowed to control ${adapter.name} yet.` : `${adapter.name} isn't connected.`,
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

  /** Runs the draft once (on a hidden temporary copy for InDesign) and checks the result. */
  private async trialRun(state: CreationState, draft: RoutineDraft, stage: { current: CreationStageKey }, previousParams?: ParamValues) {
    const c = state.creation;
    const { isCancelled, ai } = this.context(state);
    const trialId = `${c.id}-${newId().slice(0, 8)}`;
    const speed = this.deps.flags.get().speed;
    stage.current = "run";
    this.setStage(c, "run", "active");
    if (this.deps.flags.get().creationOutcome === "fail") {
      await delay(1600 * speed, isCancelled);
      throw new ExecutionError("The routine stopped before it finished.", "On page 2 it expected a text frame for the body text, but the page has none.");
    }

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
          const options = p.options ?? (p.optionsSource ? await adapter.getParamOptions(p.optionsSource).catch(() => []) : []);
          values[p.key] = options.find((o) => o.value === (prev ?? p.default))?.value ?? options[0]?.value ?? (p.default as string) ?? null;
          break;
        }
        case "formatList": {
          const all = (p.default as string[] | undefined) ?? p.options?.map((o) => o.value) ?? [];
          const preferred = ["instagram-post", "instagram-story", "x-header"].filter((v) => all.includes(v));
          values[p.key] = preferred.length ? preferred : all.slice(0, 3);
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

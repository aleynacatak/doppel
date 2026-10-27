import type { ClarifyingQuestion, DocumentSummary, EnvironmentCheck, QcCheck, Routine, RoutineDraft, Run, RunOutput, Task } from "../types";
import type { QuotaUpdate } from "./aiTransport";

/**
 * Everything that calls Meta's models. Two implementations, picked per call in core/config.ts:
 * ModelAiService (real: demo Worker or own key) and MockAiService (template library, no network).
 */

export interface AiCallContext {
  /** Called once per model call, so the UI can count them live. */
  onAiCall: () => void;
  isCancelled: () => boolean;
  speed: number;
  /** One id per routine creation or repair; the demo Worker counts creations by it. */
  creationId?: string;
  /** Demo quota from the Worker's response headers. */
  onQuota?: (quota: QuotaUpdate) => void;
}

/** Where routine drafting stands: either a draft, or a question for the user first. */
export interface DraftState {
  draft?: RoutineDraft;
  question?: ClarifyingQuestion;
  /** Opaque state the AI needs to continue after an answer. */
  memory: Record<string, unknown>;
}

/** Why a draft has to be fixed: the safety/portability lint, or an error from the trial run. */
export interface ScriptFailure {
  kind: "lint" | "run";
  messages: string[];
}

export interface AiService {
  /** Whether fixRoutine can repair scripts (the mock can't). */
  readonly canFixScripts: boolean;
  /** Understand the request against the document (stage "Reading document"). */
  readDocument(task: Task, summary: DocumentSummary, ctx: AiCallContext): Promise<void>;
  /** Write the routine (stage "Writing routine"). May ask a clarifying question first. */
  draftRoutine(task: Task, summary: DocumentSummary, ctx: AiCallContext): Promise<DraftState>;
  answerQuestion(task: Task, summary: DocumentSummary, state: DraftState, optionId: string, ctx: AiCallContext): Promise<DraftState>;
  /** Rewrite a draft after the lint or a trial run found problems. */
  fixRoutine(task: Task, summary: DocumentSummary | null, draft: RoutineDraft, failure: ScriptFailure, ctx: AiCallContext): Promise<RoutineDraft>;
  /** Look at the trial run's result (stage "Checking result"). Returns extra checks per output id. */
  reviewTrial(task: Task, draft: RoutineDraft, outputs: RunOutput[], ctx: AiCallContext): Promise<Record<string, QcCheck[]>>;
  /** Explain in plain language why a run failed (repair stage "Reading what went wrong"). */
  explainFailure(routine: Routine, failedRun: Run | null, env: EnvironmentCheck | null, ctx: AiCallContext): Promise<string>;
  /** Fix a routine after a failed run or an environment change. */
  repairRoutine(routine: Routine, failedRun: Run | null, env: EnvironmentCheck | null, ctx: AiCallContext): Promise<RoutineDraft>;
  /** Visual judgement on one output ("Automatic check + AI review" on reruns). */
  reviewOutput(output: RunOutput, ctx: AiCallContext): Promise<QcCheck>;
}

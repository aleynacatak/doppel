import type { Role, UsageRecord } from "../ai/gateway";
import type { ObjectCheckDef, QcCheck, RunOutput, Task } from "../types";
import type { ChatMessage, QuotaUpdate } from "./aiTransport";

/** Everything that calls a model (implemented by ModelAiService, through the role router). */

export interface AiCallContext {
  /** Called once per model call, so the UI can count them live. */
  onAiCall: () => void;
  isCancelled: () => boolean;
  /** One id per routine creation or repair; the demo Worker counts creations by it. */
  creationId?: string;
  /** Demo quota from the Worker's response headers. */
  onQuota?: (quota: QuotaUpdate) => void;
  /** Tokens and cost of each call, by role and model (provenance, evals). */
  onUsage?: (usage: UsageRecord) => void;
}

export interface TurnOptions {
  /** Which role answers (default: planner). */
  role?: Role;
  /** Schema fields written before the others (the plan). */
  first?: string[];
}

export interface AiService {
  /**
   * One turn of a creation loop: the model answers with one JSON object matching `schema`, whose "action" is one
   * of `actions` (raw JSON; the creation flow reads it).
   */
  turn(messages: ChatMessage[], schema: { name: string; schema: Record<string, unknown> }, actions: string[], ctx: AiCallContext, options?: TurnOptions): Promise<Record<string, any>>;
  /** A plain-text answer from a role (e.g. the coder generalizing custom code into a building block). */
  text?(role: Role, messages: ChatMessage[], ctx: AiCallContext, maxTokens?: number): Promise<string>;
  /** The coder writes code as plain text (a script, or a Figma action list as JSON). Returns the code. */
  writeCode?(messages: ChatMessage[], language: "javascript" | "json", ctx: AiCallContext): Promise<string>;
  /** The name the role's model sees for a canonical schema field (some models need prefixes to write it first). */
  fieldKey?(role: Role, field: string, first: string[]): string;
  /** A trial failed: escalation rules count these per creation. */
  noteFailedTrial?(creationId: string): void;
  /** Which of a file's columns holds each column a routine expects, when the names don't say (see ModelAiService). */
  matchColumns?(input: { routine: string; expected: string[]; columns: string[]; rows: Record<string, unknown>[] }, ctx: AiCallContext): Promise<Record<string, string | null>>;
  /** Which model serves a role now (for provenance). */
  modelFor?(role: Role, creationId?: string): string;
  /** Look at a trial run's result (stage "Checking result"). Returns extra checks per output id. */
  reviewTrial(task: Task, draft: { name: string; keyObjects?: string[]; customSteps?: string[] }, outputs: RunOutput[], ctx: AiCallContext): Promise<Record<string, QcCheck[]>>;
  /** Visual judgement on one output ("Automatic check + AI review" on reruns). */
  reviewOutput(output: RunOutput, ctx: AiCallContext): Promise<QcCheck>;
  /** SAM: is <object> inside <region> in this output's preview? Two segment calls, each counted. */
  checkObjectInRegion(output: RunOutput, check: ObjectCheckDef, ctx: AiCallContext): Promise<QcCheck>;
}

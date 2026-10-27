import type { AdapterRegistry } from "../../adapters/registry";
import type { RoutineTemplate } from "../../adapters/types";
import type {
  DocumentSummary,
  EnvironmentCheck,
  ParamDef,
  ParamType,
  ParamValue,
  QcCheck,
  Routine,
  RoutineDraft,
  Run,
  RunOutput,
  Task,
} from "../types";
import { newId } from "../util";
import type { AiAccessService } from "./aiAccessService";
import {
  DRAFT_SCHEMA,
  EXPLAIN_SYSTEM,
  EXPLANATION_SCHEMA,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM,
  ROUTINE_SCHEMA,
  fixMessage,
  systemPrompt,
  taskMessage,
} from "./aiPrompts";
import type { AiCallContext, AiService, DraftState, ScriptFailure } from "./aiService";
import { AiError, type ChatMessage, type ChatRequest, type ContentPart, type SegmentBox } from "./aiTransport";
import type { StyleService } from "./styleService";

const PARAM_TYPES: ParamType[] = ["text", "number", "boolean", "select", "formatList", "file", "folder"];
const OPTION_SOURCES: Record<string, string[]> = { indesign: ["pdfExportPresets"], figma: ["frames"] };
const ROUTINE_TOKENS = 8000;
const SHORT_TOKENS = 1500;
const MAX_REVIEW_IMAGES = 4;

/** The model answered, but not with something Doppl can use. */
export class AiOutputError extends Error {}

function parseJson(content: string): Record<string, any> {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  try {
    return JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
  } catch {
    throw new AiOutputError("The answer wasn't valid JSON.");
  }
}

const strings = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, max) : [];

function toParam(raw: Record<string, any>, appId: string): ParamDef | null {
  const key = String(raw?.key ?? "").trim();
  const type = raw?.type as ParamType;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !PARAM_TYPES.includes(type)) return null;
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter((o: any) => o && typeof o.value === "string")
        .map((o: any) => ({ value: o.value, label: typeof o.label === "string" && o.label ? o.label : o.value }))
    : undefined;
  let def: ParamValue | undefined = raw.default;
  if (type === "number") def = Number.isFinite(Number(def)) && def !== "" && def !== null ? Number(def) : undefined;
  else if (type === "boolean") def = def === undefined ? undefined : def === true || def === "true";
  else if (type === "formatList") def = Array.isArray(def) ? strings(def) : options?.map((o: { value: string }) => o.value);
  else if (type === "file" || type === "folder") def = undefined; // locations are picked at run time
  else if (def !== undefined && def !== null) def = String(def);
  const source = typeof raw.optionsSource === "string" && OPTION_SOURCES[appId]?.includes(raw.optionsSource) ? raw.optionsSource : undefined;
  return {
    key,
    label: String(raw.label || key),
    type,
    required: raw.required !== false,
    ...(def !== undefined && def !== null ? { default: def as ParamDef["default"] } : {}),
    ...(typeof raw.help === "string" && raw.help ? { help: raw.help } : {}),
    ...(options?.length ? { options } : {}),
    ...(source ? { optionsSource: source } : {}),
    ...(type === "file" && strings(raw.extensions).length ? { extensions: strings(raw.extensions).map((e) => e.replace(/^\./, "")) } : {}),
    ...(Number.isFinite(raw.min) ? { min: raw.min } : {}),
    ...(Number.isFinite(raw.max) ? { max: raw.max } : {}),
  };
}

/** Turns the model's routine JSON into a draft, or explains what's wrong with it. */
export function toDraft(raw: Record<string, any> | undefined, appId: string, appVersion: string): RoutineDraft {
  if (!raw || typeof raw !== "object") throw new AiOutputError("The answer didn't contain a routine.");
  const script = typeof raw.script === "string" ? raw.script.trim() : "";
  if (!script) throw new AiOutputError("The routine had no script.");
  const steps = strings(raw.steps, 10);
  if (steps.length === 0) throw new AiOutputError("The routine had no steps.");
  const params = (Array.isArray(raw.params) ? raw.params : []).map((p: any) => toParam(p, appId));
  if (params.some((p: ParamDef | null) => p === null)) throw new AiOutputError("Some params had an invalid key or type.");
  const keys = new Set<string>();
  for (const p of params as ParamDef[]) {
    if (keys.has(p.key)) throw new AiOutputError(`Two params share the key "${p.key}".`);
    keys.add(p.key);
  }
  return {
    name: String(raw.name || "New routine").slice(0, 80),
    description: String(raw.description || "").slice(0, 400),
    appId,
    steps: steps.map((s) => ({ id: newId(), plainLanguage: s })),
    params: params as ParamDef[],
    script,
    appVersion,
    requiredFonts: strings(raw.requiredFonts, 10),
    modifiesDocument: raw.modifiesDocument !== false,
    qcProfile: raw.qcProfile === "web" ? "web" : "print",
    keyObjects: strings(raw.keyObjects, 2),
  };
}


/** Which edge (if any) a SAM box touches. */
function touchedEdge(b: SegmentBox): string | null {
  const mx = Math.max(2, b.w * 0.01);
  const my = Math.max(2, b.h * 0.01);
  if (b.x2 >= b.w - mx) return "right";
  if (b.x1 <= mx) return "left";
  if (b.y2 >= b.h - my) return "bottom";
  if (b.y1 <= my) return "top";
  return null;
}

const KEY_OBJECTS_LABEL = "Key objects stay inside the frame";
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Real AI: Muse Spark for writing and reviewing routines, SAM 3.1 for key-object checks. */
export class ModelAiService implements AiService {
  readonly canFixScripts = true;

  constructor(
    private readonly deps: {
      registry: AdapterRegistry;
      access: AiAccessService;
      style: StyleService;
      templates: RoutineTemplate[];
    },
  ) {}

  private async chat(request: ChatRequest, ctx: AiCallContext): Promise<Record<string, any>> {
    if (ctx.isCancelled()) throw new AiError("cancelled", "Cancelled.");
    const transport = await this.deps.access.transport();
    ctx.onAiCall();
    const result = await transport.chat(request, { creationId: ctx.creationId, onQuota: ctx.onQuota });
    if (result.finishReason === "length") throw new AiOutputError("The answer was cut off before it was complete.");
    return parseJson(result.content);
  }

  /** One retry when the answer is unusable, telling the model what was wrong. */
  private async chatWithRetry<T>(request: ChatRequest, ctx: AiCallContext, use: (json: Record<string, any>) => T): Promise<T> {
    try {
      return use(await this.chat(request, ctx));
    } catch (err) {
      if (!(err instanceof AiOutputError)) throw err;
      const retry: ChatRequest = {
        ...request,
        reasoningEffort: "low",
        messages: [
          ...request.messages,
          { role: "user", content: `Your last answer couldn't be used: ${err.message} Answer again with complete JSON matching the schema.` },
        ],
      };
      try {
        return use(await this.chat(retry, ctx));
      } catch (again) {
        if (again instanceof AiOutputError) {
          throw new AiError("ai_output", "Doppl's AI couldn't write a usable routine for this request. Try rephrasing it.", "retry");
        }
        throw again;
      }
    }
  }

  private examples(task: Task): RoutineTemplate[] {
    const text = task.request.toLowerCase();
    return this.deps.templates
      .filter((t) => t.appId === task.appId)
      .map((t) => ({ t, score: t.keywords.filter((k) => text.includes(k)).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.t);
  }

  private async baseMessages(task: Task, summary: DocumentSummary | null): Promise<ChatMessage[]> {
    const adapter = this.deps.registry.get(task.appId);
    const style = await this.deps.style.get().catch(() => null);
    return [
      { role: "system", content: systemPrompt(adapter, this.examples(task)) },
      { role: "user", content: taskMessage(task, summary, style) },
    ];
  }

  async readDocument() {
    // The document summary goes into the drafting prompt; no separate model call.
  }

  private toDraftState(json: Record<string, any>, task: Task, summary: DocumentSummary, messages: ChatMessage[]): DraftState {
    const memory = { messages: [...messages, { role: "assistant", content: JSON.stringify(json) }] };
    if (json.kind === "question" && json.question?.text && Array.isArray(json.question.options) && json.question.options.length) {
      return {
        question: {
          id: `q-${newId()}`,
          text: String(json.question.text),
          options: json.question.options.slice(0, 4).map((o: any, i: number) => ({ id: String(o.id ?? i), label: String(o.label ?? o.id) })),
        },
        memory,
      };
    }
    return { draft: toDraft(json.routine, task.appId, summary.appVersion), memory };
  }

  async draftRoutine(task: Task, summary: DocumentSummary, ctx: AiCallContext): Promise<DraftState> {
    const messages = await this.baseMessages(task, summary);
    return this.chatWithRetry(
      { messages, schema: { name: "doppl_routine", schema: DRAFT_SCHEMA }, maxTokens: ROUTINE_TOKENS, reasoningEffort: "medium" },
      ctx,
      (json) => this.toDraftState(json, task, summary, messages),
    );
  }

  async answerQuestion(task: Task, summary: DocumentSummary, state: DraftState, optionId: string, ctx: AiCallContext): Promise<DraftState> {
    const answer = state.question?.options.find((o) => o.id === optionId)?.label ?? optionId;
    const messages: ChatMessage[] = [
      ...((state.memory.messages as ChatMessage[]) ?? (await this.baseMessages(task, summary))),
      { role: "user", content: `Answer: ${answer}. Now write the routine (kind "routine").` },
    ];
    return this.chatWithRetry(
      { messages, schema: { name: "doppl_routine", schema: DRAFT_SCHEMA }, maxTokens: ROUTINE_TOKENS, reasoningEffort: "medium" },
      ctx,
      (json) => {
        const next = this.toDraftState(json, task, summary, messages);
        // Only one question: if the model asks again, the user's answer stands and we insist on a routine.
        if (next.question) throw new AiOutputError('Answer with kind "routine" now.');
        return next;
      },
    );
  }

  async fixRoutine(task: Task, summary: DocumentSummary | null, draft: RoutineDraft, failure: ScriptFailure, ctx: AiCallContext) {
    const adapter = this.deps.registry.get(task.appId);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(adapter, this.examples(task)) },
      { role: "user", content: fixMessage(task, summary, draft, failure.messages, failure.kind) },
    ];
    return this.chatWithRetry(
      { messages, schema: { name: "doppl_fixed_routine", schema: ROUTINE_SCHEMA }, maxTokens: ROUTINE_TOKENS, reasoningEffort: "medium" },
      ctx,
      (json) => toDraft(json, task.appId, draft.appVersion),
    );
  }

  async reviewTrial(task: Task, draft: RoutineDraft, outputs: RunOutput[], ctx: AiCallContext): Promise<Record<string, QcCheck[]>> {
    const checks: Record<string, QcCheck[]> = {};
    const add = (id: string, check: QcCheck) => (checks[id] ??= []).push(check);
    // Placeholders (mock apps) carry no information; only real previews are sent.
    const withImages = outputs.filter((o) => o.status === "done" && o.preview?.kind === "image").slice(0, MAX_REVIEW_IMAGES);
    if (withImages.length === 0) return checks;

    // Visual review: one call for all outputs.
    const content: ContentPart[] = [
      {
        type: "text",
        text: `Request: "${task.request}"\nRoutine: ${draft.name}\nOutputs:\n${withImages
          .map((o) => `- id ${o.id}: ${o.label}${o.qc?.checks.filter((c) => !c.passed).map((c) => ` [rule check: ${c.reason ?? c.label}]`).join("") ?? ""}`)
          .join("\n")}`,
      },
      ...withImages.flatMap((o): ContentPart[] => [
        { type: "text", text: `Output id ${o.id}:` },
        { type: "image_url", image_url: { url: o.preview!.src, detail: "low" } },
      ]),
    ];
    const review = await this.chatWithRetry(
      {
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          { role: "user", content },
        ],
        schema: { name: "doppl_review", schema: REVIEW_SCHEMA },
        maxTokens: SHORT_TOKENS,
        reasoningEffort: "low",
      },
      ctx,
      (json) => ({ issues: Array.isArray(json.issues) ? json.issues : [] }),
    );
    for (const o of withImages) {
      const issue = review.issues.find((i: any) => String(i.outputId) === o.id);
      add(o.id, { level: "visual", label: "AI visual review", passed: !issue, reason: issue ? String(issue.reason) : undefined });
    }

    // Key objects: SAM finds each object; a box touching the edge means it's cut off.
    if (draft.keyObjects?.length) {
      const transport = await this.deps.access.transport();
      for (const o of withImages) {
        let cut: string | null = null;
        try {
          for (const concept of draft.keyObjects) {
            ctx.onAiCall();
            const boxes = await transport.segment(o.preview!.src, concept, { creationId: ctx.creationId, onQuota: ctx.onQuota });
            const edge = boxes.map(touchedEdge).find(Boolean);
            if (edge) {
              cut = `${capitalize(concept)} is cut off at the ${edge} edge`;
              break;
            }
          }
        } catch (err) {
          // Out of image checks or SAM unavailable: keep the other checks, skip this one.
          if (err instanceof AiError) break;
          throw err;
        }
        add(o.id, { level: "object", label: KEY_OBJECTS_LABEL, passed: !cut, reason: cut ?? undefined });
      }
    }
    return checks;
  }

  async explainFailure(routine: Routine, failedRun: Run | null, env: EnvironmentCheck | null, ctx: AiCallContext) {
    const facts = [
      `Routine: ${routine.name} (${routine.description})`,
      failedRun ? `Error: ${failedRun.error ?? ""} ${failedRun.errorDetail ?? ""}` : "",
      env?.versionMismatch ? `Made with app version ${env.routineVersion}; now ${env.currentVersion}.` : "",
      env?.missingFonts.length ? `Missing fonts: ${env.missingFonts.join(", ")}` : "",
    ].filter(Boolean);
    const json = await this.chat(
      {
        messages: [
          { role: "system", content: EXPLAIN_SYSTEM },
          { role: "user", content: facts.join("\n") },
        ],
        schema: { name: "doppl_explanation", schema: EXPLANATION_SCHEMA },
        maxTokens: SHORT_TOKENS,
        reasoningEffort: "low",
      },
      ctx,
    ).catch((err) => {
      if (err instanceof AiOutputError) return { explanation: "" };
      throw err;
    });
    return String(json.explanation || failedRun?.errorDetail || "The routine stopped on content it didn't expect.");
  }

  async repairRoutine(routine: Routine, failedRun: Run | null, env: EnvironmentCheck | null, ctx: AiCallContext) {
    const task: Task = { id: routine.id, request: routine.description, references: [], appId: routine.appId, createdAt: routine.createdAt };
    const problems = [
      failedRun ? `The last run failed: ${failedRun.error ?? ""} ${failedRun.errorDetail ?? ""}`.trim() : "",
      env?.versionMismatch ? `It was made with app version ${env.routineVersion}; the designer now has ${env.currentVersion}.` : "",
      env?.missingFonts.length ? `These fonts are missing on this Mac: ${env.missingFonts.join(", ")}. Don't depend on them.` : "",
      "Keep the same params unless they caused the problem, so saved inputs keep working.",
    ].filter(Boolean);
    const draft: RoutineDraft = {
      name: routine.name,
      description: routine.description,
      appId: routine.appId,
      steps: routine.steps,
      params: routine.params,
      script: routine.script,
      appVersion: env?.currentVersion || routine.appVersion,
      requiredFonts: routine.requiredFonts,
      modifiesDocument: routine.modifiesDocument,
      qcProfile: routine.qcProfile,
      keyObjects: routine.keyObjects,
    };
    const repaired = await this.fixRoutine(task, null, draft, { kind: "run", messages: problems }, ctx);
    return { ...repaired, templateId: routine.templateId, builtInQc: routine.builtInQc, experimental: routine.experimental };
  }

  async reviewOutput(output: RunOutput, ctx: AiCallContext): Promise<QcCheck> {
    if (output.preview?.kind !== "image") return { level: "visual", label: "AI visual review", passed: true, reason: undefined };
    const json = await this.chatWithRetry(
      {
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: `Output id ${output.id}: ${output.label}` },
              { type: "image_url", image_url: { url: output.preview.src, detail: "low" } },
            ],
          },
        ],
        schema: { name: "doppl_review", schema: REVIEW_SCHEMA },
        maxTokens: SHORT_TOKENS,
        reasoningEffort: "low",
      },
      ctx,
      (j) => j,
    );
    const issue = (json.issues ?? [])[0];
    return { level: "visual", label: "AI visual review", passed: !issue, reason: issue ? String(issue.reason) : undefined };
  }
}

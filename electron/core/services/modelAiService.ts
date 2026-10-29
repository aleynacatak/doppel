import { codeOf } from "../ai/answer";
import { type AiGateway, type GatewayChatRequest, type Role, isModelImage } from "../ai/gateway";
import type { ReasoningEffort } from "../ai/registry";
import type { ObjectCheckDef, QcCheck, RunOutput, Task } from "../types";
import { REVIEW_SCHEMA, REVIEW_SYSTEM } from "./aiPrompts";
import type { AiCallContext, AiService, TurnOptions } from "./aiService";
import { AiError, type ChatMessage, type ContentPart, type SegmentBox } from "./aiTransport";

const TURN_TOKENS = 8000;
const CODE_TOKENS = 32000;
const SHORT_TOKENS = 1500;
const MAX_REVIEW_IMAGES = 4;

/** The model answered, but not with something Doppl can use. */
export class AiOutputError extends Error {
  constructor(
    message: string,
    /** The answer hit the length limit (thinking counts toward it) and was cut off. */
    readonly truncated = false,
    /** What the model answered. */
    readonly answer?: string,
  ) {
    super(message);
  }
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

/** The model calls of creation, refine and checks, each through its role (see ai/gateway). */
export class ModelAiService implements AiService {
  constructor(private readonly deps: { gateway: AiGateway }) {}

  private async json(role: Role, request: GatewayChatRequest, ctx: AiCallContext): Promise<Record<string, any>> {
    const res = await this.deps.gateway.chat(role, request, ctx);
    if (res.finishReason === "length") throw new AiOutputError("The answer was cut off before it was complete.", true);
    if (!res.json) throw new AiOutputError("The answer wasn't valid JSON.", false, res.text);
    return res.json;
  }

  /** One retry when the answer is unusable, telling the model what was wrong (and thinking less, so it fits). */
  private async jsonWithRetry<T>(role: Role, request: GatewayChatRequest, ctx: AiCallContext, use: (json: Record<string, any>) => T): Promise<T> {
    try {
      return use(await this.json(role, request, ctx));
    } catch (err) {
      if (!(err instanceof AiOutputError)) throw err;
      const retry: GatewayChatRequest = {
        ...request,
        effortCap: "low",
        messages: [...request.messages, { role: "user", content: `Your last answer couldn't be used: ${err.message} Answer again with complete JSON matching the schema.` }],
      };
      try {
        return use(await this.json(role, retry, ctx));
      } catch (again) {
        if (again instanceof AiOutputError && (again.truncated || err.truncated)) {
          throw new AiError("ai_output_cut", "The AI's answer was too long for one reply and got cut off, also when it tried again more briefly.", "retry");
        }
        if (again instanceof AiOutputError) {
          const answer = again.answer ?? "";
          throw new AiError("ai_output", "Doppl's AI couldn't write a usable routine for this request. Try rephrasing it.", "retry", `${again.message} The AI answered: ${answer.length > 800 ? `${answer.slice(0, 800)}…` : answer || "(nothing)"}`);
        }
        throw again;
      }
    }
  }

  fieldKey(role: Role, field: string, first: string[]) {
    return this.deps.gateway.fieldKey(role, field, first);
  }

  noteFailedTrial(creationId: string) {
    this.deps.gateway.noteFailedTrial(creationId);
  }

  modelFor(role: Role, creationId?: string) {
    return this.deps.gateway.binding(role, creationId).model;
  }

  async turn(messages: ChatMessage[], schema: { name: string; schema: Record<string, unknown> }, actions: string[], ctx: AiCallContext, options: TurnOptions = {}): Promise<Record<string, any>> {
    return this.jsonWithRetry(options.role ?? "planner", { messages, schema: { ...schema, first: options.first }, maxTokens: TURN_TOKENS }, ctx, (json) => {
      // A mangled "action" key (see aiPrompts) still names the action.
      const key = Object.keys(json).find((k) => k === "action") ?? Object.keys(json).find((k) => k.startsWith("action"));
      const action = key ? json[key] : undefined;
      if (!actions.includes(action)) throw new AiOutputError(`"action" must be ${actions.join(", ")}.`, false, JSON.stringify(json));
      return { ...json, action };
    });
  }

  async text(role: Role, messages: ChatMessage[], ctx: AiCallContext, maxTokens = CODE_TOKENS): Promise<string> {
    const res = await this.deps.gateway.chat(role, { messages, maxTokens }, ctx);
    if (res.finishReason === "length") throw new AiError("ai_output_cut", "The AI's answer was too long for one reply and got cut off.", "retry");
    return res.text;
  }

  async writeCode(messages: ChatMessage[], language: "javascript" | "json", ctx: AiCallContext): Promise<string> {
    const ask = async (msgs: ChatMessage[], effortCap?: ReasoningEffort) => {
      const res = await this.deps.gateway.chat("coder", { messages: msgs, maxTokens: CODE_TOKENS, effortCap }, ctx);
      return { code: codeOf(res.text, language), cut: res.finishReason === "length" };
    };
    const first = await ask(messages);
    if (first.code && !first.cut) return first.code;
    // Cut off (thinking counts toward the length) or empty: once more, thinking less and writing less.
    const again = await ask(
      [...messages, { role: "user", content: `Your last answer was ${first.cut ? "cut off" : "empty"}. Write the complete code again in one fenced block: shorter, no comments.` }],
      "medium",
    );
    if (again.code && !again.cut) return again.code;
    throw new AiError("ai_output_cut", "The AI's code was too long for one reply and got cut off, also when it tried again more briefly.", "retry");
  }

  async reviewTrial(task: Task, draft: { name: string; keyObjects?: string[]; customSteps?: string[] }, outputs: RunOutput[], ctx: AiCallContext): Promise<Record<string, QcCheck[]>> {
    const checks: Record<string, QcCheck[]> = {};
    const add = (id: string, check: QcCheck) => (checks[id] ??= []).push(check);
    // Only outputs with a rendered preview can be looked at.
    const withImages = outputs.filter((o) => o.status === "done" && o.preview?.kind === "image" && isModelImage(o.preview.src)).slice(0, MAX_REVIEW_IMAGES);
    if (withImages.length === 0) return checks;

    // Visual review: one call for all outputs. Steps written as custom code (no tested building block) get a closer look.
    const custom = draft.customSteps?.length
      ? `\nThese steps are custom code written for this routine, not tested building blocks; look closely at what they do to the outputs: ${draft.customSteps.map((s) => `"${s}"`).join("; ")}`
      : "";
    const content: ContentPart[] = [
      {
        type: "text",
        text: `Request: "${task.request}"\nRoutine: ${draft.name}${custom}\nOutputs:\n${withImages
          .map((o) => `- id ${o.id}: ${o.label}${o.qc?.checks.filter((c) => !c.passed).map((c) => ` [rule check: ${c.reason ?? c.label}]`).join("") ?? ""}`)
          .join("\n")}`,
      },
      ...withImages.flatMap((o): ContentPart[] => [
        { type: "text", text: `Output id ${o.id}:` },
        { type: "image_url", image_url: { url: o.preview!.src, detail: "low" } },
      ]),
    ];
    const review = await this.jsonWithRetry(
      "reviewer",
      {
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          { role: "user", content },
        ],
        schema: { name: "doppl_review", schema: REVIEW_SCHEMA },
        maxTokens: SHORT_TOKENS,
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
      for (const o of withImages) {
        let cut: string | null = null;
        try {
          for (const concept of draft.keyObjects) {
            const [boxes] = await this.deps.gateway.segment(o.preview!.src, [concept], ctx);
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

  async checkObjectInRegion(output: RunOutput, check: ObjectCheckDef, ctx: AiCallContext): Promise<QcCheck> {
    const label = `${capitalize(check.object)} is inside ${check.region}`;
    if (output.preview?.kind !== "image" || !isModelImage(output.preview.src)) return { level: "object", label, passed: true, reason: "No preview to check" };
    const [objects] = await this.deps.gateway.segment(output.preview.src, [check.object], ctx);
    if (objects.length === 0) return { level: "object", label, passed: false, reason: `Couldn't find ${check.object} in the image` };
    const [regions] = await this.deps.gateway.segment(output.preview.src, [check.region], ctx);
    if (regions.length === 0) return { level: "object", label, passed: false, reason: `Couldn't find ${check.region} in the image` };
    const inside = (o: SegmentBox, r: SegmentBox) => {
      const t = Math.max(2, o.w * 0.005);
      return o.x1 >= r.x1 - t && o.y1 >= r.y1 - t && o.x2 <= r.x2 + t && o.y2 <= r.y2 + t;
    };
    const outside = objects.filter((o) => !regions.some((r) => inside(o, r)));
    return outside.length
      ? { level: "object", label, passed: false, reason: `${capitalize(check.object)} sticks out of ${check.region}` }
      : { level: "object", label, passed: true };
  }

  async reviewOutput(output: RunOutput, ctx: AiCallContext): Promise<QcCheck> {
    if (output.preview?.kind !== "image" || !isModelImage(output.preview.src)) return { level: "visual", label: "AI visual review", passed: true, reason: undefined };
    const json = await this.jsonWithRetry(
      "reviewer",
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
      },
      ctx,
      (j) => j,
    );
    const issue = (json.issues ?? [])[0];
    return { level: "visual", label: "AI visual review", passed: !issue, reason: issue ? String(issue.reason) : undefined };
  }
}

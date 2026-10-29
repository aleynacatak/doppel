import defaultRoles from "../../ai/roles.json";
import { AiError, type ChatMessage, type TokenUsage } from "../services/aiTransport";
import type { AIProvider, CallOptions, ProviderChatResult } from "./providers";
import { type ModelEntry, type ModelRegistry, type ProviderEntry, type ReasoningEffort, costOf, orderFields } from "./registry";

// Every AI call goes through a role, never a hard-coded model:
//   planner ... understanding requests, inspection, flow plans, questions, refine planning (the structured turns)
//   coder ..... writing scripts and Figma action lists
//   reviewer .. judging preview images and outputs (vision)
//   segmenter . object segmentation for checks (SAM)
// A role maps to a model profile (electron/ai/roles.json, overridable in settings or by an eval profile); the
// registry says what the model can do and which provider serves it. The gateway enforces the data policy, applies
// quirks and reasoning effort, counts usage and cost per role, and can escalate a role for the rest of a creation.

export type Role = "planner" | "coder" | "reviewer" | "segmenter";
export const ROLES: Role[] = ["planner", "coder", "reviewer", "segmenter"];

/** A model profile: which model, and how hard it thinks. */
export interface RoleBinding {
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
}

export interface EscalationRule {
  /** After this many failed trials in one creation… */
  afterFailedTrials: number;
  /** …the role uses this profile for the rest of that creation. */
  to: RoleBinding;
}

export interface RoleConfig extends Record<Role, RoleBinding> {
  escalation?: Partial<Record<Role, EscalationRule>>;
}

export const DEFAULT_ROLES = defaultRoles as RoleConfig;

/** Roles with overrides (settings, an eval profile) on top. */
export function mergeRoles(base: RoleConfig, ...overrides: (Partial<RoleConfig> | undefined)[]): RoleConfig {
  const out: RoleConfig = { ...base, escalation: { ...(base.escalation ?? {}) } };
  for (const o of overrides) {
    if (!o) continue;
    for (const r of ROLES) if (o[r]) out[r] = { ...o[r]! };
    if (o.escalation) out.escalation = { ...out.escalation, ...o.escalation };
  }
  return out;
}

export interface UsageRecord {
  role: Role;
  model: string;
  provider: string;
  usage: TokenUsage | null;
  costUsd: number;
  /** Chat answers: the effort asked for, why the answer ended and its text (for the dev panel and evals). */
  effort?: ReasoningEffort;
  finishReason?: string | null;
  text?: string;
}

export interface GatewayContext {
  onAiCall: () => void;
  isCancelled: () => boolean;
  creationId?: string;
  onQuota?: CallOptions["onQuota"];
  onUsage?: (u: UsageRecord) => void;
}

export interface GatewayChatRequest {
  messages: ChatMessage[];
  /** Structured output; `first` fields are written before the rest (plans before code). */
  schema?: { name: string; schema: Record<string, unknown>; first?: string[] };
  maxTokens: number;
  /** A lower effort than the role's (e.g. a retry for a shorter answer). */
  effortCap?: ReasoningEffort;
  /**
   * "public" only when nothing in the request comes from the designer's files, documents or screenshots. Models that
   * train on data are never used for anything else.
   */
  dataClass?: "user" | "public";
}

export interface GatewayResult {
  /** The answer as text. */
  text: string;
  /** With a schema: the answer as JSON, with canonical field names. */
  json?: Record<string, any>;
  finishReason: string | null;
  model: ModelEntry;
}

export interface Routing {
  registry: () => ModelRegistry;
  roles: () => RoleConfig;
  /** The provider adapter for a model (by the designer's access: demo Worker, own key, custom endpoint). */
  provider: (model: ModelEntry) => Promise<{ adapter: AIProvider; entry: ProviderEntry }>;
  /** Monthly spend per provider: refuses a call over the limit, adds what a call cost. */
  spend?: { check: (providerId: string) => void; add: (providerId: string, usd: number) => Promise<void> | void };
}

const EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The wanted effort, or the closest the model supports below it (never above). */
export function effortFor(model: ModelEntry, wanted?: ReasoningEffort, cap?: ReasoningEffort): ReasoningEffort | undefined {
  const supported = model.capabilities.reasoningEffort;
  // No effort of its own (the model's default): a cap still asks for less thinking.
  const asked = wanted ?? cap;
  if (!asked || !supported?.length) return undefined;
  let rank = EFFORTS.indexOf(asked);
  if (cap) rank = Math.min(rank, EFFORTS.indexOf(cap));
  for (let r = rank; r >= 0; r--) if (supported.includes(EFFORTS[r])) return EFFORTS[r];
  return supported[0];
}

const hasImages = (messages: ChatMessage[]) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));

/** Images a model can read: PNG, JPEG, WebP or GIF data, or a web address. (SVG previews are refused with a 400.) */
export const isModelImage = (src: string) => /^(data:image\/(png|jpe?g|webp|gif)[;,]|https?:\/\/)/i.test(src);

/** Swaps images the model can't read (any image, for a model without vision) for a short note. */
export function readableImages(messages: ChatMessage[], vision: boolean): ChatMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === "image_url" && (!vision || !isModelImage(p.image_url.url)))
      ? {
          ...m,
          content: m.content.map((p) =>
            p.type === "image_url" && (!vision || !isModelImage(p.image_url.url)) ? { type: "text" as const, text: "(An image was left out: the model can't read it.)" } : p,
          ),
        }
      : m,
  );
}

/** JSON from a model answer: fences, text around it and trailing commas are tolerated. */
export function parseJsonAnswer(content: string): Record<string, any> | null {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  for (const text of [body, body.replace(/,(\s*[}\]])/g, "$1")]) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      // Try the repaired text.
    }
  }
  return null;
}

export class AiGateway {
  /** Failed trials per creation, for escalation. */
  private failures = new Map<string, number>();

  constructor(private readonly routing: Routing) {}

  /** The profile a role uses now (escalated for this creation if its rule says so). */
  binding(role: Role, creationId?: string): RoleBinding {
    const roles = this.routing.roles();
    const rule = roles.escalation?.[role];
    if (rule && creationId && (this.failures.get(creationId) ?? 0) >= rule.afterFailedTrials) return rule.to;
    return roles[role];
  }

  model(role: Role, creationId?: string): ModelEntry {
    return this.routing.registry().model(this.binding(role, creationId).model);
  }

  /** The name the role's model sees for a canonical schema field (prefixed for alphabetical-field models). */
  fieldKey(role: Role, field: string, first: string[]): string {
    return orderFields({ properties: Object.fromEntries(first.map((f) => [f, {}])) }, first, this.model(role).quirks).keyFor(field);
  }

  noteFailedTrial(creationId: string) {
    this.failures.set(creationId, (this.failures.get(creationId) ?? 0) + 1);
  }

  forget(creationId: string) {
    this.failures.delete(creationId);
  }

  private guard(model: ModelEntry, messages: ChatMessage[], dataClass: "user" | "public" = "user") {
    if (!model.enabled) throw new AiError("model_disabled", `${model.displayName} isn't enabled in Doppl.`, "settings");
    if (model.dataPolicy.trainsOnData && (dataClass !== "public" || hasImages(messages))) {
      throw new AiError(
        "data_policy",
        `${model.displayName} may train on what it's sent, so Doppl never sends it your files, documents or screenshots. Pick another model for this role.`,
        "settings",
      );
    }
  }

  async chat(role: Role, req: GatewayChatRequest, ctx: GatewayContext): Promise<GatewayResult> {
    if (ctx.isCancelled()) throw new AiError("cancelled", "Cancelled.");
    const binding = this.binding(role, ctx.creationId);
    const model = this.routing.registry().model(binding.model);
    this.guard(model, req.messages, req.dataClass);
    const { adapter, entry } = await this.routing.provider(model);
    this.routing.spend?.check(entry.id);

    let messages = readableImages(req.messages, model.capabilities.vision === true);
    let schema: { name: string; schema: Record<string, unknown> } | undefined;
    let mapBack = (j: Record<string, any>) => j;
    if (req.schema) {
      const ordered = orderFields(req.schema.schema, req.schema.first ?? [], model.quirks);
      mapBack = ordered.fromModel;
      if (model.capabilities.structuredOutput) schema = { name: req.schema.name, schema: ordered.schema };
      else {
        // No native structured output: ask for the JSON in the prompt; the answer is parsed and repaired below.
        messages = [
          ...messages,
          { role: "system", content: `Answer with ONE JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(ordered.schema)}` },
        ];
      }
    }
    const maxTokens = Math.min(req.maxTokens, binding.maxOutputTokens ?? Infinity, entry.maxOutputTokens ?? Infinity);
    ctx.onAiCall();
    const effort = effortFor(model, binding.reasoningEffort, req.effortCap);
    let result: ProviderChatResult;
    try {
      result = await adapter.chat(
        { model: model.apiModel ?? model.id, messages, schema, reasoningEffort: effort, maxTokens },
        { creationId: ctx.creationId, onQuota: ctx.onQuota },
      );
    } catch (err) {
      ctx.onUsage?.({ role, model: model.id, provider: entry.id, usage: null, costUsd: 0 });
      throw err;
    }
    // Without usage (an interrupted stream), assume the full output allowance so spend limits stay safe.
    const cost = costOf(model, result.usage ?? { input: 0, cached: 0, output: maxTokens });
    if (entry.kind !== "doppl-demo") await this.routing.spend?.add(entry.id, cost);
    ctx.onUsage?.({ role, model: model.id, provider: entry.id, usage: result.usage, costUsd: cost, effort, finishReason: result.finishReason, text: result.content });
    const out: GatewayResult = { text: result.content, finishReason: result.finishReason, model };
    if (req.schema) {
      const json = parseJsonAnswer(result.content);
      if (json) out.json = mapBack(json);
    }
    return out;
  }

  /** Boxes per prompt in one image (segmenter role). */
  async segment(image: string, prompts: string[], ctx: GatewayContext) {
    if (ctx.isCancelled()) throw new AiError("cancelled", "Cancelled.");
    const model = this.routing.registry().model(this.binding("segmenter", ctx.creationId).model);
    this.guard(model, [], "user");
    if (!model.capabilities.segmentation) throw new AiError("unsupported", `${model.displayName} can't segment images.`, "settings");
    const { adapter, entry } = await this.routing.provider(model);
    if (!adapter.segment) throw new AiError("unsupported", `${entry.displayName} can't segment images.`, "settings");
    this.routing.spend?.check(entry.id);
    const out = [];
    for (const prompt of prompts) {
      ctx.onAiCall();
      const [boxes] = await adapter.segment({ model: model.apiModel ?? model.id, image, prompts: [prompt] }, { creationId: ctx.creationId, onQuota: ctx.onQuota });
      const cost = costOf(model, null, 1);
      if (entry.kind !== "doppl-demo") await this.routing.spend?.add(entry.id, cost);
      ctx.onUsage?.({ role: "segmenter", model: model.id, provider: entry.id, usage: null, costUsd: cost });
      out.push(boxes ?? []);
    }
    return out;
  }
}

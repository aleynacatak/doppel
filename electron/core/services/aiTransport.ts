import { net } from "electron";
import type { AiErrorAction, DemoSession } from "../types";

// How AI requests leave the app (main process only). Two transports with the same interface:
//   DopplDemoTransport → the Doppl demo Worker, authenticated with an access code
//   MetaDirectTransport → Meta's Model API, authenticated with the designer's own key
// Request shapes follow https://dev.meta.ai/docs (Chat Completions, Responses for SAM).

export const CHAT_MODEL = "muse-spark-1.3";
export const SAM_MODEL = "sam-3.1";
export const META_API_BASE = "https://api.meta.ai/v1";

// USD, for own-key spend estimates (dev.meta.ai/docs/pricing-rate-limits).
const PRICE = { inputPerM: 1.25, cachedInputPerM: 0.15, outputPerM: 4.25, samPer1kImages: 2.5 };

export class AiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: AiErrorAction = "retry",
  ) {
    super(message);
    this.name = "AiError";
  }
}

const SETTINGS_CODES = new Set([
  "no_access",
  "invalid_code",
  "code_expired",
  "code_revoked",
  "own_key_invalid",
  "own_key_billing",
  "own_key_forbidden",
  "spend_limit",
]);

export function actionFor(code: string): AiErrorAction {
  if (SETTINGS_CODES.has(code)) return "settings";
  if (code === "quota_exhausted" || code === "demo_paused") return "own-key";
  if (code === "creation_call_limit") return "start-over";
  return "retry";
}

const offline = () =>
  new AiError("offline", "Doppl can't reach its AI service. Check your internet connection and try again.", "retry");

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Structured output (response_format json_schema). */
  schema: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  usage: TokenUsage | null;
}

export interface SegmentBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

export interface QuotaUpdate {
  creations: { used: number; max: number };
  samImages: { used: number; max: number };
}

export interface CallOptions {
  /** One id per routine creation or repair (the demo Worker counts creations by it). */
  creationId?: string;
  onQuota?: (quota: QuotaUpdate) => void;
}

export interface AiTransport {
  readonly provider: "doppl-demo" | "meta-api";
  chat(request: ChatRequest, options: CallOptions): Promise<ChatResult>;
  segment(imageDataUrl: string, concept: string, options: CallOptions): Promise<SegmentBox[]>;
}

// ---------- Request bodies ----------

function chatBody(req: ChatRequest) {
  return {
    model: CHAT_MODEL,
    messages: req.messages,
    max_completion_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    response_format: { type: "json_schema", json_schema: { name: req.schema.name, schema: req.schema.schema } },
    ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
  };
}

function samBody(imageDataUrl: string, concept: string) {
  return {
    model: SAM_MODEL,
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: concept },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
  };
}

// ---------- Streaming ----------

/** Calls `onEvent` with every JSON `data:` payload of a server-sent-events body. */
async function readSse(res: Response, onEvent: (event: Record<string, unknown>) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      // Ignore keep-alives and partial lines.
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
    }
  }
  handle(buffer.trim());
}

function toUsage(u: unknown): TokenUsage | null {
  if (!u || typeof u !== "object") return null;
  const usage = u as Record<string, any>;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const cached = Number((usage.prompt_tokens_details ?? usage.input_tokens_details)?.cached_tokens ?? 0);
  return { input, cached: Math.min(cached, input), output: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) };
}

async function collectChat(res: Response): Promise<ChatResult> {
  let content = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const data = (await res.json()) as Record<string, any>;
    return { content: data.choices?.[0]?.message?.content ?? "", finishReason: data.choices?.[0]?.finish_reason ?? null, usage: toUsage(data.usage) };
  }
  await readSse(res, (event) => {
    const choice = (event.choices as any[] | undefined)?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) usage = toUsage(event.usage);
  });
  return { content, finishReason, usage };
}

/** SAM streams its result as text tokens; boxes look like <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>. */
export function parseBoxes(text: string): SegmentBox[] {
  const boxes: SegmentBox[] = [];
  const re = /<\|box;x1=([\d.]+);y1=([\d.]+);x2=([\d.]+);y2=([\d.]+);w=([\d.]+);h=([\d.]+)/g;
  for (const m of text.matchAll(re)) {
    const [x1, y1, x2, y2, w, h] = m.slice(1).map(Number);
    boxes.push({ x1, y1, x2, y2, w, h });
  }
  return boxes;
}

async function collectSegment(res: Response): Promise<SegmentBox[]> {
  let text = "";
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const data = (await res.json()) as Record<string, any>;
    for (const item of data.output ?? []) for (const part of item.content ?? []) if (part.type === "output_text") text += part.text;
    return parseBoxes(text);
  }
  await readSse(res, (event) => {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
  });
  return parseBoxes(text);
}

function chatCost(u: TokenUsage) {
  return (Math.max(u.input - u.cached, 0) * PRICE.inputPerM + u.cached * PRICE.cachedInputPerM + u.output * PRICE.outputPerM) / 1e6;
}

// ---------- Demo Worker ----------

function readQuota(headers: Headers): QuotaUpdate | null {
  const n = (name: string) => Number(headers.get(name));
  if (!headers.has("x-doppl-creations-max")) return null;
  return {
    creations: { used: n("x-doppl-creations-used"), max: n("x-doppl-creations-max") },
    samImages: { used: n("x-doppl-sam-images-used"), max: n("x-doppl-sam-images-max") },
  };
}

async function workerError(res: Response): Promise<AiError> {
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const code = data?.error?.code ?? "upstream_error";
  return new AiError(code, data?.error?.message ?? `The demo service returned an error (status ${res.status}).`, actionFor(code));
}

export class DopplDemoTransport implements AiTransport {
  readonly provider = "doppl-demo" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly getCode: () => Promise<string | null>,
  ) {}

  private async post(path: string, body: unknown, options: CallOptions): Promise<Response> {
    const code = await this.getCode();
    if (!code) throw new AiError("no_access", "Add your demo access code in Settings → AI access.", "settings");
    let res: Response;
    try {
      res = await net.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${code}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(options.creationId ? { "x-doppl-creation-id": options.creationId } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw offline();
    }
    const quota = readQuota(res.headers);
    if (quota) options.onQuota?.(quota);
    if (!res.ok) throw await workerError(res);
    return res;
  }

  async chat(request: ChatRequest, options: CallOptions) {
    return collectChat(await this.post("/v1/chat", chatBody(request), options));
  }

  async segment(imageDataUrl: string, concept: string, options: CallOptions) {
    return collectSegment(await this.post("/v1/segment", samBody(imageDataUrl, concept), options));
  }
}

/** Validates an access code and returns its remaining quota (POST /v1/session). */
export async function fetchDemoSession(baseUrl: string, code: string): Promise<DemoSession> {
  let res: Response;
  try {
    res = await net.fetch(`${baseUrl}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${code.trim()}` } });
  } catch {
    throw offline();
  }
  if (!res.ok) throw await workerError(res);
  const data = (await res.json()) as Omit<DemoSession, "checkedAt">;
  return { ...data, checkedAt: new Date().toISOString() };
}

// ---------- Own Meta API key ----------

async function metaError(res: Response): Promise<AiError> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const detail = data?.error?.message ? ` (${data.error.message.slice(0, 200)})` : "";
  switch (res.status) {
    case 401:
      return new AiError("own_key_invalid", "Meta didn't accept your API key. Check it in Settings → AI access.", "settings");
    case 402:
      return new AiError("own_key_billing", "Your Meta account needs billing set up before this key can be used.", "settings");
    case 403:
      return new AiError("own_key_forbidden", "Your Meta API key doesn't have access to this model.", "settings");
    case 429:
      return new AiError("rate_limited", "Meta's API is rate limiting your key. Wait a minute and try again.", "retry");
    default:
      return new AiError("upstream_error", `Meta's AI service returned an error (status ${res.status})${detail}.`, "retry");
  }
}

export interface SpendTracker {
  /** 0 = no limit */
  limit(): number;
  spent(): number;
  add(usd: number): Promise<void>;
}

export class MetaDirectTransport implements AiTransport {
  readonly provider = "meta-api" as const;

  constructor(
    private readonly getKey: () => Promise<string | null>,
    private readonly spend: SpendTracker,
    private readonly baseUrl = META_API_BASE,
  ) {}

  private async post(path: string, body: unknown): Promise<Response> {
    const key = await this.getKey();
    if (!key) throw new AiError("no_access", "Add your Meta API key in Settings → AI access.", "settings");
    const limit = this.spend.limit();
    if (limit > 0 && this.spend.spent() >= limit) {
      throw new AiError("spend_limit", "You've reached this month's spend limit for your own key. Raise it in Settings → AI access.", "settings");
    }
    let res: Response;
    try {
      res = await net.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
    } catch {
      throw offline();
    }
    if (!res.ok) throw await metaError(res);
    return res;
  }

  async chat(request: ChatRequest) {
    const result = await collectChat(await this.post("/chat/completions", chatBody(request)));
    // Without usage (interrupted stream), assume the full output allowance.
    await this.spend.add(chatCost(result.usage ?? { input: 0, cached: 0, output: request.maxTokens }));
    return result;
  }

  async segment(imageDataUrl: string, concept: string) {
    const boxes = await collectSegment(await this.post("/responses", samBody(imageDataUrl, concept)));
    await this.spend.add(PRICE.samPer1kImages / 1000);
    return boxes;
  }
}

/** Checks a key with GET /v1/models (no tokens used). */
export async function checkMetaKey(key: string, baseUrl = META_API_BASE): Promise<void> {
  let res: Response;
  try {
    res = await net.fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key.trim()}` } });
  } catch {
    throw offline();
  }
  if (!res.ok) throw await metaError(res);
}

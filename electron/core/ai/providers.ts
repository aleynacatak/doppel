import { AiError, type ChatMessage, type QuotaUpdate, type SegmentBox, type TokenUsage, actionFor } from "../services/aiTransport";

// Provider adapters: one interface for every way a model is reached. They normalize request and response formats,
// streaming, usage, timeouts, retries (rate limits and server errors, with backoff) and errors (Doppl's AiError
// codes). Implemented: "openai-compatible" (Meta's Model API, and by base URL OpenRouter, Fireworks, Baseten, Ollama,
// LM Studio…) and "doppl-demo" (the Doppl demo Worker). Native adapters for other APIs can implement AIProvider later.

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface ProviderChatRequest {
  /** The id the provider expects. */
  model: string;
  messages: ChatMessage[];
  /** Native structured output; when the model has none, the gateway asks for JSON in the prompt instead. */
  schema?: { name: string; schema: Record<string, unknown> };
  reasoningEffort?: string;
  maxTokens: number;
  tools?: unknown[];
}

export interface ProviderChatResult {
  content: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  toolCalls?: { name: string; arguments: string }[];
}

export interface CallOptions {
  /** One id per routine creation or repair (the demo Worker counts creations by it). */
  creationId?: string;
  onQuota?: (quota: QuotaUpdate) => void;
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly id: string;
  chat(req: ProviderChatRequest, options: CallOptions): Promise<ProviderChatResult>;
  segment?(req: { model: string; image: string; prompts: string[] }, options: CallOptions): Promise<SegmentBox[][]>;
}

export interface ProviderSettings {
  timeoutMs?: number;
  retries?: number;
  /** Base delay for retries (ms); doubled each time. */
  backoffMs?: number;
  fetch?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 240_000;

const offline = () => new AiError("offline", "Doppl can't reach its AI service. Check your internet connection and try again.", "retry");

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AiError("cancelled", "Cancelled."));
    });
  });

// ---------- Responses ----------

function toUsage(u: unknown): TokenUsage | null {
  if (!u || typeof u !== "object") return null;
  const usage = u as Record<string, any>;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const cached = Number((usage.prompt_tokens_details ?? usage.input_tokens_details)?.cached_tokens ?? 0);
  return { input, cached: Math.min(cached, input), output: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) };
}

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

/** A chat completion, streamed or not, as one result. */
export async function collectChat(res: Response): Promise<ProviderChatResult> {
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    const data = (await res.json()) as Record<string, any>;
    const message = data.choices?.[0]?.message ?? {};
    return {
      content: message.content ?? "",
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage: toUsage(data.usage),
      ...(Array.isArray(message.tool_calls) ? { toolCalls: message.tool_calls.map((c: any) => ({ name: c.function?.name, arguments: c.function?.arguments ?? "" })) } : {}),
    };
  }
  let content = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  const calls: { name: string; arguments: string }[] = [];
  await readSse(res, (event) => {
    const choice = (event.choices as any[] | undefined)?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const i = Number(tc.index ?? 0);
      calls[i] ??= { name: "", arguments: "" };
      if (tc.function?.name) calls[i].name = tc.function.name;
      if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) usage = toUsage(event.usage);
  });
  return { content, finishReason, usage, ...(calls.length ? { toolCalls: calls } : {}) };
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

function chatBody(req: ProviderChatRequest, extra: Record<string, unknown>) {
  return {
    model: req.model,
    messages: req.messages,
    max_completion_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...extra,
    ...(req.schema ? { response_format: { type: "json_schema", json_schema: { name: req.schema.name, schema: req.schema.schema } } } : {}),
    ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    ...(req.tools?.length ? { tools: req.tools } : {}),
  };
}

const samBody = (model: string, image: string, concept: string) => ({
  model,
  stream: true,
  store: false,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: concept }, { type: "input_image", image_url: image }] }],
});

// ---------- Errors ----------

async function errorBody(res: Response): Promise<{ code?: string; message?: string }> {
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } | string } | null;
  if (!data?.error) return {};
  return typeof data.error === "string" ? { message: data.error } : data.error;
}

/** Meta's Model API, or any OpenAI-compatible endpoint, in Doppl's error codes. */
async function endpointError(res: Response, provider: { id: string; displayName: string }): Promise<AiError> {
  const body = await errorBody(res);
  const detail = body.message ? ` (${body.message.slice(0, 200)})` : "";
  const own = provider.id === "meta";
  const name = own ? "Meta" : provider.displayName;
  switch (res.status) {
    case 401:
      return own
        ? new AiError("own_key_invalid", "Meta didn't accept your API key. Check it in Settings → AI access.", "settings")
        : new AiError("provider_key_invalid", `${name} didn't accept the key. Check it in Settings → Advanced → AI models.`, "settings");
    case 402:
      return new AiError(own ? "own_key_billing" : "provider_billing", `Your ${name} account needs billing set up before this key can be used.`, "settings");
    case 403:
      return new AiError(own ? "own_key_forbidden" : "provider_forbidden", `Your ${name} key doesn't have access to this model.`, "settings");
    case 404:
      return new AiError("model_not_found", `${name} doesn't know this model${detail}. Check the model id.`, "settings");
    case 429:
      return new AiError("rate_limited", `${name} is rate limiting requests. Wait a minute and try again.`, "retry");
    default:
      return new AiError("upstream_error", `${name}'s AI service returned an error (status ${res.status})${detail}.`, "retry");
  }
}

/** The Doppl demo Worker's own error codes. */
async function workerError(res: Response): Promise<AiError> {
  const body = await errorBody(res);
  const code = body.code ?? "upstream_error";
  return new AiError(code, body.message ?? `The demo service returned an error (status ${res.status}).`, actionFor(code));
}

const retryable = (status: number) => status === 429 || status >= 500;

/** POST with a timeout, and retries with backoff on rate limits and server errors (honoring Retry-After). */
async function post(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  settings: Required<Pick<ProviderSettings, "timeoutMs" | "retries" | "backoffMs">>,
  options: CallOptions,
  canRetry: (status: number) => boolean,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new AiError("cancelled", "Cancelled.");
    const timeout = AbortSignal.timeout(settings.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (options.signal?.aborted) throw new AiError("cancelled", "Cancelled.");
      if (timeout.aborted) throw new AiError("timeout", "The AI service took too long to answer. Try again.", "retry");
      if (attempt < settings.retries) {
        await sleep(settings.backoffMs * 2 ** attempt, options.signal);
        continue;
      }
      throw offline();
    }
    if (res.ok || !canRetry(res.status) || attempt >= settings.retries) return res;
    const after = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : settings.backoffMs * 2 ** attempt, options.signal);
  }
}

const defaults = (s: ProviderSettings, fallbackFetch: FetchLike) => ({
  timeoutMs: s.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  retries: s.retries ?? 2,
  backoffMs: s.backoffMs ?? 1000,
  fetch: s.fetch ?? fallbackFetch,
});

// ---------- Adapters ----------

/** Meta's Model API and other OpenAI-compatible endpoints (Chat Completions; SAM through the Responses API). */
export class OpenAICompatibleProvider implements AIProvider {
  private readonly s: ReturnType<typeof defaults>;

  constructor(
    private readonly entry: { id: string; displayName: string; baseUrl: string; segmentPath?: string },
    private readonly getKey: () => Promise<string | null>,
    settings: ProviderSettings & { fetch: FetchLike },
  ) {
    this.s = defaults(settings, settings.fetch);
  }

  get id() {
    return this.entry.id;
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.getKey();
    // Meta needs a key; local servers (Ollama, LM Studio) usually don't.
    if (!key && this.entry.id === "meta") throw new AiError("no_access", "Add your Meta API key in Settings → AI access.", "settings");
    return { "content-type": "application/json", accept: "text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }

  async chat(req: ProviderChatRequest, options: CallOptions): Promise<ProviderChatResult> {
    // `store: false` keeps requests out of Meta's stored logs; other endpoints may not know the field.
    const res = await post(this.s.fetch, `${this.entry.baseUrl}/chat/completions`, await this.headers(), chatBody(req, this.entry.id === "meta" ? { store: false } : {}), this.s, options, retryable);
    if (!res.ok) throw await endpointError(res, this.entry);
    return collectChat(res);
  }

  async segment(req: { model: string; image: string; prompts: string[] }, options: CallOptions): Promise<SegmentBox[][]> {
    if (!this.entry.segmentPath) throw new AiError("unsupported", `${this.entry.displayName} can't segment images.`, "settings");
    const out: SegmentBox[][] = [];
    for (const prompt of req.prompts) {
      const res = await post(this.s.fetch, `${this.entry.baseUrl}${this.entry.segmentPath}`, await this.headers(), samBody(req.model, req.image, prompt), this.s, options, retryable);
      if (!res.ok) throw await endpointError(res, this.entry);
      out.push(await collectSegment(res));
    }
    return out;
  }
}

/** The Doppl demo Worker: Meta's models with an access code, quotas counted per creation. */
export class DopplDemoProvider implements AIProvider {
  readonly id = "doppl-demo";
  private readonly s: ReturnType<typeof defaults>;

  constructor(
    private readonly baseUrl: string,
    private readonly getCode: () => Promise<string | null>,
    settings: ProviderSettings & { fetch: FetchLike },
  ) {
    this.s = defaults(settings, settings.fetch);
  }

  private async headers(options: CallOptions): Promise<Record<string, string>> {
    const code = await this.getCode();
    if (!code) throw new AiError("no_access", "Add your demo access code in Settings → AI access.", "settings");
    return {
      authorization: `Bearer ${code}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(options.creationId ? { "x-doppl-creation-id": options.creationId } : {}),
    };
  }

  private readQuota(res: Response, options: CallOptions) {
    const n = (name: string) => Number(res.headers.get(name));
    if (!res.headers.has("x-doppl-creations-max")) return;
    options.onQuota?.({
      creations: { used: n("x-doppl-creations-used"), max: n("x-doppl-creations-max") },
      samImages: { used: n("x-doppl-sam-images-used"), max: n("x-doppl-sam-images-max") },
    });
  }

  async chat(req: ProviderChatRequest, options: CallOptions): Promise<ProviderChatResult> {
    // Every attempt counts against the creation's calls at the Worker: only rate limits are retried.
    const res = await post(this.s.fetch, `${this.baseUrl}/v1/chat`, await this.headers(options), chatBody(req, {}), this.s, options, (status) => status === 429);
    this.readQuota(res, options);
    if (!res.ok) throw await workerError(res);
    return collectChat(res);
  }

  async segment(req: { model: string; image: string; prompts: string[] }, options: CallOptions): Promise<SegmentBox[][]> {
    const out: SegmentBox[][] = [];
    for (const prompt of req.prompts) {
      const res = await post(this.s.fetch, `${this.baseUrl}/v1/segment`, await this.headers(options), samBody(req.model, req.image, prompt), this.s, options, (status) => status === 429);
      this.readQuota(res, options);
      if (!res.ok) throw await workerError(res);
      out.push(await collectSegment(res));
    }
    return out;
  }
}

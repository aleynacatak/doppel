import { type AccessCode } from "./codes";
import { type Env, list, num } from "./env";
import { ApiError, MESSAGES, json } from "./errors";
import { chargeCreationCall, chargeSamImages, quotaHeaders, recordUsage, refundSamImages } from "./quota";

// Thin proxy to Meta's Model API (https://dev.meta.ai/docs):
//   POST /v1/chat     → POST {META_API_BASE_URL}/chat/completions   (OpenAI-compatible)
//   POST /v1/segment  → POST {META_API_BASE_URL}/responses          (sam-3.1, images only)
// Only allowlisted request fields are forwarded, `store` is always false (testers may send client
// files), and the tester's Authorization header is replaced by the Worker's key.

type Json = Record<string, unknown>;

const CREATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function readJsonBody(request: Request, maxBytes: number): Promise<Json> {
  const tooLarge = new ApiError("request_too_large", MESSAGES.request_too_large(Math.round(maxBytes / 1048576)));
  const declared = Number(request.headers.get("content-length"));
  if (declared && declared > maxBytes) throw tooLarge;
  if (!request.body) throw new ApiError("bad_request", "The request body is empty.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Json;
  } catch {
    throw new ApiError("bad_request", "The request body isn't valid JSON.");
  }
}

// ---------- Usage and cost ----------

interface Usage {
  input: number;
  cached: number;
  output: number;
}

/** Chat Completions usage (prompt/completion tokens) or Responses usage (input/output tokens). */
export function normalizeUsage(u: unknown): Usage | null {
  if (!u || typeof u !== "object") return null;
  const usage = u as Json;
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Json | undefined;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cached = Number(details?.cached_tokens ?? 0);
  return { input, cached: Math.min(cached, input), output };
}

export function chatCost(env: Env, usage: Usage): number {
  const uncached = Math.max(usage.input - usage.cached, 0);
  return (
    (uncached * num(env.PRICE_INPUT_PER_M, 1.25) +
      usage.cached * num(env.PRICE_CACHED_INPUT_PER_M, 0.15) +
      usage.output * num(env.PRICE_OUTPUT_PER_M, 4.25)) /
    1_000_000
  );
}

/** Pulls `usage` out of one SSE line: a chat chunk, or a Responses `response.completed` event. */
function usageFromSseLine(line: string): Usage | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const event = JSON.parse(payload) as Json;
    return normalizeUsage(event.usage ?? (event.response as Json | undefined)?.usage);
  } catch {
    return null;
  }
}

/**
 * Streams the upstream body to the app unchanged while watching for the usage block.
 * Keeps reading upstream even if the app disconnects, so the cost is still recorded.
 */
function passThroughStream(
  upstream: Response,
  headers: Record<string, string>,
  ctx: ExecutionContext,
  onDone: (usage: Usage | null) => Promise<void>,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const work = (async () => {
    const reader = upstream.body!.getReader();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: Usage | null = null;
    let clientGone = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!clientGone) {
          try {
            await writer.write(value);
          } catch {
            clientGone = true;
          }
        }
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          usage = usageFromSseLine(buffer.slice(0, newline).trim()) ?? usage;
          buffer = buffer.slice(newline + 1);
        }
      }
      usage = usageFromSseLine(buffer.trim()) ?? usage;
    } finally {
      if (!clientGone) await writer.close().catch(() => undefined);
      await onDone(usage);
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, {
    status: upstream.status,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...headers },
  });
}

async function upstreamError(res: Response): Promise<ApiError> {
  let detail: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string; type?: string; code?: string } };
    detail = body.error?.message?.slice(0, 300);
  } catch {
    // Empty or non-JSON body.
  }
  return new ApiError("upstream_error", MESSAGES.upstream_error(res.status), {
    upstreamStatus: res.status,
    ...(detail ? { upstreamMessage: detail } : {}),
  });
}

async function callUpstream(env: Env, path: string, body: Json, stream: boolean): Promise<Response> {
  try {
    return await fetch(`${env.META_API_BASE_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${env.META_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("upstream_error", "Meta's AI service couldn't be reached. Try again in a moment.", { upstreamStatus: 0 });
  }
}

// ---------- Chat ----------

const CHAT_PASSTHROUGH = ["messages", "response_format", "temperature", "top_p", "reasoning_effort", "stop"] as const;

export function sanitizeChat(body: Json, env: Env): Json {
  const model = String(body.model ?? "");
  if (!list(env.ALLOWED_CHAT_MODELS).includes(model)) throw new ApiError("model_not_allowed", MESSAGES.model_not_allowed);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError("bad_request", "The request needs at least one message.");
  }
  const maxOutput = num(env.MAX_OUTPUT_TOKENS, 8000);
  // `max_tokens` is deprecated in favor of `max_completion_tokens`; accept either, send one, clamp it.
  const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? maxOutput);
  const out: Json = {
    model,
    max_completion_tokens: Math.max(1, Math.min(Number.isFinite(requested) ? requested : maxOutput, maxOutput)),
    store: false,
    n: 1,
  };
  for (const key of CHAT_PASSTHROUGH) if (body[key] !== undefined) out[key] = body[key];
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

export async function handleChat(request: Request, env: Env, ctx: ExecutionContext, code: AccessCode): Promise<Response> {
  const creationId = request.headers.get("x-doppl-creation-id") ?? "";
  if (!CREATION_ID.test(creationId)) {
    throw new ApiError("bad_request", "Missing X-Doppl-Creation-Id header (one id per routine creation).");
  }
  const body = sanitizeChat(await readJsonBody(request, num(env.MAX_REQUEST_BYTES, 10485760)), env);
  await chargeCreationCall(env, code, creationId);

  const stream = body.stream === true;
  const res = await callUpstream(env, "/chat/completions", body, stream);
  const base = { codeId: code.id, creationId, kind: "chat" as const, model: String(body.model), images: 0 };

  if (!res.ok) {
    await recordUsage(env, { ...base, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estCostUsd: 0, status: `upstream_${res.status}` });
    throw await upstreamError(res);
  }
  const headers = await quotaHeaders(env, code.id);

  const record = async (usage: Usage | null) => {
    // An interrupted stream may lack usage: assume the full output allowance so caps stay safe.
    const u = usage ?? { input: 0, cached: 0, output: Number(body.max_completion_tokens) };
    await recordUsage(env, {
      ...base,
      inputTokens: u.input,
      cachedInputTokens: u.cached,
      outputTokens: u.output,
      estCostUsd: chatCost(env, u),
      status: usage ? "ok" : "ok_usage_missing",
    });
  };

  if (stream && res.body) return passThroughStream(res, headers, ctx, record);
  const data = (await res.json()) as Json;
  await record(normalizeUsage(data.usage));
  return json(data, 200, headers);
}

// ---------- Segmentation (SAM) ----------

export function sanitizeSegment(body: Json, env: Env): { body: Json; images: number } {
  const model = String(body.model ?? "");
  if (!list(env.ALLOWED_SEGMENT_MODELS).includes(model)) throw new ApiError("model_not_allowed", MESSAGES.model_not_allowed);
  if (!Array.isArray(body.input)) throw new ApiError("bad_request", "The request needs an input array.");

  let images = 0;
  const input = body.input.map((item) => {
    const message = item as Json;
    if (message.type !== undefined && message.type !== "message") {
      throw new ApiError("bad_request", "Only messages with text and images can be segmented in the demo.");
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content as Json[]) {
      if (part.type === "input_image") images += 1;
      else if (part.type !== "input_text") {
        throw new ApiError("bad_request", "Only images can be segmented in the demo (no video or files).");
      }
    }
    return { type: "message", role: message.role ?? "user", content };
  });
  if (images === 0) throw new ApiError("bad_request", "Add at least one image to segment.");

  const out: Json = { model, input, store: false, stream: body.stream !== false };
  const meta = body.metadata as Json | undefined;
  if (meta && typeof meta === "object") {
    const allowed: Json = {};
    if (meta.include_confidence !== undefined) allowed.include_confidence = String(meta.include_confidence);
    if (meta.mask_encoding !== undefined) allowed.mask_encoding = String(meta.mask_encoding);
    out.metadata = allowed;
  }
  return { body: out, images };
}

export async function handleSegment(request: Request, env: Env, ctx: ExecutionContext, code: AccessCode): Promise<Response> {
  const creationHeader = request.headers.get("x-doppl-creation-id");
  const creationId = creationHeader && CREATION_ID.test(creationHeader) ? creationHeader : null;
  const { body, images } = sanitizeSegment(await readJsonBody(request, num(env.MAX_REQUEST_BYTES, 10485760)), env);
  await chargeSamImages(env, code, images);

  const stream = body.stream === true;
  let res: Response;
  try {
    res = await callUpstream(env, "/responses", body, stream);
  } catch (err) {
    await refundSamImages(env, code, images);
    throw err;
  }
  const base = { codeId: code.id, creationId, kind: "segment" as const, model: String(body.model), images };
  if (!res.ok) {
    await refundSamImages(env, code, images);
    await recordUsage(env, { ...base, images: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estCostUsd: 0, status: `upstream_${res.status}` });
    throw await upstreamError(res);
  }
  const headers = await quotaHeaders(env, code.id);
  const cost = (images * num(env.PRICE_SAM_PER_1K_IMAGES, 2.5)) / 1000;
  const record = async (usage: Usage | null) =>
    recordUsage(env, {
      ...base,
      inputTokens: usage?.input ?? 0,
      cachedInputTokens: usage?.cached ?? 0,
      outputTokens: usage?.output ?? 0,
      estCostUsd: cost,
      status: "ok",
    });

  if (stream && res.body) return passThroughStream(res, headers, ctx, record);
  const data = (await res.json()) as Json;
  await record(normalizeUsage(data.usage));
  return json(data, 200, headers);
}

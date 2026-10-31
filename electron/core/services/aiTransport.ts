import { net } from "electron";
import type { AiErrorAction, DemoSession } from "../types";

// Shared AI types and errors, and the two access checks Settings makes (a demo code, an own Meta key). Requests
// themselves go through the role router (core/ai/gateway) and its provider adapters (core/ai/providers).

export const META_API_BASE = "https://api.meta.ai/v1";

export class AiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: AiErrorAction = "retry",
    /** More for the dev panel and evals (e.g. what the model answered). */
    readonly detail?: string,
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
  "provider_key_invalid",
  "provider_billing",
  "provider_forbidden",
  "model_not_found",
  "model_disabled",
  "data_policy",
  "unsupported",
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

export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
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


async function workerError(res: Response): Promise<AiError> {
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const code = data?.error?.code ?? "upstream_error";
  return new AiError(code, data?.error?.message ?? `The demo service returned an error (status ${res.status}).`, actionFor(code));
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
      return new AiError("upstream_error", "Meta's AI service had a problem. Try again in a minute.", "retry", `Status ${res.status}${detail}`);
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

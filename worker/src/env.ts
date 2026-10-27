export interface Env {
  DB: D1Database;
  CODE_LIMITER: RateLimit;

  // Secrets (wrangler secret put)
  META_API_KEY: string;
  ADMIN_TOKEN: string;

  // Vars (wrangler.toml)
  META_API_BASE_URL: string;
  DEMO_ENABLED: string;
  ALLOWED_CHAT_MODELS: string;
  ALLOWED_SEGMENT_MODELS: string;
  MAX_OUTPUT_TOKENS: string;
  MAX_CALLS_PER_CREATION: string;
  MAX_REQUEST_BYTES: string;
  PRICE_INPUT_PER_M: string;
  PRICE_CACHED_INPUT_PER_M: string;
  PRICE_OUTPUT_PER_M: string;
  PRICE_SAM_PER_1K_IMAGES: string;
  DAILY_SPEND_CAP: string;
  TOTAL_SPEND_CAP: string;
}

/** Vars are strings; read them as numbers with a fallback. */
export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

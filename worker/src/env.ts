export interface Env {
  DB: D1Database;
  CODE_LIMITER: RateLimit;

  // Secrets (wrangler secret put)
  META_API_KEY: string;
  ADMIN_TOKEN: string;

  // Vars (wrangler.toml)
  META_API_BASE_URL: string;
  DEMO_ENABLED: string;
  // Allowed models, prices, output tokens and calls per creation come from the app's model registry (src/models.ts).
  MAX_REQUEST_BYTES: string;
  DAILY_SPEND_CAP: string;
  TOTAL_SPEND_CAP: string;
}

/** Vars are strings; read them as numbers with a fallback. */
export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

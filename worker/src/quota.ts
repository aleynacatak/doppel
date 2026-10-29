import { type AccessCode, nowIso } from "./codes";
import { type Env, num } from "./env";
import { ApiError, MESSAGES } from "./errors";
import { DEMO_LIMITS } from "./models";

// Every limit is enforced with a single conditional UPDATE … RETURNING, so concurrent
// requests can never spend the same unit twice (D1 runs each statement atomically).

export const today = () => nowIso().slice(0, 10);

/** Kill switch: the DEMO_ENABLED var, or a pause set through the admin API. */
export async function demoEnabled(env: Env): Promise<boolean> {
  if (env.DEMO_ENABLED !== "true") return false;
  const flag = await env.DB.prepare("SELECT value FROM worker_flags WHERE key = 'paused'").first<{ value: string }>();
  return flag?.value !== "1";
}

export async function assertDemoEnabled(env: Env) {
  if (!(await demoEnabled(env))) throw new ApiError("demo_paused", MESSAGES.demo_paused);
}

export async function spendTotals(env: Env): Promise<{ today: number; total: number }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT est_cost_usd FROM spend_daily WHERE day = ?), 0) AS today,
            COALESCE((SELECT SUM(est_cost_usd) FROM spend_daily), 0) AS total`,
  )
    .bind(today())
    .first<{ today: number; total: number }>();
  return { today: row?.today ?? 0, total: row?.total ?? 0 };
}

/** Pauses AI endpoints once estimated spend reaches the daily or all-time cap. */
export async function assertUnderSpendCaps(env: Env) {
  const spend = await spendTotals(env);
  if (spend.today >= num(env.DAILY_SPEND_CAP, 20) || spend.total >= num(env.TOTAL_SPEND_CAP, 100)) {
    throw new ApiError("demo_paused", MESSAGES.demo_budget);
  }
}

export async function assertRateLimit(env: Env, code: AccessCode) {
  const { success } = await env.CODE_LIMITER.limit({ key: code.id });
  if (!success) throw new ApiError("rate_limited", MESSAGES.rate_limited, {}, { "retry-after": "60" });
}

/**
 * Charges one model call to a creation. The first call with a new creation id consumes one of the
 * code's creations; later calls only count against the demo's calls per creation (the app's model registry).
 */
export async function chargeCreationCall(env: Env, code: AccessCode, creationId: string): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const inserted = await db
    .prepare("INSERT INTO creations (id, code_id, calls, created_at) VALUES (?, ?, 0, ?) ON CONFLICT(id) DO NOTHING RETURNING id")
    .bind(creationId, code.id, now)
    .first();

  if (inserted) {
    const charged = await db
      .prepare(
        `UPDATE access_codes SET used_creations = used_creations + 1
         WHERE id = ? AND used_creations < max_creations AND revoked = 0 AND expires_at > ?
         RETURNING used_creations`,
      )
      .bind(code.id, now)
      .first();
    if (!charged) {
      await db.prepare("DELETE FROM creations WHERE id = ? AND calls = 0").bind(creationId).run();
      throw new ApiError("quota_exhausted", MESSAGES.quota_creations);
    }
  } else {
    const owner = await db.prepare("SELECT code_id FROM creations WHERE id = ?").bind(creationId).first<{ code_id: string }>();
    if (owner && owner.code_id !== code.id) {
      throw new ApiError("bad_request", "This creation id belongs to a different access code.");
    }
  }

  const counted = await db
    .prepare("UPDATE creations SET calls = calls + 1 WHERE id = ? AND code_id = ? AND calls < ? RETURNING calls")
    .bind(creationId, code.id, DEMO_LIMITS.maxCallsPerCreation)
    .first();
  if (!counted) throw new ApiError("creation_call_limit", MESSAGES.creation_call_limit);
}

/** Reserves `images` SAM images; refunded if the upstream call fails. */
export async function chargeSamImages(env: Env, code: AccessCode, images: number): Promise<void> {
  const charged = await env.DB.prepare(
    `UPDATE access_codes SET used_sam_images = used_sam_images + ?1
     WHERE id = ?2 AND used_sam_images + ?1 <= max_sam_images AND revoked = 0 AND expires_at > ?3
     RETURNING used_sam_images`,
  )
    .bind(images, code.id, nowIso())
    .first();
  if (!charged) throw new ApiError("quota_exhausted", MESSAGES.quota_sam);
}

export async function refundSamImages(env: Env, code: AccessCode, images: number) {
  await env.DB.prepare("UPDATE access_codes SET used_sam_images = MAX(used_sam_images - ?, 0) WHERE id = ?")
    .bind(images, code.id)
    .run();
}

export interface UsageEvent {
  codeId: string;
  creationId: string | null;
  kind: "chat" | "segment";
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  images: number;
  estCostUsd: number;
  status: string;
}

/** Records counts (never bodies) and adds the estimated cost to today's spend. */
export async function recordUsage(env: Env, e: UsageEvent) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage_events (id, code_id, creation_id, kind, model, input_tokens, cached_input_tokens,
         output_tokens, images, est_cost_usd, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      e.codeId,
      e.creationId,
      e.kind,
      e.model,
      e.inputTokens,
      e.cachedInputTokens,
      e.outputTokens,
      e.images,
      e.estCostUsd,
      e.status,
      nowIso(),
    ),
    env.DB.prepare(
      `INSERT INTO spend_daily (day, est_cost_usd) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET est_cost_usd = est_cost_usd + excluded.est_cost_usd`,
    ).bind(today(), e.estCostUsd),
  ]);
}

/** Current usage of a code, sent back as response headers so the app can show what's left. */
export async function quotaHeaders(env: Env, codeId: string): Promise<Record<string, string>> {
  const row = await env.DB.prepare(
    "SELECT used_creations, max_creations, used_sam_images, max_sam_images FROM access_codes WHERE id = ?",
  )
    .bind(codeId)
    .first<{ used_creations: number; max_creations: number; used_sam_images: number; max_sam_images: number }>();
  if (!row) return {};
  return {
    "x-doppl-creations-used": String(row.used_creations),
    "x-doppl-creations-max": String(row.max_creations),
    "x-doppl-sam-images-used": String(row.used_sam_images),
    "x-doppl-sam-images-max": String(row.max_sam_images),
  };
}

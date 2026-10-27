import { type AccessCode, generateCode, normalizeExpiry, nowIso, sha256Hex } from "./codes";
import { type Env, num } from "./env";
import { ApiError, json } from "./errors";
import { demoEnabled, spendTotals } from "./quota";

// Admin API (Authorization: Bearer <ADMIN_TOKEN>). Plain codes are returned once, at creation.

function intIn(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function createCode(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError("bad_request", "The request body isn't valid JSON.");
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const maxCreations = intIn(body.maxCreations, 0, 100_000);
  const maxSamImages = intIn(body.maxSamImages ?? 0, 0, 1_000_000);
  const expiresAt = normalizeExpiry(body.expiresAt);
  if (!label || label.length > 64) throw new ApiError("bad_request", "label is required (up to 64 characters).");
  if (maxCreations === null) throw new ApiError("bad_request", "maxCreations must be a whole number.");
  if (maxSamImages === null) throw new ApiError("bad_request", "maxSamImages must be a whole number.");
  if (!expiresAt) throw new ApiError("bad_request", "expiresAt must be a date like 2026-11-20.");

  const code = generateCode();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO access_codes (id, code_hash, label, max_creations, max_sam_images, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, await sha256Hex(code), label, maxCreations, maxSamImages, expiresAt, nowIso())
    .run();
  return json({ id, code, label, maxCreations, maxSamImages, expiresAt }, 201);
}

async function listCodes(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, COALESCE(SUM(u.est_cost_usd), 0) AS est_cost_usd, MAX(u.created_at) AS last_used_at
     FROM access_codes c LEFT JOIN usage_events u ON u.code_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC`,
  ).all<AccessCode & { est_cost_usd: number; last_used_at: string | null }>();
  return json({
    codes: results.map((c) => ({
      id: c.id,
      label: c.label,
      creations: { used: c.used_creations, max: c.max_creations },
      samImages: { used: c.used_sam_images, max: c.max_sam_images },
      expiresAt: c.expires_at,
      revoked: c.revoked === 1,
      estCostUsd: Math.round(c.est_cost_usd * 10000) / 10000,
      lastUsedAt: c.last_used_at,
      createdAt: c.created_at,
    })),
  });
}

async function revokeCode(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("UPDATE access_codes SET revoked = 1 WHERE id = ? RETURNING id, label").bind(id).first();
  if (!row) throw new ApiError("not_found", "No access code with that id.");
  return json({ revoked: true, id, label: row.label });
}

async function spend(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT day, est_cost_usd FROM spend_daily ORDER BY day DESC LIMIT 7").all<{
    day: string;
    est_cost_usd: number;
  }>();
  const totals = await spendTotals(env);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return json({
    today: round(totals.today),
    last7Days: results.map((r) => ({ day: r.day, estCostUsd: round(r.est_cost_usd) })),
    total: round(totals.total),
    caps: { daily: num(env.DAILY_SPEND_CAP, 20), total: num(env.TOTAL_SPEND_CAP, 100) },
    demoEnabled: await demoEnabled(env),
  });
}

async function setPaused(env: Env, paused: boolean): Promise<Response> {
  await env.DB.prepare(
    "INSERT INTO worker_flags (key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(paused ? "1" : "0")
    .run();
  return json({ paused, demoEnabled: await demoEnabled(env) });
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  if (path === "/admin/codes" && method === "POST") return createCode(request, env);
  if (path === "/admin/codes" && method === "GET") return listCodes(env);
  const revoke = path.match(/^\/admin\/codes\/([A-Za-z0-9-]+)\/revoke$/);
  if (revoke && method === "POST") return revokeCode(env, revoke[1]);
  if (path === "/admin/spend" && method === "GET") return spend(env);
  if (path === "/admin/pause" && method === "POST") return setPaused(env, true);
  if (path === "/admin/resume" && method === "POST") return setPaused(env, false);
  throw new ApiError("not_found", "Unknown admin endpoint.");
}

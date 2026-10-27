import type { Env } from "./env";
import { ApiError, MESSAGES } from "./errors";

export interface AccessCode {
  id: string;
  code_hash: string;
  label: string;
  max_creations: number;
  used_creations: number;
  max_sam_images: number;
  used_sam_images: number;
  expires_at: string;
  revoked: number;
  created_at: string;
}

// No 0/O/1/I: codes get read aloud and typed by hand. 32 symbols → 5 bits each, 60 bits per code.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]);
  return `DOPPL-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

/** Codes are matched case-insensitively and ignoring surrounding spaces. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const nowIso = () => new Date().toISOString();

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Looks up the access code in the Authorization header and checks it is usable. */
export async function authenticate(request: Request, env: Env): Promise<AccessCode> {
  const code = bearer(request);
  if (!code) throw new ApiError("invalid_code", MESSAGES.invalid_code);
  const hash = await sha256Hex(normalizeCode(code));
  const row = await env.DB.prepare("SELECT * FROM access_codes WHERE code_hash = ?").bind(hash).first<AccessCode>();
  if (!row) throw new ApiError("invalid_code", MESSAGES.invalid_code);
  if (row.revoked) throw new ApiError("code_revoked", MESSAGES.code_revoked);
  if (row.expires_at <= nowIso()) throw new ApiError("code_expired", MESSAGES.code_expired);
  return row;
}

/** Constant-time comparison of the admin token (hash both sides so lengths match). */
export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const token = bearer(request);
  if (!token || !env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  const [a, b] = await Promise.all([sha256Hex(token), sha256Hex(env.ADMIN_TOKEN)]);
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

/** "2026-11-20" → end of that day (UTC); full timestamps are kept as given. */
export function normalizeExpiry(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59.999Z`) : new Date(v);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

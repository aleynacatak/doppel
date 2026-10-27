import { randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** A delay that can be scaled by the dev panel's speed and stops early on cancel. */
export function delay(ms: number, isCancelled?: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const step = 50;
    let elapsed = 0;
    const tick = () => {
      if (isCancelled?.()) return reject(new CancelledError());
      if (elapsed >= ms) return resolve();
      elapsed += step;
      setTimeout(tick, step);
    };
    tick();
  });
}

/** "21.6.0.57" → "21.6" */
export function shortVersion(version: string | undefined | null): string {
  if (!version) return "";
  return version.split(".").slice(0, 2).join(".");
}

/** Compares "major.minor" strings. Returns <0 when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

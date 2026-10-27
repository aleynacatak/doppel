import { createExecutionContext, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { sha256Hex } from "../src/codes";
import type { Env } from "../src/env";
import worker from "../src/index";

export const env = testEnv as unknown as Env;

let counter = 0;

/** Inserts an access code directly and returns its plain value. */
export async function makeCode(opts: { maxCreations?: number; maxSam?: number; expiresAt?: string; revoked?: boolean } = {}) {
  counter += 1;
  const code = `DOPPL-TEST-${String(counter).padStart(4, "0")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO access_codes (id, code_hash, label, max_creations, max_sam_images, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      await sha256Hex(code),
      `test-${counter}`,
      opts.maxCreations ?? 5,
      opts.maxSam ?? 10,
      opts.expiresAt ?? "2099-01-01T00:00:00.000Z",
      opts.revoked ? 1 : 0,
      new Date().toISOString(),
    )
    .run();
  return { code, id };
}

/** Calls the Worker and waits for background work (usage recording after streams). */
export async function call(path: string, init: RequestInit & { env?: Partial<Env> } = {}) {
  const ctx = createExecutionContext();
  const { env: override, ...rest } = init;
  const res = await worker.fetch(new Request(`https://api.doppl.work${path}`, rest), { ...env, ...override } as Env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body, text };
}

export function chatBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }], ...extra });
}

export const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } };

/** Replaces fetch inside the Worker: every upstream call gets `respond(request)`. */
export function mockUpstream(respond?: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    if (respond) return respond(url, init);
    return new Response(
      JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export const auth = (code: string, creationId?: string) => ({
  authorization: `Bearer ${code}`,
  "content-type": "application/json",
  ...(creationId ? { "x-doppl-creation-id": creationId } : {}),
});

export const newCreation = () => crypto.randomUUID();

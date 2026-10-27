import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { today } from "../src/quota";
import { auth, call, chatBody, env, makeCode, mockUpstream, newCreation, usage } from "./helpers";

beforeEach(async () => {
  await env.DB.batch(
    ["usage_events", "creations", "access_codes", "spend_daily", "worker_flags"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const chat = (code: string, creationId: string, extra?: Record<string, unknown>, init: Record<string, unknown> = {}) =>
  call("/v1/chat", { method: "POST", headers: auth(code, creationId), body: chatBody(extra), ...init });

describe("health and session", () => {
  it("reports health without auth", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, demoEnabled: true });
  });

  it("returns a session for a valid code, case-insensitively", async () => {
    const { code } = await makeCode({ maxCreations: 20, maxSam: 500 });
    const res = await call("/v1/session", { method: "POST", headers: auth(` ${code.toLowerCase()} `) });
    expect(res.status).toBe(200);
    expect(res.body.creations).toEqual({ used: 0, max: 20 });
    expect(res.body.samImages).toEqual({ used: 0, max: 500 });
  });
});

describe("access codes", () => {
  it("proxies a valid code to Meta with the Worker's key and records usage", async () => {
    const { code, id } = await makeCode();
    const upstream = mockUpstream();
    const creation = newCreation();
    const res = await chat(code, creation, { max_tokens: 99999, tools: [{ type: "function" }], store: true });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("ok");
    expect(res.headers.get("x-doppl-creations-used")).toBe("1");

    expect(upstream).toHaveLength(1);
    const sent = upstream[0];
    expect(sent.url).toBe("https://meta.test/v1/chat/completions");
    const headers = new Headers(sent.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-meta-key-do-not-ship");
    expect(sent.body.max_completion_tokens).toBe(8000);
    expect(sent.body.max_tokens).toBeUndefined();
    expect(sent.body.store).toBe(false);
    expect(sent.body.tools).toBeUndefined();

    const event = await env.DB.prepare("SELECT * FROM usage_events WHERE code_id = ?").bind(id).first<any>();
    expect(event).toMatchObject({ kind: "chat", input_tokens: 1000, cached_input_tokens: 200, output_tokens: 500, status: "ok" });
    // 800 uncached × 1.25 + 200 cached × 0.15 + 500 output × 4.25, per million tokens
    expect(event.est_cost_usd).toBeCloseTo((800 * 1.25 + 200 * 0.15 + 500 * 4.25) / 1e6, 10);
    const spend = await env.DB.prepare("SELECT est_cost_usd FROM spend_daily WHERE day = ?").bind(today()).first<any>();
    expect(spend.est_cost_usd).toBeCloseTo(event.est_cost_usd, 10);
  });

  it("rejects a missing or unknown code", async () => {
    mockUpstream();
    const missing = await call("/v1/chat", { method: "POST", body: chatBody() });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("invalid_code");
    const wrong = await chat("DOPPL-AAAA-BBBB-CCCC", newCreation());
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("invalid_code");
    expect(typeof wrong.body.error.message).toBe("string");
  });

  it("rejects expired and revoked codes", async () => {
    mockUpstream();
    const expired = await makeCode({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const revoked = await makeCode({ revoked: true });
    expect((await chat(expired.code, newCreation())).body.error.code).toBe("code_expired");
    const r = await chat(revoked.code, newCreation());
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("code_revoked");
  });
});

describe("creation counting", () => {
  it("charges one creation for the first call and none for later calls with the same id", async () => {
    const { code, id } = await makeCode({ maxCreations: 2 });
    mockUpstream();
    const creation = newCreation();
    for (let i = 0; i < 4; i++) expect((await chat(code, creation)).status).toBe(200);
    const row = await env.DB.prepare("SELECT used_creations FROM access_codes WHERE id = ?").bind(id).first<any>();
    expect(row.used_creations).toBe(1);
    const c = await env.DB.prepare("SELECT calls FROM creations WHERE id = ?").bind(creation).first<any>();
    expect(c.calls).toBe(4);
  });

  it("enforces the per-creation call limit", async () => {
    const { code } = await makeCode();
    mockUpstream();
    const creation = newCreation();
    const limit = Number(env.MAX_CALLS_PER_CREATION);
    for (let i = 0; i < limit; i++) expect((await chat(code, creation)).status).toBe(200);
    const over = await chat(code, creation);
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe("creation_call_limit");
  });

  it("reports quota_exhausted once creations run out", async () => {
    const { code } = await makeCode({ maxCreations: 1 });
    mockUpstream();
    expect((await chat(code, newCreation())).status).toBe(200);
    const second = await chat(code, newCreation());
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe("quota_exhausted");
  });

  it("requires a creation id on chat", async () => {
    const { code } = await makeCode();
    mockUpstream();
    const res = await call("/v1/chat", { method: "POST", headers: auth(code), body: chatBody() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("lets exactly 3 of 10 parallel new creations through when 3 are left", async () => {
    const { code, id } = await makeCode({ maxCreations: 3 });
    mockUpstream();
    const results = await Promise.all(Array.from({ length: 10 }, () => chat(code, newCreation())));
    const ok = results.filter((r) => r.status === 200);
    const exhausted = results.filter((r) => r.body?.error?.code === "quota_exhausted");
    expect(ok).toHaveLength(3);
    expect(exhausted).toHaveLength(7);
    const row = await env.DB.prepare("SELECT used_creations FROM access_codes WHERE id = ?").bind(id).first<any>();
    expect(row.used_creations).toBe(3);
  });
});

describe("spend caps and kill switch", () => {
  it("pauses when today's spend reaches the daily cap", async () => {
    const { code } = await makeCode();
    const upstream = mockUpstream();
    await env.DB.prepare("INSERT INTO spend_daily (day, est_cost_usd) VALUES (?, ?)").bind(today(), 20).run();
    const res = await chat(code, newCreation());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("demo_paused");
    expect(upstream).toHaveLength(0);
  });

  it("pauses when all-time spend reaches the total cap", async () => {
    const { code } = await makeCode();
    mockUpstream();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO spend_daily (day, est_cost_usd) VALUES ('2026-01-01', 60)"),
      env.DB.prepare("INSERT INTO spend_daily (day, est_cost_usd) VALUES ('2026-01-02', 40)"),
    ]);
    const res = await chat(code, newCreation());
    expect(res.body.error.code).toBe("demo_paused");
  });

  it("returns demo_paused for every AI endpoint when DEMO_ENABLED is false", async () => {
    const { code } = await makeCode();
    const upstream = mockUpstream();
    const off = { env: { DEMO_ENABLED: "false" } };
    const a = await chat(code, newCreation(), {}, off);
    const b = await call("/v1/segment", { method: "POST", headers: auth(code), body: "{}", ...off });
    expect(a.body.error.code).toBe("demo_paused");
    expect(b.body.error.code).toBe("demo_paused");
    expect(upstream).toHaveLength(0);
    expect((await call("/health", off)).body.demoEnabled).toBe(false);
  });

  it("can be paused and resumed through the admin API", async () => {
    const { code } = await makeCode();
    mockUpstream();
    const admin = { authorization: "Bearer test-admin-token-0123456789" };
    expect((await call("/admin/pause", { method: "POST", headers: admin })).body.paused).toBe(true);
    expect((await chat(code, newCreation())).body.error.code).toBe("demo_paused");
    await call("/admin/resume", { method: "POST", headers: admin });
    expect((await chat(code, newCreation())).status).toBe(200);
  });
});

describe("request validation", () => {
  it("rejects models outside the allowlist, including contributor variants", async () => {
    const { code } = await makeCode();
    const upstream = mockUpstream();
    for (const model of ["muse-spark-1.3-contributor", "muse-wonder-1.0"]) {
      const res = await chat(code, newCreation(), { model });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("model_not_allowed");
    }
    expect(upstream).toHaveLength(0);
  });

  it("rejects oversized requests", async () => {
    const { code } = await makeCode();
    mockUpstream();
    const big = "x".repeat(2048);
    const res = await chat(code, newCreation(), { messages: [{ role: "user", content: big }] }, { env: { MAX_REQUEST_BYTES: "1024" } });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("request_too_large");
  });

  it("maps upstream failures to upstream_error with the status, never the key", async () => {
    const { code } = await makeCode();
    mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { message: "Team rate limit exceeded", type: "rate_limit_error" } }), {
          status: 429,
        }),
    );
    const res = await chat(code, newCreation());
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: "upstream_error", upstreamStatus: 429 });
    expect(res.text).not.toContain("test-meta-key");
  });
});

describe("rate limiting", () => {
  it("limits each code to 30 requests per minute", async () => {
    const { code } = await makeCode();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await call("/v1/session", { method: "POST", headers: auth(code) })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    const last = await call("/v1/session", { method: "POST", headers: auth(code) });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("rate_limited");
    expect(last.headers.get("retry-after")).toBe("60");
  });
});

describe("streaming", () => {
  it("passes the stream through and records usage from the final chunk", async () => {
    const { code, id } = await makeCode();
    const sse = [
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hel" } }], usage: null })}`,
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", choices: [], usage })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const upstream = mockUpstream(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const res = await chat(code, newCreation(), { stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.text).toBe(sse);
    expect(upstream[0].body.stream_options).toEqual({ include_usage: true });
    const event = await env.DB.prepare("SELECT * FROM usage_events WHERE code_id = ?").bind(id).first<any>();
    expect(event).toMatchObject({ input_tokens: 1000, output_tokens: 500, status: "ok" });
  });
});

describe("segmentation", () => {
  const segmentBody = (images: number) =>
    JSON.stringify({
      model: "sam-3.1",
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "product" },
            ...Array.from({ length: images }, () => ({ type: "input_image", image_url: "data:image/png;base64,AAAA" })),
          ],
        },
      ],
    });

  it("counts SAM images, forces store false, and records the per-image cost", async () => {
    const { code, id } = await makeCode({ maxSam: 3 });
    const upstream = mockUpstream(() => new Response(JSON.stringify({ id: "r", output: [] }), { status: 200 }));
    const res = await call("/v1/segment", { method: "POST", headers: auth(code), body: segmentBody(2) });
    expect(res.status).toBe(200);
    expect(upstream[0].url).toBe("https://meta.test/v1/responses");
    expect(upstream[0].body.store).toBe(false);
    const row = await env.DB.prepare("SELECT used_sam_images FROM access_codes WHERE id = ?").bind(id).first<any>();
    expect(row.used_sam_images).toBe(2);
    const event = await env.DB.prepare("SELECT * FROM usage_events WHERE code_id = ?").bind(id).first<any>();
    expect(event).toMatchObject({ kind: "segment", images: 2 });
    expect(event.est_cost_usd).toBeCloseTo(0.005, 10);

    const over = await call("/v1/segment", { method: "POST", headers: auth(code), body: segmentBody(2) });
    expect(over.body.error.code).toBe("quota_exhausted");
  });

  it("refunds images when Meta fails, and rejects video", async () => {
    const { code, id } = await makeCode({ maxSam: 3 });
    mockUpstream(() => new Response("", { status: 500 }));
    const res = await call("/v1/segment", { method: "POST", headers: auth(code), body: segmentBody(1) });
    expect(res.body.error.code).toBe("upstream_error");
    const row = await env.DB.prepare("SELECT used_sam_images FROM access_codes WHERE id = ?").bind(id).first<any>();
    expect(row.used_sam_images).toBe(0);

    const video = JSON.stringify({
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_video", file_id: "f" }] }],
    });
    expect((await call("/v1/segment", { method: "POST", headers: auth(code), body: video })).body.error.code).toBe("bad_request");
  });
});

describe("admin", () => {
  const admin = { authorization: "Bearer test-admin-token-0123456789", "content-type": "application/json" };

  it("rejects a wrong admin token", async () => {
    const res = await call("/admin/codes", { headers: { authorization: "Bearer nope-nope-nope-nope" } });
    expect(res.status).toBe(401);
  });

  it("creates a code once, lists it without the plain code, and revokes it", async () => {
    const created = await call("/admin/codes", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ label: "judges", maxCreations: 20, maxSamImages: 500, expiresAt: "2099-11-20" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^DOPPL-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(created.body.expiresAt).toBe("2099-11-20T23:59:59.999Z");

    const session = await call("/v1/session", { method: "POST", headers: auth(created.body.code) });
    expect(session.body.label).toBe("judges");

    const listed = await call("/admin/codes", { headers: admin });
    expect(listed.text).not.toContain(created.body.code);
    expect(listed.body.codes.some((c: any) => c.id === created.body.id)).toBe(true);

    await call(`/admin/codes/${created.body.id}/revoke`, { method: "POST", headers: admin });
    expect((await call("/v1/session", { method: "POST", headers: auth(created.body.code) })).body.error.code).toBe("code_revoked");
  });

  it("reports spend", async () => {
    await env.DB.prepare("INSERT INTO spend_daily (day, est_cost_usd) VALUES (?, 1.5)").bind(today()).run();
    const res = await call("/admin/spend", { headers: admin });
    expect(res.body).toMatchObject({ today: 1.5, total: 1.5, caps: { daily: 20, total: 100 } });
  });
});

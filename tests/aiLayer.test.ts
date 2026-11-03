import { describe, expect, it } from "vitest";
import { codeOf, needsCode, resolveCodeRefs, splitAnswer } from "../electron/core/ai/answer";
import { AiGateway, DEFAULT_ROLES, type RoleConfig, effortFor, isModelImage, mergeRoles, parseJsonAnswer, readableImages } from "../electron/core/ai/gateway";
import { DopplDemoProvider, type FetchLike, OpenAICompatibleProvider } from "../electron/core/ai/providers";
import { ModelRegistry, type RegistryData, costOf, orderFields } from "../electron/core/ai/registry";
import { AiError } from "../electron/core/services/aiTransport";

// The model-agnostic AI layer: reading code outside JSON, field order per model, roles and escalation, the data
// policy guard, and provider adapters (with mocked HTTP).

describe("code outside the JSON", () => {
  it("splits an answer into its JSON and fenced blocks, and resolves references", () => {
    const answer = 'Here it is:\n{"action":"propose_routine","routine":{"name":"Cut","script":"@code:1"}}\n```javascript\nvar img = openDocument(ctx.item.path);\nif (a) { b(); }\n```\n';
    const { json, blocks } = splitAnswer(answer);
    expect(json?.action).toBe("propose_routine");
    expect(blocks).toEqual([{ lang: "javascript", code: "var img = openDocument(ctx.item.path);\nif (a) { b(); }" }]);
    const { routine, missing } = resolveCodeRefs(json!.routine, blocks);
    expect(routine.script).toBe("var img = openDocument(ctx.item.path);\nif (a) { b(); }");
    expect(missing).toEqual([]);
    expect(resolveCodeRefs({ script: "@code:2" }, blocks).missing).toEqual([2]);
    // Figma action lists come as ```json; a "body" reference lands on the right field.
    expect(resolveCodeRefs({ app: "figma", body: "@code:1" }, [{ lang: "json", code: '[{"action":"setText"}]' }]).routine).toEqual({ app: "figma", actions: '[{"action":"setText"}]' });
  });

  it("keeps code the model still wrote inside the JSON (unescaped by JSON.parse)", () => {
    const inline = JSON.stringify({ action: "propose_routine", routine: { script: 'var a = "x";\nctx.log(a);' } });
    const { json, blocks } = splitAnswer(inline);
    expect(blocks).toEqual([]);
    expect(resolveCodeRefs(json!.routine, blocks).routine.script).toBe('var a = "x";\nctx.log(a);');
    expect(needsCode(json!.routine, "script")).toBe(false);
    expect(needsCode({ script: "@code:1" }, "script")).toBe(true);
    expect(needsCode({ name: "x" }, "actions")).toBe(true);
  });

  it("reads a plain-text code answer: the fenced block of the language, else the whole text", () => {
    expect(codeOf("Sure:\n```js\nvar a = 1;\n```", "javascript")).toBe("var a = 1;");
    expect(codeOf('```json\n[{"action":"measure","node":"Card"}]\n```', "json")).toBe('[{"action":"measure","node":"Card"}]');
    expect(codeOf("var b = 2;", "javascript")).toBe("var b = 2;");
    // A JSON answer in a ```json fence is the JSON, not a code block.
    expect(splitAnswer('```json\n{"action":"inspect"}\n```')).toEqual({ json: { action: "inspect" }, blocks: [] });
  });
});

describe("field order", () => {
  const schema = { type: "object", properties: { action: { type: "string" }, plan: { type: "string" }, routine: { type: "object" } }, required: ["plan", "action"] };

  it("prefixes fields that must come first for models that write fields alphabetically, and maps them back", () => {
    const o = orderFields(schema, ["plan"], ["alphabeticalFields"]);
    expect(Object.keys(o.schema.properties as object)).toEqual(["a0_plan", "action", "routine"]);
    expect(["a0_plan", "action", "app", "routine"].sort()[0]).toBe("a0_plan");
    expect(o.schema.required).toEqual(["a0_plan", "action"]);
    expect(o.keyFor("plan")).toBe("a0_plan");
    expect(o.fromModel({ a0_plan: "think", action: "inspect" })).toEqual({ plan: "think", action: "inspect" });
  });

  it("only reorders for other models", () => {
    const o = orderFields(schema, ["plan"], []);
    expect(Object.keys(o.schema.properties as object)).toEqual(["plan", "action", "routine"]);
    expect(o.fromModel({ plan: "p" })).toEqual({ plan: "p" });
  });
});

const data: RegistryData = {
  version: 1,
  providers: [
    { id: "meta", kind: "openai-compatible", displayName: "Meta", baseUrl: "https://api.example/v1", auth: "bearer", segmentPath: "/responses", maxOutputTokens: 32000 },
    { id: "doppl-demo", kind: "doppl-demo", displayName: "Demo", serves: "meta", maxOutputTokens: 8000, maxCallsPerCreation: 15 },
  ],
  models: [
    {
      id: "spark",
      provider: "meta",
      displayName: "Spark",
      capabilities: { tools: true, structuredOutput: true, vision: true, reasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max"], contextWindow: 1e6 },
      location: "cloud",
      pricing: { inputPerM: 1.25, cachedInputPerM: 0.15, outputPerM: 4.25 },
      quirks: ["alphabeticalFields"],
      dataPolicy: { trainsOnData: false },
      enabled: true,
    },
    {
      id: "spark-contributor",
      provider: "meta",
      displayName: "Spark (Contributor)",
      capabilities: { tools: true, structuredOutput: true, vision: true, reasoningEffort: ["minimal", "low", "medium", "high", "xhigh"], contextWindow: 1e6 },
      location: "cloud",
      pricing: { inputPerM: 0.1, outputPerM: 0.2 },
      quirks: [],
      dataPolicy: { trainsOnData: true },
      enabled: true,
    },
    {
      id: "plain",
      provider: "meta",
      displayName: "Plain",
      capabilities: { tools: false, structuredOutput: false, vision: false, contextWindow: 1e5 },
      location: "cloud",
      quirks: [],
      dataPolicy: { trainsOnData: false },
      enabled: true,
    },
  ],
};

/** A gateway whose providers answer from a script and record what they were sent. */
function gatewayWith(roles: Partial<RoleConfig>, answer: (model: string, req: any) => string) {
  const sent: { model: string; req: any }[] = [];
  const spend: Record<string, number> = {};
  const gw = new AiGateway({
    registry: () => new ModelRegistry(data),
    roles: () => mergeRoles({ ...DEFAULT_ROLES, planner: { model: "spark" }, coder: { model: "spark" }, reviewer: { model: "spark" }, segmenter: { model: "spark" } }, roles),
    provider: async () => ({
      adapter: {
        id: "meta",
        chat: async (req) => {
          sent.push({ model: req.model, req });
          return { content: answer(req.model, req), finishReason: "stop", usage: { input: 1000, cached: 200, output: 500 } };
        },
      },
      entry: data.providers[0],
    }),
    spend: { check: () => undefined, add: (p, usd) => void (spend[p] = (spend[p] ?? 0) + usd) },
  });
  return { gw, sent, spend };
}

const ctx = (extra: Record<string, unknown> = {}) => ({ onAiCall: () => undefined, isCancelled: () => false, creationId: "c1", ...extra });

describe("images the model can read", () => {
  it("keeps PNG, JPEG, WebP and web images, and swaps SVG (or any image, without vision) for a note", () => {
    expect(["data:image/png;base64,AA", "data:image/jpeg;base64,AA", "data:image/webp;base64,AA", "https://x.test/a.png"].every(isModelImage)).toBe(true);
    expect(isModelImage("data:image/svg+xml;charset=utf-8,%3Csvg")).toBe(false);
    const messages = [
      { role: "system" as const, content: "guide" },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Previews:" },
          { type: "image_url" as const, image_url: { url: "data:image/svg+xml;charset=utf-8,%3Csvg" } },
          { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA" } },
        ],
      },
    ];
    const kept = readableImages(messages, true)[1].content as { type: string }[];
    expect(kept.map((p) => p.type)).toEqual(["text", "text", "image_url"]);
    expect((readableImages(messages, false)[1].content as { type: string }[]).map((p) => p.type)).toEqual(["text", "text", "text"]);
    expect(readableImages(messages, true)[0]).toBe(messages[0]);
  });
});

describe("roles and the model registry", () => {
  it("routes each role to its model, with the role's effort (lowered to what the model supports), field order and cost", async () => {
    const usage: any[] = [];
    const { gw, sent, spend } = gatewayWith({ coder: { model: "spark", reasoningEffort: "max" }, planner: { model: "spark-contributor", reasoningEffort: "max" } }, () => '{"a0_plan":"p","action":"inspect"}');
    const res = await gw.chat("coder", { messages: [{ role: "user", content: "x" }], schema: { name: "t", schema: { type: "object", properties: { action: {}, plan: {} } }, first: ["plan"] }, maxTokens: 50000 }, ctx({ onUsage: (u: unknown) => usage.push(u) }));
    expect(res.json).toEqual({ plan: "p", action: "inspect" });
    expect(sent[0].req).toMatchObject({ model: "spark", reasoningEffort: "max", maxTokens: 32000 });
    expect(Object.keys(sent[0].req.schema.schema.properties)).toEqual(["a0_plan", "action"]);
    expect(usage[0]).toMatchObject({ role: "coder", model: "spark", provider: "meta" });
    expect(usage[0].costUsd).toBeCloseTo((800 * 1.25 + 200 * 0.15 + 500 * 4.25) / 1e6, 9);
    expect(spend.meta).toBeCloseTo(usage[0].costUsd, 9);
    expect(effortFor(new ModelRegistry(data).model("spark-contributor"), "max")).toBe("xhigh");
    expect(effortFor(new ModelRegistry(data).model("spark"), "max", "low")).toBe("low");
    expect(effortFor(new ModelRegistry(data).model("spark"), undefined, "low")).toBe("low");
    expect(effortFor(new ModelRegistry(data).model("spark"))).toBeUndefined();
    expect(effortFor(new ModelRegistry(data).model("plain"), "high")).toBeUndefined();
  });

  it("asks for JSON in the prompt when a model has no structured output, and repairs it", async () => {
    const { gw, sent } = gatewayWith({ planner: { model: "plain" } }, () => 'Sure!\n```json\n{"action":"inspect",}\n```');
    const res = await gw.chat("planner", { messages: [{ role: "user", content: "x" }], schema: { name: "t", schema: { type: "object", properties: { action: {} } } }, maxTokens: 100 }, ctx());
    expect(res.json).toEqual({ action: "inspect" });
    expect(sent[0].req.schema).toBeUndefined();
    expect(String(sent[0].req.messages.at(-1).content)).toContain("JSON schema");
    expect(parseJsonAnswer("no json here")).toBeNull();
  });

  it("never sends files, documents or screenshots to a model that trains on data", async () => {
    const { gw, sent } = gatewayWith({ planner: { model: "spark-contributor" } }, () => "{}");
    const withImage = { messages: [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,AA" } }] }], maxTokens: 10 };
    await expect(gw.chat("planner", withImage, ctx())).rejects.toMatchObject({ code: "data_policy" });
    await expect(gw.chat("planner", { messages: [{ role: "user", content: "the request with sample rows" }], maxTokens: 10 }, ctx())).rejects.toBeInstanceOf(AiError);
    await expect(gw.chat("planner", { ...withImage, dataClass: "public" }, ctx())).rejects.toMatchObject({ code: "data_policy" });
    expect(sent).toEqual([]);
    // Only an explicitly public, text-only request may go there.
    await gw.chat("planner", { messages: [{ role: "user", content: "public text" }], maxTokens: 10, dataClass: "public" }, ctx());
    expect(sent).toHaveLength(1);
  });

  it("escalates a role after failed trials, for that creation only (a mock second model)", async () => {
    const { gw, sent } = gatewayWith({ coder: { model: "spark" }, escalation: { coder: { afterFailedTrials: 2, to: { model: "plain" } } } }, (m) => `{"model":"${m}"}`);
    const ask = (id: string) => gw.chat("coder", { messages: [{ role: "user", content: "x" }], maxTokens: 10 }, ctx({ creationId: id }));
    await ask("c1");
    gw.noteFailedTrial("c1");
    await ask("c1");
    gw.noteFailedTrial("c1");
    await ask("c1");
    await ask("c2");
    expect(sent.map((s) => s.model)).toEqual(["spark", "spark", "plain", "spark"]);
    expect(gw.binding("coder", "c1").model).toBe("plain");
  });

  it("lists custom endpoints as experimental models", () => {
    const r = new ModelRegistry(data, [{ id: "or", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1/", model: "vendor/model", structuredOutput: true, vision: false }]);
    expect(r.model("custom:or")).toMatchObject({ apiModel: "vendor/model", location: "cloud", experimental: true, provider: "custom:or" });
    expect(r.provider("custom:or").baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(new ModelRegistry(data, [{ id: "ol", displayName: "Ollama", baseUrl: "http://localhost:11434/v1", model: "llama", structuredOutput: false, vision: false }]).model("custom:ol").location).toBe("local");
    expect(r.demoFor("meta")?.id).toBe("doppl-demo");
    expect(costOf(r.model("spark"), null)).toBe(0);
  });
});

/** A fetch that answers from a list of responses and records the requests. */
function mockFetch(responses: (() => Response)[]) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  };
  return { fetchImpl, calls };
}

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("provider adapters", () => {
  const meta = { id: "meta", displayName: "Meta", baseUrl: "https://api.example/v1", segmentPath: "/responses" };

  it("streams a chat completion with usage, sending model, schema and effort in OpenAI form", async () => {
    const { fetchImpl, calls } = mockFetch([
      () =>
        sse([
          { choices: [{ delta: { content: '{"act' } }] },
          { choices: [{ delta: { content: 'ion":"x"}' }, finish_reason: "stop" }] },
          { usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } },
        ]),
    ]);
    const p = new OpenAICompatibleProvider(meta, async () => "KEY", { fetch: fetchImpl });
    const res = await p.chat({ model: "spark", messages: [{ role: "user", content: "hi" }], schema: { name: "t", schema: {} }, reasoningEffort: "high", maxTokens: 100 }, {});
    expect(res).toEqual({ content: '{"action":"x"}', finishReason: "stop", usage: { input: 10, cached: 2, output: 4 } });
    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toBe("https://api.example/v1/chat/completions");
    expect(calls[0].init.headers.authorization).toBe("Bearer KEY");
    expect(body).toMatchObject({ model: "spark", max_completion_tokens: 100, stream: true, store: false, reasoning_effort: "high", response_format: { type: "json_schema" } });
  });

  it("retries rate limits and server errors with backoff, then maps errors to Doppl's codes", async () => {
    const { fetchImpl, calls } = mockFetch([() => json(429, {}, { "retry-after": "0" }), () => json(503, {}), () => json(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })]);
    const p = new OpenAICompatibleProvider({ ...meta, id: "custom:x", displayName: "Example" }, async () => null, { fetch: fetchImpl, backoffMs: 1 });
    expect((await p.chat({ model: "m", messages: [], maxTokens: 5 }, {})).content).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls[0].init.body).store).toBeUndefined();

    const fail = (status: number) => new OpenAICompatibleProvider({ ...meta, id: "custom:x", displayName: "Example" }, async () => "k", { fetch: mockFetch([() => json(status, { error: { message: "nope" } })]).fetchImpl, retries: 0 });
    await expect(fail(401).chat({ model: "m", messages: [], maxTokens: 5 }, {})).rejects.toMatchObject({ code: "provider_key_invalid", action: "settings" });
    await expect(fail(404).chat({ model: "m", messages: [], maxTokens: 5 }, {})).rejects.toMatchObject({ code: "model_not_found" });
    await expect(fail(500).chat({ model: "m", messages: [], maxTokens: 5 }, {})).rejects.toMatchObject({ code: "upstream_error" });
    const own = new OpenAICompatibleProvider(meta, async () => "k", { fetch: mockFetch([() => json(401, {})]).fetchImpl, retries: 0 });
    await expect(own.chat({ model: "m", messages: [], maxTokens: 5 }, {})).rejects.toMatchObject({ code: "own_key_invalid" });
    await expect(new OpenAICompatibleProvider(meta, async () => null, { fetch: fetchImpl }).chat({ model: "m", messages: [], maxTokens: 5 }, {})).rejects.toMatchObject({ code: "no_access" });
  });

  it("goes through the demo Worker with the access code and creation id, and reads its quota and error codes", async () => {
    const quota: unknown[] = [];
    const { fetchImpl, calls } = mockFetch([
      () => json(200, { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }, { "x-doppl-creations-max": "5", "x-doppl-creations-used": "1", "x-doppl-sam-images-max": "50", "x-doppl-sam-images-used": "0" }),
      () => json(403, { error: { code: "creation_call_limit", message: "Limit" } }),
    ]);
    const p = new DopplDemoProvider("https://worker.example", async () => "DOPPL-CODE", { fetch: fetchImpl });
    await p.chat({ model: "spark", messages: [], maxTokens: 10 }, { creationId: "c9", onQuota: (q) => quota.push(q) });
    expect(calls[0].url).toBe("https://worker.example/v1/chat");
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer DOPPL-CODE", "x-doppl-creation-id": "c9" });
    expect(quota).toEqual([{ creations: { used: 1, max: 5 }, samImages: { used: 0, max: 50 } }]);
    await expect(p.chat({ model: "spark", messages: [], maxTokens: 10 }, { creationId: "c9" })).rejects.toMatchObject({ code: "creation_call_limit", action: "start-over" });
  });

  it("asks once more when the connection drops mid-answer, then says it was the connection", async () => {
    const dropped = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new TypeError("net::ERR_QUIC_GOAWAY_REQUEST_CAN_BE_RETRIED"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const ok = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    const once = mockFetch([dropped, ok]);
    const p = new DopplDemoProvider("https://worker.example", async () => "DOPPL-CODE", { fetch: once.fetchImpl, backoffMs: 1 });
    expect((await p.chat({ model: "spark", messages: [], maxTokens: 10 }, { creationId: "c9" })).content).toBe("ok");
    expect(once.calls).toHaveLength(2);
    const twice = new OpenAICompatibleProvider(meta, async () => "k", { fetch: mockFetch([dropped, dropped]).fetchImpl, backoffMs: 1 });
    const err = await twice.chat({ model: "m", messages: [], maxTokens: 5 }, {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "connection_dropped", action: "retry", detail: expect.stringContaining("ERR_QUIC_GOAWAY") });
    expect((err as Error).message).toBe("Doppl lost its connection to the AI service while the answer came in. Check your internet connection and try again.");
    // A raw network error that reaches a run is the connection's, not the app's.
    const { toExecutionError } = await import("../electron/core/services/runService");
    expect(toExecutionError(new TypeError("net::ERR_CONNECTION_RESET"), "Adobe Photoshop").message).toBe("The connection dropped while Doppl was working. Check your internet connection and try again.");
  });

  it("segments with SAM through the Responses API", async () => {
    const { fetchImpl, calls } = mockFetch([() => sse([{ type: "response.output_text.delta", delta: "<|box;x1=1;y1=2;x2=30;y2=40;w=100;h=80|>" }])]);
    const p = new OpenAICompatibleProvider(meta, async () => "k", { fetch: fetchImpl });
    expect(await p.segment!({ model: "sam", image: "data:image/png;base64,AA", prompts: ["jar"] }, {})).toEqual([[{ x1: 1, y1: 2, x2: 30, y2: 40, w: 100, h: 80 }]]);
    expect(calls[0].url).toBe("https://api.example/v1/responses");
  });
});

describe("AI access: routes, keys and spend per provider", () => {
  async function access(provider: "doppl-demo" | "meta-api", secrets: Record<string, string>) {
    const { JsonStorage } = await import("../electron/core/services/storage");
    const { SettingsService } = await import("../electron/core/services/settingsService");
    const { AiAccessService } = await import("../electron/core/services/aiAccessService");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-access-"));
    const settings = new SettingsService(new JsonStorage(dir));
    await settings.load();
    await settings.save({ aiProvider: provider });
    const store = { ...secrets };
    const secretStore = { has: async (n: string) => n in store, get: async (n: string) => store[n] ?? null, set: async (n: string, v: string | null) => void (v === null ? delete store[n] : (store[n] = v)), available: async () => true };
    const sent: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      sent.push(url);
      return json(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } });
    };
    const a = new AiAccessService({ settings, secrets: secretStore as never, workerUrl: "https://worker.example", registryData: data, fetch: fetchImpl });
    return { a, settings, sent, store };
  }

  it("opens without touching the Keychain: the summary only asks what's saved", async () => {
    const { a } = await access("doppl-demo", { accessCode: "DOPPL-1" });
    const secrets = (a as unknown as { deps: { secrets: Record<string, unknown> } }).deps.secrets;
    const locked = () => {
      throw new Error("read the Keychain");
    };
    secrets.get = locked;
    secrets.available = locked;
    const summary = await a.summary();
    expect(summary.accessCode).toEqual({ saved: true, hint: null });
    expect(summary.ownKey).toEqual({ saved: false, hint: null });
  });

  it("doesn't ask whether encryption works until something is saved", async () => {
    const { a } = await access("doppl-demo", {});
    const secrets = (a as unknown as { deps: { secrets: Record<string, unknown> } }).deps.secrets;
    let asked = 0;
    secrets.available = async () => (asked++, false);
    expect((await a.describe()).encryptionAvailable).toBe(true);
    expect(asked).toBe(0);
    await (secrets.set as (n: string, v: string) => Promise<void>)("metaApiKey", "k");
    expect((await a.describe()).encryptionAvailable).toBe(false);
    expect(asked).toBe(1);
  });

  it("sends Meta's models to the demo Worker or to Meta with the own key, and custom models to their endpoint", async () => {
    const demo = await access("doppl-demo", { accessCode: "DOPPL-1" });
    demo.a.useRoles({ planner: { model: "spark" }, coder: { model: "spark" }, reviewer: { model: "spark" }, segmenter: { model: "spark" } });
    await demo.a.gateway.chat("planner", { messages: [{ role: "user", content: "x" }], maxTokens: 10 }, ctx());
    expect(demo.sent).toEqual(["https://worker.example/v1/chat"]);
    expect(demo.a.callLimit()).toBe(15);

    const own = await access("meta-api", { metaApiKey: "k" });
    own.a.useRoles({ planner: { model: "spark" }, coder: { model: "spark" }, reviewer: { model: "spark" }, segmenter: { model: "spark" } });
    await own.a.gateway.chat("planner", { messages: [{ role: "user", content: "x" }], maxTokens: 10 }, ctx());
    expect(own.sent).toEqual(["https://api.example/v1/chat/completions"]);
    expect(own.a.callLimit()).toBeUndefined();
    // Spend with the own key counts toward its monthly limit: $1.25 for a million input tokens.
    expect(own.settings.ownKeySpend()).toBeCloseTo(1.25, 6);
    await own.settings.save({ monthlySpendLimit: 1 });
    await expect(own.a.gateway.chat("planner", { messages: [{ role: "user", content: "x" }], maxTokens: 10 }, ctx())).rejects.toMatchObject({ code: "spend_limit" });

    const info = await own.a.saveCustomEndpoint({ displayName: "Local", baseUrl: "http://localhost:1234/v1/", model: "qwen", structuredOutput: false, vision: false, key: "sk-local" });
    const id = info.customEndpoints[0].id;
    expect(info.customEndpoints[0]).toMatchObject({ baseUrl: "http://localhost:1234/v1", key: { saved: true, hint: "…ocal" } });
    expect(own.store[`provider:custom:${id}`]).toBe("sk-local");
    await own.a.setRoleOverrides({ coder: { model: `custom:${id}` } });
    own.a.useRoles(undefined);
    await own.a.gateway.chat("coder", { messages: [{ role: "user", content: "x" }], maxTokens: 10 }, ctx());
    expect(own.sent.at(-1)).toBe("http://localhost:1234/v1/chat/completions");
    expect(own.settings.providerSpend(`custom:${id}`)).toBe(0);
    await own.a.removeCustomEndpoint(id);
    expect((await own.a.modelsInfo()).overrides.coder).toBeUndefined();
  });

  it("won't pick a model that trains on data, or one that can't do the role", async () => {
    const { a } = await access("meta-api", { metaApiKey: "k" });
    await expect(a.setRoleOverrides({ planner: { model: "spark-contributor" } })).rejects.toThrow("may train on what it's sent");
    await expect(a.setRoleOverrides({ reviewer: { model: "plain" } })).rejects.toThrow("can't look at images");
    data.models.push({ ...data.models[0], id: "backup", backupOnly: true });
    await expect(a.setRoleOverrides({ coder: { model: "backup" } })).rejects.toThrow("can't be picked here");
    expect((await a.modelsInfo()).models.map((m) => m.id)).not.toContain("backup");
    data.models.pop();
  });
});

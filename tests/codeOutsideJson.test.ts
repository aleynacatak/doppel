import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { Role } from "../electron/core/ai/gateway";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { ChatMessage } from "../electron/core/services/aiTransport";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { type CreationOptions, RoutineService } from "../electron/core/services/routineService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Creation, QcCheck, RunOutput } from "../electron/core/types";

// Creation with the code outside the JSON: the planner proposes the routine with "@code:1" and a plan written first,
// the coder writes the script as plain text, and Doppl validates, tries and saves it. Steps count answers; AI calls
// count every call; each version records which model served each role.

let dir: string;
let service: RoutineService;
let library: LibraryService;
let calls: { role: string; kind: "turn" | "code"; messages: ChatMessage[] }[];
let script: () => string;
let options: Partial<CreationOptions>;
let callLimit: number | undefined;
let nextTurn: () => Record<string, unknown>;
let reviewed: { customSteps?: string[] }[];
let review: (outputs: RunOutput[]) => Record<string, QcCheck[]>;

function fakePhotoshop(): DesignAppAdapter {
  return {
    id: "photoshop",
    name: "Adobe Photoshop",
    stageKind: "script",
    qcChecks: [],
    capabilityManifest: () => "photoshop guide",
    lintScript: (s: string) => (/catch \(e\) \{\}/.test(s) ? ["A Photoshop step is wrapped in an empty catch"] : []),
    getAppVersion: async () => "27.0",
    listOpenDocuments: async () => [],
    inspectForModel: async () => ({}),
    beginStage: async () => ({ state: {} }),
    endStage: async () => undefined,
    endRun: async () => undefined,
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      await fs.mkdir(ctx.workDir, { recursive: true });
      const item = input.item as { stem: string };
      const file = path.join(ctx.workDir, `${item.stem}.png`);
      await fs.writeFile(file, "png");
      return { ok: true, outputs: [{ key: `${input.key}-file-1`, label: path.basename(file), filePath: file }], values: { cutouts: [file] }, findings: [], log: [] };
    },
  } as unknown as DesignAppAdapter;
}

const proposal = {
  name: "Cut out photos",
  app: "photoshop",
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  iterate: { input: "photos" },
  outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  steps: ["Removes the background", "Saves a PNG"],
  script: "@code:1",
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-code-"));
  calls = [];
  options = {};
  callLimit = undefined;
  reviewed = [];
  review = () => ({});
  nextTurn = () => ({ plan: "Opens each photo, removes the white background with the helper, exports a PNG.", action: "propose_routine", reason: "Cut out", routine: proposal });
  script = () => 'var img = openDocument(ctx.item.path);\nremoveWhiteBackground(img);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));';
  const registry = new AdapterRegistry([fakePhotoshop()]);
  const storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  library = new LibraryService({ storage, starters });
  const flows = new FlowService({ storage, library, starters, registry });
  const usage = (role: Role, ctx: Parameters<AiService["turn"]>[3]) =>
    ctx.onUsage?.({ role, model: role === "coder" ? "muse-spark-1.3" : "muse-spark-1.3", provider: "doppl-demo", usage: { input: 100, cached: 0, output: 50 }, costUsd: 0.001 });
  const ai: AiService = {
    async turn(messages, _schema, _actions, ctx, opts) {
      ctx.onAiCall();
      usage(opts?.role ?? "planner", ctx);
      calls.push({ role: opts?.role ?? "planner", kind: "turn", messages: structuredClone(messages) });
      return nextTurn();
    },
    async writeCode(messages, _lang, ctx) {
      ctx.onAiCall();
      usage("coder", ctx);
      calls.push({ role: "coder", kind: "code", messages: structuredClone(messages) });
      return script();
    },
    fieldKey: (_role, field) => (field === "plan" ? "a0_plan" : field),
    reviewTrial: async (_task, draft, outputs) => {
      reviewed.push({ customSteps: draft.customSteps });
      return review(outputs);
    },
    reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
    checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
  };
  service = new RoutineService({
    storage,
    registry,
    library,
    flows,
    ai,
    access: { ensureReady: async () => undefined, provider: () => "doppl-demo", refreshSession: async () => ({ ok: true, value: { session: null } }), noteQuota: () => undefined, callLimit: () => callLimit } as unknown as AiAccessService,
    qc: new QcService(ai),
    getStyle: async () => null,
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    emit: () => undefined,
    workRoot: path.join(dir, "work"),
    templates: [],
    options: () => options,
  });
  await fs.writeFile(path.join(dir, "fig.jpg"), "jpg");
});

async function until(id: string, done: (c: Creation) => boolean): Promise<Creation> {
  for (let i = 0; i < 400; i++) {
    const c = service.getCreation(id)!;
    if (done(c) || c.status === "failed") return c;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

const create = () => service.create({ request: "Cut out the photos", references: [path.join(dir, "fig.jpg")], appId: "photoshop", apps: [{ appId: "photoshop", noDocument: true }] });
const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(""));

describe("code outside the JSON", () => {
  it("asks the coder for the code after the planner's proposal, and records which model served each role", async () => {
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(calls.map((x) => [x.kind, x.role])).toEqual([
      ["turn", "planner"],
      ["code", "coder"],
    ]);
    // The planner's prompt describes the format: the plan first under its model's key, code by reference, worked examples.
    const system = text(calls[0].messages[0]);
    expect(system).toContain('Always start with "a0_plan"');
    expect(system).toContain('set the routine\'s "script" to "@code:1"');
    expect(system).toContain("Worked examples");
    // The coder sees the proposal and the request for the code.
    expect(text(calls[1].messages.at(-1)!)).toContain("ONE ```javascript block");
    expect(ready.draft!.kind === "script" && ready.draft!.script).toContain("removeWhiteBackground(img)");
    expect(ready.aiCalls).toBe(2);
    expect(ready.steps).toBe(1);
    const saved = await service.save(c.id, { name: "" });
    expect(saved.routine!.versions[0].provenance).toEqual({
      planner: { model: "muse-spark-1.3", provider: "doppl-demo", calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
      coder: { model: "muse-spark-1.3", provider: "doppl-demo", calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
    });
  });

  it("sends a script that hides failures back, and asks again", async () => {
    let n = 0;
    script = () => (++n === 1 ? 'try { executeAction(1); } catch (e) {}\nctx.output("cutouts", "x");' : 'var img = openDocument(ctx.item.path);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));');
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(calls.map((x) => x.kind)).toEqual(["turn", "code", "turn", "code"]);
    expect(text(calls[2].messages.at(-1)!)).toContain("empty catch");
    expect(ready.aiCalls).toBe(4);
    expect(ready.steps).toBe(2);
  });

  it("stops at the provider's limit on real calls per creation", async () => {
    callLimit = 7;
    script = () => "try { executeAction(1); } catch (e) {}";
    const c = await create();
    const failed = await until(c.id, (x) => x.status === "failed");
    expect(failed.error?.message).toContain("AI limit");
    // 7 calls at most, keeping 3 for the review: two steps of two calls.
    expect(failed.aiCalls).toBe(4);
  });

  it("keeps the code inside the JSON with the earlier format (evals compare both)", async () => {
    options = { codeFormat: "inline", planField: false, workedExamples: false };
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    // The model still answers "@code:1" here, so the routine has no code: the validator sends it back each time.
    expect(ready.status).toBe("failed");
    expect(calls.every((x) => x.kind === "turn" && x.role === "coder")).toBe(true);
    expect(text(calls[0].messages[0])).not.toContain("a0_plan");
    expect(text(calls[0].messages[0])).not.toContain("Worked examples");
  });

  it("lets the model search building blocks and read their docs, then pins and tags the draft", async () => {
    const answers = [
      { plan: "Find a block that masks white.", action: "search_helpers", query: "mask white background" },
      { plan: "Read its docs.", action: "get_helper_docs", ids: ["ps.maskWhiteBackground"] },
      { plan: "Mask, then export.", action: "propose_routine", reason: "Cut out", routine: proposal },
    ];
    nextTurn = () => answers.shift()!;
    script = () => '// step 1\nvar img = openDocument(ctx.item.path);\nimg.activeLayer.duplicate();\nmaskWhiteBackground(img.activeLayer);\n// step 2\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));';
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(text(calls[0].messages[0])).toContain('"search_helpers": finds building blocks');
    expect(text(calls[1].messages.at(-1)!)).toContain("- maskWhiteBackground (ps.maskWhiteBackground v1)");
    expect(text(calls[2].messages.at(-1)!)).toContain("### maskWhiteBackground");
    expect(ready.draft!.helpers).toEqual({ "ps.openDocument": 1, "ps.maskWhiteBackground": 1, "ps.exportImage": 1 });
    expect(ready.draft!.steps.map((s) => s.kind)).toEqual(["custom", "tested"]);
    expect(reviewed.at(-1)!.customSteps).toEqual(["Removes the background"]);
    const saved = await service.save(c.id, { name: "" });
    expect(saved.routine).toMatchObject({ helpers: { "ps.maskWhiteBackground": 1 } });
  });

  it("updates a routine to an improved building block without AI, showing before and after", async () => {
    const { blocks } = await import("../electron/core/blocks/registry");
    blocks.usePersonalDir(path.join(dir, "helpers"));
    try {
      script = () => 'var img = openDocument(ctx.item.path);\nremoveWhiteBackground(img);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));';
      const c = await create();
      await until(c.id, (x) => x.status === "ready");
      const { routine } = await service.save(c.id, { name: "" });
      expect(routine!.helpers).toEqual({ "ps.openDocument": 1, "ps.removeWhiteBackground": 1, "ps.exportImage": 1 });
      const v1 = blocks.get("ps.removeWhiteBackground", 1)!;
      await blocks.savePersonal({ ...v1, version: 2, summary: "Better edges" });
      const before = calls.length;
      const update = await service.updateBlocks(routine!.id);
      // It never ran, so there are no test items yet: like Refine, it asks for a sample.
      const waiting = await until(update.id, (x) => x.status === "waiting" || x.status === "ready");
      if (waiting.status === "waiting") {
        await service.addSamples(update.id, { files: [path.join(dir, "fig.jpg")], folders: [] });
        await service.confirmSamples(update.id);
      }
      const ready = await until(update.id, (x) => x.status === "ready");
      expect(ready.error).toBeUndefined();
      expect(ready.status).toBe("ready");
      expect(calls.length).toBe(before);
      expect(ready.aiCalls).toBe(0);
      expect(ready.refine).toMatchObject({ blockUpdate: true, changeSummary: "Uses the improved building blocks: removeWhiteBackground 1 → 2." });
      expect(ready.refine!.before.length).toBeGreaterThan(0);
      expect(ready.outputs.length).toBeGreaterThan(0);
      const saved = await service.save(update.id, { name: "" });
      expect(saved.routine).toMatchObject({ version: 2, helpers: { "ps.removeWhiteBackground": 2, "ps.openDocument": 1 } });
      expect(saved.routine!.versions.at(-1)).toMatchObject({ version: 2, aiCalls: 0, note: "Uses the improved building blocks: removeWhiteBackground 1 → 2." });
      await expect(service.updateBlocks(routine!.id)).rejects.toThrow("up to date");
    } finally {
      blocks.usePersonalDir(null);
    }
  });
});

describe("the review of the trial", () => {
  const missing = (outputs: RunOutput[]) =>
    Object.fromEntries(outputs.map((o) => [o.id, [{ level: "visual" as const, label: "AI visual review", passed: false, reason: "Crop marks are missing" }]]));
  const check = (c: Creation) => c.stages.find((s) => s.key === "check")!.detail;

  it("sends results that miss part of the request back once, and ends ready when the fix works", async () => {
    let n = 0;
    review = (outputs) => (++n === 1 ? missing(outputs) : {});
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(reviewed).toHaveLength(2);
    expect(calls.map((x) => x.kind)).toEqual(["turn", "code", "turn", "code"]);
    expect(text(calls[2].messages.at(-1)!)).toContain("Crop marks are missing");
    expect(check(ready)).toBe("All checks passed");
  });

  it("says what's still missing after one more try, not only how many were flagged", async () => {
    review = missing;
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(reviewed).toHaveLength(2);
    expect(check(ready)).toBe("1 flagged: Crop marks are missing");
  });

  it("keeps the routine that ran when the fix doesn't work out", async () => {
    let n = 0;
    review = (outputs) => (++n === 1 ? missing(outputs) : {});
    let written = 0;
    const good = script();
    script = () => (++written === 1 ? good : "try { executeAction(1); } catch (e) {}");
    callLimit = 10;
    const c = await create();
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.status).toBe("ready");
    expect(ready.draft!.kind === "script" && ready.draft!.script).toBe(good);
    expect(ready.outputs).toHaveLength(1);
    expect(check(ready)).toBe("1 flagged: Crop marks are missing");
    expect(ready.activity?.at(-1)).toContain("kept the routine that ran");
  });
});

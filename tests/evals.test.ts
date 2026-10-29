import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import { AiError } from "../electron/core/services/aiTransport";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RoutineService } from "../electron/core/services/routineService";
import { RunService } from "../electron/core/services/runService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import { resolvePort, runChecks } from "../electron/evals/checks";
import { decodePng, encodePng, jpegSize } from "../electron/evals/images";
import { compareSummaries, csvReport, markdownReport, parseCsvReport, summarize, writeReports } from "../electron/evals/report";
import { type AttemptResult, type EvalEnv, type Meter, runEval } from "../electron/evals/runner";
import { type EvalTask, loadTasks, parseTask, selectTasks } from "../electron/evals/tasks";

// The eval harness on synthetic tasks: task files, deterministic checks, reports, and whole attempts through the real
// creation loop with a scripted AI and a fake Photoshop.

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-evals-"));
});

/** A 40×30 product on white (opaque) or cut out (transparent background). */
const product = (cut: boolean) => encodePng(40, 30, (x, y) => (x >= 10 && x < 30 && y >= 8 && y < 22 ? [200, 90, 30, 255] : cut ? [255, 255, 255, 0] : [255, 255, 255, 255]));

async function writeTask(id: string, task: Record<string, unknown>, images = 2) {
  const tdir = path.join(dir, "tasks", id);
  await fs.mkdir(path.join(tdir, "fixtures", "images"), { recursive: true });
  for (let i = 1; i <= images; i++) await fs.writeFile(path.join(tdir, "fixtures", "images", `p${i}.png`), product(false));
  await fs.writeFile(path.join(tdir, "task.json"), JSON.stringify({ id, ...task }));
  return tdir;
}

const cutoutTask = {
  app: "photoshop",
  request: "Remove the white background and save transparent PNGs.",
  attachments: { inputs: { images: "fixtures/images" } },
  checks: [
    { type: "outputCount", port: "pngs", equals: "inputCount:images" },
    { type: "fileExtension", port: "pngs", is: "png" },
    { type: "hasTransparency", port: "pngs" },
    { type: "cornerPixelsTransparent", port: "pngs" },
    { type: "fileNamePattern", port: "pngs", stemsFrom: "images" },
    { type: "noRunErrors" },
  ],
  tags: ["photoshop", "masking"],
};

describe("tasks", () => {
  it("reads task files and selects them by id or tag", async () => {
    await writeTask("ps-cutout", cutoutTask);
    await writeTask("fg-text", { ...cutoutTask, app: "figma", mode: "simulated", tags: ["figma"] });
    const tasks = await loadTasks(path.join(dir, "tasks"));
    expect(tasks.map((t) => [t.id, t.mode])).toEqual([
      ["fg-text", "simulated"],
      ["ps-cutout", "real"],
    ]);
    expect(selectTasks(tasks, "masking").map((t) => t.id)).toEqual(["ps-cutout"]);
    expect(selectTasks(tasks, "fg-text,photoshop").map((t) => t.id)).toEqual(["fg-text", "ps-cutout"]);
    expect(selectTasks(tasks, "all")).toHaveLength(2);
    expect(() => selectTasks(tasks, "nope")).toThrow('No task or tag named "nope"');
  });

  it("explains what's wrong with a task file", () => {
    expect(() => parseTask({ id: "x", app: "sketch", request: "r", checks: [{ type: "noRunErrors" }] }, "/t/x")).toThrow('"app" must be');
    expect(() => parseTask({ id: "x", app: "figma", request: "r", checks: [{ type: "colorful" }] }, "/t/x")).toThrow('unknown type "colorful"');
    expect(() => parseTask({ id: "x", app: "figma", request: "r", checks: [{ type: "fileExtension", is: "png" }] }, "/t/x")).toThrow('needs a "port"');
  });
});

describe("checks", () => {
  it("decodes PNG pixels and reads JPEG sizes", () => {
    const img = decodePng(product(true));
    expect([img.width, img.height, img.alpha]).toEqual([40, 30, true]);
    expect(img.pixel!(0, 0)).toEqual([255, 255, 255, 0]);
    expect(img.pixel!(15, 15)).toEqual([200, 90, 30, 255]);
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c]);
    expect(jpegSize(sof)).toEqual({ width: 300, height: 200 });
  });

  it("matches a check's port loosely: key, label, file type, only file output", () => {
    const ports = [
      { key: "cutouts", label: "Cut-outs", type: "fileList" as const, required: true, extensions: ["png"] },
      { key: "psds", label: "Masked PSDs", type: "fileList" as const, required: true, extensions: ["psd"] },
    ];
    expect(resolvePort("cutouts", ports)).toBe("cutouts");
    expect(resolvePort("Masked PSDs", ports)).toBe("psds");
    expect(resolvePort("pngs", ports)).toBe("cutouts");
    expect(resolvePort("images", ports, "png")).toBe("cutouts");
    expect(resolvePort("labels", ports)).toBeNull();
  });

  it("finds white left around or inside the subject, and passes a trimmed product that fills its canvas", async () => {
    const out = path.join(dir, "white");
    await fs.mkdir(out, { recursive: true });
    const ring = (hole: [number, number, number, number]) =>
      encodePng(40, 40, (x, y) => {
        const d = Math.hypot(x - 19.5, y - 19.5);
        return d < 8 ? hole : d < 18 ? [40, 80, 200, 255] : [255, 255, 255, 0];
      });
    await fs.writeFile(path.join(out, "box.png"), encodePng(30, 20, () => [40, 140, 70, 255]));
    await fs.writeFile(path.join(out, "ring-cut.png"), ring([255, 255, 255, 0]));
    await fs.writeFile(path.join(out, "ring-white.png"), ring([255, 255, 255, 255]));
    await fs.writeFile(path.join(out, "uncut.png"), encodePng(40, 40, (x, y) => (x > 10 && x < 30 && y > 10 && y < 30 ? [40, 80, 200, 255] : [255, 255, 255, 255])));
    const ports = [{ key: "cutouts", label: "Cutouts", type: "fileList" as const, required: true, extensions: ["png"] }];
    const check = (files: string[]) =>
      runChecks([{ type: "noOpaqueWhite", port: "cutouts" }, { type: "cornerPixelsTransparent", port: "cutouts" }], {
        ports,
        files: { cutouts: files.map((f) => path.join(out, f)) },
        texts: {},
        inputs: {},
        run: { status: "succeeded", errors: [] },
      });
    expect((await check(["box.png", "ring-cut.png"])).map((r) => r.passed)).toEqual([true, false]);
    const [white, corners] = await check(["ring-white.png"]);
    expect(white.passed).toBe(false);
    expect(white.detail).toMatch(/^ring-white\.png: 13\.0% of the pixels are opaque white/);
    expect(corners.passed).toBe(true);
    const outer = (f: string) =>
      runChecks([{ type: "outerWhiteRemoved", port: "cutouts" }], { ports, files: { cutouts: [path.join(out, f)] }, texts: {}, inputs: {}, run: { status: "succeeded", errors: [] } });
    expect((await outer("ring-white.png"))[0].passed).toBe(true);
    expect((await outer("box.png"))[0].passed).toBe(true);
    const [uncut] = await outer("uncut.png");
    expect(uncut.passed).toBe(false);
    expect(uncut.detail).toMatch(/^uncut\.png: 7\d\.\d% of the pixels are opaque white around the subject/);
  });

  it("passes and fails each kind of check", async () => {
    const out = path.join(dir, "out");
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, "p1.png"), product(true));
    await fs.writeFile(path.join(out, "p2.png"), product(false));
    await fs.writeFile(path.join(out, "notes.txt"), "Apricot jam · 4.50");
    const ports = [{ key: "cutouts", label: "Cutouts", type: "fileList" as const, required: true, extensions: ["png"] }];
    const subject = {
      ports,
      files: { cutouts: [path.join(out, "p1.png"), path.join(out, "p2.png")] },
      texts: { cutouts: ["Label for Fig jam"] },
      inputs: { images: { files: ["/x/p1.png", "/x/p2.png"], rows: 0 }, data: { files: ["/x/d.csv"], rows: 3 } },
      run: { status: "succeeded", errors: [] },
    };
    const results = await runChecks(
      [
        { type: "outputCount", port: "pngs", equals: "inputCount:images" },
        { type: "outputCount", port: "pngs", equals: "inputCount:data" },
        { type: "fileExtension", port: "pngs", is: "png" },
        { type: "imageSize", port: "pngs", width: 40, height: 30 },
        { type: "imageSize", port: "pngs", maxWidth: 20 },
        { type: "hasTransparency", port: "pngs" },
        { type: "cornerPixelsTransparent", port: "pngs" },
        { type: "fileNamePattern", port: "pngs", pattern: "^p\\d\\.png$", stemsFrom: "images" },
        { type: "textContains", text: "Fig jam" },
        { type: "noRunErrors" },
      ],
      subject,
    );
    expect(results.map((r) => [r.check.type, r.passed])).toEqual([
      ["outputCount", true],
      ["outputCount", false],
      ["fileExtension", true],
      ["imageSize", true],
      ["imageSize", false],
      ["hasTransparency", false],
      ["cornerPixelsTransparent", false],
      ["fileNamePattern", true],
      ["textContains", true],
      ["noRunErrors", true],
    ]);
    expect(results[5].detail).toBe("p2.png: no transparent pixels");
    expect(results[1].detail).toBe('2 files in "cutouts", expected 3');
  });
});

describe("reports", () => {
  const attempt = (profile: string, passed: boolean, calls: number, extra: Partial<AttemptResult> = {}): AttemptResult => ({
    task: "t1",
    profile,
    repeat: 1,
    created: true,
    passed,
    category: passed ? null : "check-failed",
    aiCalls: calls,
    inputTokens: 1000,
    cachedTokens: 0,
    outputTokens: 500,
    costUsd: 0.0034,
    wallSec: 12,
    previews: 1,
    proposals: 1,
    questions: 0,
    contextChars: 9000,
    rerunAiCalls: 0,
    checks: [],
    ...extra,
  });

  it("summarizes per profile, writes Markdown and CSV, and compares profiles", async () => {
    const results = [attempt("a", true, 4), attempt("a", false, 9, { error: 'hasTransparency: "x, y"' }), attempt("b", true, 3), attempt("b", true, 5)];
    const [a, b] = summarize(results);
    expect(a).toMatchObject({ profile: "a", passed: 1, attempts: 2, passRate: 0.5, avgCalls: 6.5, callsPerPass: 4, tokensPerPass: 1500, failures: { "check-failed": 1 } });
    expect(b).toMatchObject({ profile: "b", passRate: 1, callsPerPass: 4 });
    expect(markdownReport(results, { date: "2026-10-29", profiles: ["a", "b"], tasks: ["t1"], repeat: 2 })).toContain("| a | 1/2 | 50% |");
    const checked = attempt("c", false, 2, { checks: [{ check: { type: "hasTransparency", port: "pngs" }, passed: true, detail: "ok; fine" }, { check: { type: "noRunErrors" }, passed: false, detail: "2 errors" }] });
    expect(parseCsvReport(csvReport([checked]))[0].checks.map((c) => [c.check.type, c.passed, c.detail])).toEqual([
      ["hasTransparency", true, "ok; fine"],
      ["noRunErrors", false, "2 errors"],
    ]);
    expect(parseCsvReport(csvReport(results)).map((r) => [r.profile, r.passed, r.aiCalls, r.error ?? ""])).toEqual([
      ["a", true, 4, ""],
      ["a", false, 9, 'hasTransparency: "x, y"'],
      ["b", true, 3, ""],
      ["b", true, 5, ""],
    ]);
    const files = await writeReports(path.join(dir, "reports"), results, { date: "2026-10-29", tasks: ["t1"], repeat: 2 });
    expect(files.map((f) => path.basename(f))).toEqual(["2026-10-29-a.md", "2026-10-29-a.csv", "2026-10-29-b.md", "2026-10-29-b.csv", "2026-10-29-compare-a-vs-b.md"]);
    expect(compareSummaries(a, b)).toContain("| Pass rate | 50% (1/2) | 100% (2/2) |");
    const compare = await fs.readFile(files[4], "utf8");
    expect(compare).toContain("## Before / after");
    expect(compare).toContain("| AI calls per successful creation | 4 | 4 |");
    expect(await fs.readFile(files[0], "utf8")).not.toContain("## Before / after");
  });
});

describe("running tasks through the creation loop", () => {
  function fakePhotoshop(transparent: boolean): DesignAppAdapter {
    return {
      id: "photoshop",
      name: "Adobe Photoshop",
      stageKind: "script",
      qcChecks: [],
      capabilityManifest: () => "photoshop guide",
      getStatus: async () => "connected",
      getAppVersion: async () => "27.0",
      getDetail: async () => undefined,
      listOpenDocuments: async () => [],
      inspectForModel: async () => ({}),
      renderPreview: async () => ({ kind: "image", src: "data:image/png;base64,AA", label: "p" }),
      beginStage: async () => ({ state: {} }),
      endStage: async () => undefined,
      endRun: async () => undefined,
      async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
        await fs.mkdir(ctx.workDir, { recursive: true });
        const item = input.item as { stem: string };
        const file = path.join(ctx.workDir, `${item.stem}.png`);
        await fs.writeFile(file, product(transparent));
        return { ok: true, outputs: [{ key: `${input.key}-file-1`, label: path.basename(file), filePath: file }], values: { cutouts: [file] }, findings: [], log: [] };
      },
    } as unknown as DesignAppAdapter;
  }

  const routine = {
    name: "Cut out products",
    app: "photoshop",
    inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["png", "jpg"] }],
    iterate: { input: "photos" },
    outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
    settings: [],
    steps: ["Removes the white background", "Saves a PNG"],
    script: 'var img = openDocument(ctx.item.path);\nremoveWhiteBackground(img);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
  };

  function env(opts: { transparent: boolean; answer: () => Record<string, unknown> }): EvalEnv {
    return {
      async services({ dataDir, meter }) {
        const registry = new AdapterRegistry([fakePhotoshop(opts.transparent)]);
        const storage = new JsonStorage(path.join(dataDir, "data"));
        const starters = new StarterService(path.join(dataDir, "none"));
        await starters.load();
        const library = new LibraryService({ storage, starters });
        const flows = new FlowService({ storage, library, starters, registry });
        const ai: AiService = {
          async turn(messages, _schema, _actions, ctx) {
            ctx.onAiCall();
            const m = meter as Meter;
            m.calls++;
            if (!m.contextChars) m.contextChars = String(messages[0].content).length;
            const t = opts.answer();
            if (t.action === "propose_routine") m.proposals++;
            return t;
          },
          reviewTrial: async () => ({}),
          reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
          checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
        } as AiService;
        const access = { ensureReady: async () => undefined, provider: () => "meta-api", noteQuota: () => undefined } as unknown as AiAccessService;
        const apps = { statusOf: async () => "connected" } as unknown as AppStatusService;
        const qc = new QcService(ai);
        const runs = new RunService({ storage, library, flows, registry, apps, qc, access, emit: () => undefined, runsDir: path.join(dataDir, "runs"), copiesDir: path.join(dataDir, "copies") });
        const routines = new RoutineService({ storage, registry, library, flows, ai, access, qc, getStyle: async () => null, apps, emit: () => undefined, workRoot: path.join(dataDir, "work"), templates: [] });
        return { routines, runs, library };
      },
    };
  }

  async function task(): Promise<EvalTask> {
    const tdir = await writeTask("ps-cutout", cutoutTask);
    return parseTask(JSON.parse(await fs.readFile(path.join(tdir, "task.json"), "utf8")), tdir);
  }

  it("creates, saves, reruns the saved routine without AI and checks its outputs", async () => {
    const t = await task();
    const results = await runEval(env({ transparent: true, answer: () => ({ action: "propose_routine", reason: "Cut out", routine }) }), [t], [{ id: "scripted" }], 2, { workDir: path.join(dir, "work") });
    expect(results.map((r) => [r.repeat, r.created, r.passed, r.category, r.aiCalls, r.proposals, r.rerunAiCalls])).toEqual([
      [1, true, true, null, 1, 1, 0],
      [2, true, true, null, 1, 1, 0],
    ]);
    expect(results[0].checks.every((c) => c.passed)).toBe(true);
    expect(results[0].contextChars).toBeGreaterThan(1000);
  });

  it("reports a rerun whose outputs fail the checks, and a creation that runs out of AI calls", async () => {
    const t = await task();
    const opaque = await runEval(env({ transparent: false, answer: () => ({ action: "propose_routine", reason: "Cut out", routine }) }), [t], [{ id: "p" }], 1, { workDir: path.join(dir, "w1") });
    expect(opaque[0]).toMatchObject({ created: true, passed: false, category: "check-failed" });
    expect(opaque[0].error).toContain("hasTransparency");
    const broken = await runEval(env({ transparent: true, answer: () => ({ action: "propose_routine", reason: "x", routine: { ...routine, outputs: [] } }) }), [t], [{ id: "p" }], 1, {
      workDir: path.join(dir, "w2"),
    });
    expect(broken[0]).toMatchObject({ created: false, passed: false, category: "call-limit" });
    expect(broken[0].aiCalls).toBeGreaterThan(5);
  });

  it("takes turns between profiles, waits out a rate limit, and stops when AI access runs out", async () => {
    const t = await task();
    let call = 0;
    const answer = () => {
      call++;
      if (call === 2) throw new AiError("rate_limited", "Too many requests in a short time.", "retry");
      if (call === 4) throw new AiError("quota_exhausted", "This access code has no routine creations left.", "own-key");
      return { action: "propose_routine", reason: "Cut out", routine };
    };
    const lines: string[] = [];
    const results = await runEval(env({ transparent: true, answer }), [t], [{ id: "a" }, { id: "b" }], 2, { workDir: path.join(dir, "w3"), rateLimitWaitMs: 0, log: (l) => lines.push(l) });
    expect(results.map((r) => [r.profile, r.repeat, r.passed])).toEqual([
      ["a", 1, true],
      ["b", 1, true],
    ]);
    expect(results.stopped).toBe("Stopped after 2 attempt(s): This access code has no routine creations left.");
    expect(lines.some((l) => l.includes("rate limited: waiting 0 s"))).toBe(true);
  });
});

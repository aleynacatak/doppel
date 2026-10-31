import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { AutoFixService } from "../electron/core/services/autoFixService";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RoutineService } from "../electron/core/services/routineService";
import { RunService } from "../electron/core/services/runService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Routine, Run } from "../electron/core/types";
import { fakeImage } from "./helpers/images";

// The whole way, with a fake Photoshop and a scripted AI: a saved routine runs on photos, one big photo fails inside
// the routine's code, Doppl offers a fix, the designer says yes, Doppl tries it on the big photo and one that worked,
// the designer keeps it: version 2 is saved and the big photo runs again. Version 1 stays restorable.

const photoshop = {
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
  beginStage: async () => ({ state: {} }),
  endStage: async () => undefined,
  endRun: async () => undefined,
  async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
    const script = String(ctx.stage.body);
    const item = input.item as { stem: string };
    // Version 1 can't handle big photos; the fix scales them down first.
    if (item.stem.startsWith("big") && !script.includes("fitImage")) return { ok: false, error: "Error 8800: General Photoshop error occurred. The image is too large.", outputs: [], values: {}, findings: [], log: [], scriptFailure: true };
    await fs.mkdir(ctx.workDir, { recursive: true });
    const file = path.join(ctx.workDir, `${item.stem}.png`);
    await fs.writeFile(file, "png");
    return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { cards: [file] }, findings: [], log: [] };
  },
} as unknown as DesignAppAdapter;

const fixed = {
  name: "Photo cards",
  app: "photoshop",
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  iterate: { input: "photos" },
  outputs: [{ key: "cards", label: "Cards", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  steps: ["Opens the photo", "Scales big photos down", "Saves a card"],
  script: 'var img = openDocument(ctx.item.path);\nfitImage(img, 3000);\nctx.output("cards", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
};

describe("Doppl's own fix, the whole way", () => {
  it("fixes a routine that failed on a new photo, saves version 2, and runs that photo again", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-autofix-"));
    await fs.mkdir(path.join(dir, "photos"));
    for (const f of ["apricot.jpg", "big-fig.jpg", "plum.jpg"]) await fs.writeFile(path.join(dir, "photos", f), fakeImage(f));
    const registry = new AdapterRegistry([photoshop]);
    const storage = new JsonStorage(path.join(dir, "data"));
    const starters = new StarterService(path.join(dir, "starters"));
    await starters.load();
    const library = new LibraryService({ storage, starters });
    const flows = new FlowService({ storage, library, starters, registry });
    const turns: string[] = [];
    const ai: AiService = {
      async turn(messages, schema, _actions, ctx) {
        ctx.onAiCall();
        turns.push(schema.name);
        return { action: "propose_revision", reason: "Scale big photos down", changeSummary: "Scales big photos down before making the card.", routine: fixed };
      },
      reviewTrial: async () => {
        throw new Error("no AI review for Doppl's own fixes");
      },
      reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
      checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
    };
    const access = { ensureReady: async () => undefined, provider: () => "meta-api", noteQuota: () => undefined } as unknown as AiAccessService;
    const apps = { statusOf: async () => "connected" } as unknown as AppStatusService;
    const qc = new QcService(ai);
    let autoFix: AutoFixService | null = null;
    const done: Promise<void>[] = [];
    const runs = new RunService({
      storage,
      library,
      flows,
      registry,
      apps,
      qc,
      access,
      emit: () => undefined,
      runsDir: path.join(dir, "runs"),
      copiesDir: path.join(dir, "copies"),
      onRunFinished: (run) => void done.push(autoFix!.consider(run)),
    });
    const routines = new RoutineService({ storage, registry, library, flows, ai, access, qc, getStyle: async () => null, apps, emit: () => undefined, workRoot: path.join(dir, "work"), templates: [] });
    autoFix = new AutoFixService({ routines, runs, library, access, pollMs: 5 });

    const now = new Date().toISOString();
    const v1: Routine = {
      id: "cards",
      name: "Photo cards",
      appId: "photoshop",
      description: "",
      steps: [{ plainLanguage: "Opens the photo" }, { plainLanguage: "Saves a card" }],
      inputs: fixed.inputs,
      outputs: fixed.outputs,
      settings: [],
      iterate: { input: "photos" },
      kind: "script",
      script: 'var img = openDocument(ctx.item.path);\nctx.output("cards", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
      version: 1,
      createdWithAiCalls: 2,
      appVersion: "27.0",
      requiredFonts: [],
      runs: [],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, createdAt: now, aiCalls: 2, note: "Created" }],
      modifiesDocument: false,
      qcProfile: "web",
      format: 2,
    } as unknown as Routine;
    await library.save(v1);

    const first = await runs.start({ kind: "routine", id: "cards" }, { inputs: { "input-photos": path.join(dir, "photos") }, outputFolders: {}, settings: {}, qcMode: "manual", options: { target: "copy" } });
    // The run ends and Doppl offers a fix; no AI yet.
    for (let i = 0; i < 400 && !(await storage.getRun(first.id))?.fix; i++) await new Promise((r) => setTimeout(r, 10));
    await Promise.all(done);
    expect((await storage.getRun(first.id))?.fix).toMatchObject({ status: "offered", maxCalls: 5 });
    expect(turns).toEqual([]);
    // The designer says yes: the fix is tried, and waits for them.
    await autoFix!.start(first.id);
    expect((await storage.getRun(first.id))?.fix).toMatchObject({ status: "ready", summary: "Scales big photos down before making the card." });
    expect((await library.require("cards")).version).toBe(1);
    // They keep it: version 2, and the big photo runs again.
    await autoFix!.keep(first.id);
    const after = (await storage.getRun(first.id)) as Run;
    expect(after.outputs.filter((o) => o.status === "failed").map((o) => [o.itemLabel, o.cause])).toEqual([["big-fig.jpg", "routine"]]);
    expect(after.fix).toMatchObject({ status: "fixed", routineId: "cards", fromVersion: 1, toVersion: 2, summary: "Scales big photos down before making the card." });
    expect(turns.length).toBeLessThanOrEqual(2);

    let rerun = (await storage.getRun(after.fix!.rerunId!)) as Run;
    for (let i = 0; i < 400 && rerun.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      rerun = (await storage.getRun(after.fix!.rerunId!)) as Run;
    }
    expect(rerun).toMatchObject({ status: "succeeded", autoFixOf: first.id, version: 2 });
    expect(rerun.outputs.filter((o) => o.node === "routine").map((o) => [o.itemLabel, o.status])).toEqual([["big-fig.jpg", "done"]]);

    const v2 = await library.require("cards");
    expect(v2.versions.map((v) => [v.version, v.note])).toEqual([
      [1, "Created"],
      [2, "Adapted by Doppl after a run: Scales big photos down before making the card."],
    ]);
    // Restore brings version 1's routine back.
    const restored = await library.restore("cards", 1);
    expect(restored.script).toBe(v1.script);
  });
});

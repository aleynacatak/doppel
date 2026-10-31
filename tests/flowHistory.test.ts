import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService, routineFlow } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RunService } from "../electron/core/services/runService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Routine } from "../electron/core/types";
import { fakeImage } from "./helpers/images";

// A routine that runs inside a flow lists the flow's run in its own history, so its card doesn't say "Last run: Never".

const photoshop = {
  id: "photoshop",
  name: "Adobe Photoshop",
  stageKind: "script",
  qcChecks: [],
  getStatus: async () => "connected",
  getAppVersion: async () => "27.0",
  listOpenDocuments: async () => [],
  beginStage: async () => ({ state: {} }),
  endStage: async () => undefined,
  async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
    await fs.mkdir(ctx.workDir, { recursive: true });
    const file = path.join(ctx.workDir, `${(input.item as { stem: string }).stem}.png`);
    await fs.writeFile(file, "png");
    return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { cards: [file] }, findings: [], log: [] };
  },
} as unknown as DesignAppAdapter;

it("adds a flow's run to the history of the routines it ran", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-history-"));
  await fs.mkdir(path.join(dir, "photos"));
  await fs.writeFile(path.join(dir, "photos", "fig.jpg"), fakeImage("fig.jpg"));
  const registry = new AdapterRegistry([photoshop]);
  const storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  const library = new LibraryService({ storage, starters });
  const flows = new FlowService({ storage, library, starters, registry });
  const ai = { reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }) } as unknown as AiService;
  const runs = new RunService({
    storage,
    library,
    flows,
    registry,
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    qc: new QcService(ai),
    access: { ensureReady: async () => undefined } as unknown as AiAccessService,
    emit: () => undefined,
    runsDir: path.join(dir, "runs"),
    copiesDir: path.join(dir, "copies"),
  });
  const now = new Date().toISOString();
  const routine = {
    id: "cards",
    name: "Photo cards",
    appId: "photoshop",
    description: "",
    steps: [{ plainLanguage: "Saves a card" }],
    inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
    outputs: [{ key: "cards", label: "Cards", type: "fileList", required: true, extensions: ["png"] }],
    settings: [],
    iterate: { input: "photos" },
    kind: "script",
    script: "ctx.log(1);",
    version: 1,
    createdWithAiCalls: 1,
    appVersion: "27.0",
    requiredFonts: [],
    runs: [],
    createdAt: now,
    updatedAt: now,
    versions: [],
    modifiesDocument: false,
    qcProfile: "web",
    format: 2,
  } as unknown as Routine;
  await library.save(routine);
  const flow = { ...routineFlow(routine), id: "jam-flow", name: "Jam labels" };
  await storage.saveFlow(flow);

  const run = await runs.start({ kind: "flow", id: "jam-flow" }, { inputs: { "input-photos": path.join(dir, "photos") }, outputFolders: { "output-cards": path.join(dir, "out") }, qcMode: "manual", options: { target: "copy" } });
  for (let i = 0; i < 400 && (await storage.getRun(run.id))?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 400 && !(await library.require("cards")).runs.length; i++) await new Promise((r) => setTimeout(r, 5));

  const [entry] = (await library.require("cards")).runs;
  expect(entry).toMatchObject({ id: run.id, status: "succeeded", inFlow: "Jam labels", routineVersion: 1 });
  expect((await storage.getFlow("jam-flow"))!.runs[0].id).toBe(run.id);
});

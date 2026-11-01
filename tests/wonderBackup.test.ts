import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import { AiGateway, DEFAULT_ROLES, mergeRoles } from "../electron/core/ai/gateway";
import type { AIProvider } from "../electron/core/ai/providers";
import { ModelRegistry, costOf } from "../electron/core/ai/registry";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import { AiError } from "../electron/core/services/aiTransport";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { ModelAiService } from "../electron/core/services/modelAiService";
import { QcService } from "../electron/core/services/qcService";
import { RoutineService } from "../electron/core/services/routineService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Creation } from "../electron/core/types";

// Muse Wonder as the backup writer, through the real registry, roles, gateway and AI service (only the provider and
// the app are fake): after two failed trials it writes the code for the rest of that creation.

const SPARK = "muse-spark-1.3";
const WONDER = "muse-wonder-1.0";
const USAGE = { input: 1000, cached: 0, output: 500 };

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
const SCRIPT = 'var img = openDocument(ctx.item.path);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));';

let dir: string;
let service: RoutineService;
let sent: { model: string; effort?: string; writesCode: boolean }[];
let trials: number;
/** Whether a trial works, given the model that wrote its code and how many trials ran before it. */
let works: (coder: string, before: number) => boolean;
/** An error a model answers with, instead of an answer. */
let refuse: (model: string) => AiError | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-wonder-"));
  sent = [];
  trials = 0;
  refuse = () => undefined;
  let coder = SPARK;

  const provider: AIProvider = {
    id: "doppl-demo",
    chat: async (req) => {
      const writesCode = !req.schema;
      sent.push({ model: req.model, effort: req.reasoningEffort, writesCode });
      const refused = refuse(req.model);
      if (refused) throw refused;
      if (!writesCode) return { content: JSON.stringify({ a0_plan: "Open, cut out, export.", action: "propose_routine", reason: "Cut out", routine: proposal }), finishReason: "stop", usage: USAGE };
      coder = req.model;
      return { content: `\`\`\`javascript\n${SCRIPT}\n\`\`\``, finishReason: "stop", usage: USAGE };
    },
  };
  const models = new ModelRegistry();
  const gateway = new AiGateway({
    registry: () => models,
    roles: () => mergeRoles(DEFAULT_ROLES),
    provider: async (model) => ({ adapter: provider, entry: models.demoFor(model.provider)! }),
  });
  const photoshop = {
    id: "photoshop",
    name: "Adobe Photoshop",
    stageKind: "script",
    qcChecks: [],
    capabilityManifest: () => "photoshop guide",
    lintScript: () => [],
    getAppVersion: async () => "27.0",
    listOpenDocuments: async () => [],
    inspectForModel: async () => ({}),
    beginStage: async () => ({ state: {} }),
    endStage: async () => undefined,
    endRun: async () => undefined,
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      if (!works(coder, trials++)) return { ok: false, error: "Error 8800: General Photoshop error occurred.", outputs: [], values: {}, findings: [], log: [], scriptFailure: true };
      await fs.mkdir(ctx.workDir, { recursive: true });
      const file = path.join(ctx.workDir, `${(input.item as { stem: string }).stem}.png`);
      await fs.writeFile(file, "png");
      return { ok: true, outputs: [{ key: `${input.key}-file-1`, label: path.basename(file), filePath: file }], values: { cutouts: [file] }, findings: [], log: [] };
    },
  } as unknown as DesignAppAdapter;

  const registry = new AdapterRegistry([photoshop]);
  const storage = new JsonStorage(path.join(dir, "data"));
  const starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  const library = new LibraryService({ storage, starters });
  const ai = new ModelAiService({ gateway });
  service = new RoutineService({
    storage,
    registry,
    library,
    flows: new FlowService({ storage, library, starters, registry }),
    ai,
    access: { ensureReady: async () => undefined, provider: () => "doppl-demo", refreshSession: async () => ({ ok: true, value: { session: null } }), noteQuota: () => undefined, callLimit: () => 15 } as unknown as AiAccessService,
    qc: new QcService(ai),
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    emit: () => undefined,
    workRoot: path.join(dir, "work"),
    templates: [],
  });
  await fs.writeFile(path.join(dir, "fig.jpg"), "jpg");
});

async function create(): Promise<Creation> {
  const c = await service.create({ request: "Cut out the photos", references: [path.join(dir, "fig.jpg")], appId: "photoshop", apps: [{ appId: "photoshop", noDocument: true }] });
  for (let i = 0; i < 400; i++) {
    const now = service.getCreation(c.id)!;
    if (now.status === "ready" || now.status === "failed") return now;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

const coders = () => sent.filter((s) => s.writesCode).map((s) => s.model);
const switched = (c: Creation) => (c.activity ?? []).filter((a) => a.includes("stronger AI model")).length;

describe("Muse Wonder as the backup writer", () => {
  it("writes the code after two failed trials; Spark keeps planning, and the version says who served each role", async () => {
    works = (coder) => coder === WONDER;
    const ready = await create();
    expect(ready.status).toBe("ready");
    expect(sent).toEqual([
      { model: SPARK, effort: "high", writesCode: false },
      { model: SPARK, effort: "max", writesCode: true },
      { model: SPARK, effort: "high", writesCode: false },
      { model: SPARK, effort: "max", writesCode: true },
      { model: SPARK, effort: "high", writesCode: false },
      { model: WONDER, effort: "high", writesCode: true },
    ]);
    expect(switched(ready)).toBe(1);

    const saved = await service.save(ready.id, { name: "" });
    const provenance = saved.routine!.versions[0].provenance!;
    expect(provenance.planner?.model).toBe(SPARK);
    expect(provenance.coder).toMatchObject({ model: `${SPARK} → ${WONDER}`, calls: 3 });
    const models = new ModelRegistry();
    expect(provenance.coder?.costUsd).toBeCloseTo(2 * costOf(models.model(SPARK), USAGE) + costOf(models.model(WONDER), USAGE), 6);
  });

  it("isn't used when a trial works, or after only one failed trial", async () => {
    works = (_coder, before) => before >= 1;
    const ready = await create();
    expect(ready.status).toBe("ready");
    expect(coders()).toEqual([SPARK, SPARK]);
    expect(switched(ready)).toBe(0);
    const saved = await service.save(ready.id, { name: "" });
    expect(saved.routine!.versions[0].provenance?.coder?.model).toBe(SPARK);
  });

  it("starts over with Spark for the next creation", async () => {
    works = (coder) => coder === WONDER;
    await create();
    sent = [];
    works = () => true;
    await create();
    expect(coders()).toEqual([SPARK]);
  });

  it.each(["model_not_allowed", "own_key_forbidden", "upstream_error", "timeout"])("carries on with Spark when Wonder answers %s, instead of failing the creation", async (code) => {
    refuse = (model) => (model === WONDER ? new AiError(code, "Not available.") : undefined);
    works = (_coder, before) => before >= 2;
    const ready = await create();
    expect(ready.status).toBe("ready");
    expect(coders()).toEqual([SPARK, SPARK, WONDER, SPARK]);
    const saved = await service.save(ready.id, { name: "" });
    expect(saved.routine!.versions[0].provenance?.coder?.model).toBe(SPARK);
  });

  it("doesn't hide problems Spark would have too (out of demo quota, a bad key)", async () => {
    refuse = (model) => (model === WONDER ? new AiError("quota_exhausted", "This access code has no creations left.") : undefined);
    works = () => false;
    const failed = await create();
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("no creations left");
    expect(coders().at(-1)).toBe(WONDER);
  });
});

describe("Muse Wonder in the model list", () => {
  const models = new ModelRegistry();

  it("is a backup only: never offered for a role, never trains on data, and only Spark and SAM serve roles by default", () => {
    const wonder = models.model(WONDER);
    expect(wonder).toMatchObject({ enabled: true, backupOnly: true, dataPolicy: { trainsOnData: false } });
    expect(models.enabled().map((m) => m.id)).toEqual([SPARK, "sam-3.1"]);
    expect([DEFAULT_ROLES.planner.model, DEFAULT_ROLES.coder.model, DEFAULT_ROLES.reviewer.model, DEFAULT_ROLES.segmenter.model]).toEqual([SPARK, SPARK, SPARK, "sam-3.1"]);
    expect(DEFAULT_ROLES.escalation).toEqual({ coder: { afterFailedTrials: 2, to: { model: WONDER, reasoningEffort: "high" } } });
  });

  it("leaves a model picked by hand alone, while an eval profile can still ask for the backup", () => {
    expect(mergeRoles(DEFAULT_ROLES).escalation?.coder?.to.model).toBe(WONDER);
    expect(mergeRoles(DEFAULT_ROLES, { coder: { model: "custom:local" } }).escalation?.coder).toBeUndefined();
    expect(mergeRoles(DEFAULT_ROLES, { reviewer: { model: SPARK } }).escalation?.coder?.to.model).toBe(WONDER);
    const profile = { coder: { model: SPARK }, escalation: { coder: { afterFailedTrials: 1, to: { model: WONDER } } } };
    expect(mergeRoles(DEFAULT_ROLES, profile).escalation?.coder?.afterFailedTrials).toBe(1);
  });
});

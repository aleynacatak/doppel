import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import { fileKey } from "../electron/core/flows/values";
import type { AiAccessService } from "../electron/core/services/aiAccessService";
import type { AiService } from "../electron/core/services/aiService";
import type { ChatMessage } from "../electron/core/services/aiTransport";
import type { AppStatusService } from "../electron/core/services/appStatusService";
import { FlowService } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { QcService } from "../electron/core/services/qcService";
import { RoutineService } from "../electron/core/services/routineService";
import { StarterService, toStarterFile } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Creation, Flow, Routine, Run } from "../electron/core/types";
import { contractChanges, diffSteps, isBreaking } from "../electron/shared/routineDiff";

// Refine: changing a saved routine with the AI, versions and restore, and what a new version does to flows.
// Every routine, run and starter here is a test fixture in a temporary folder.

const base = {
  createdWithAiCalls: 3,
  appVersion: "",
  requiredFonts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  modifiesDocument: false,
  qcProfile: "web" as const,
  description: "",
  format: 2 as const,
};

const SCRIPT = 'var img = openDocument(ctx.item.path);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));';

const cutout = (extra: Partial<Routine> = {}): Routine => ({
  ...base,
  id: "cutout",
  name: "Cut out",
  appId: "photoshop",
  kind: "script",
  version: 1,
  runs: [],
  versions: [{ version: 1, createdAt: "2026-10-01T00:00:00.000Z", aiCalls: 3, note: "Created" }],
  steps: [
    { id: "s1", plainLanguage: "Removes the background" },
    { id: "s2", plainLanguage: "Saves each photo as a PNG" },
  ],
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  settings: [],
  iterate: { input: "photos" },
  outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
  script: SCRIPT,
  ...extra,
});

// What the model proposes, in its own format.
const revision = (extra: Record<string, unknown> = {}) => ({
  name: "Cut out",
  app: "photoshop",
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  iterate: { input: "photos" },
  outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
  settings: [{ key: "border", label: "Border width", type: "number", required: false, default: 8 }],
  steps: ["Removes the background", "Adds a white border", "Saves each photo as a PNG"],
  script: SCRIPT.replace("var img", "var border = params.border;\nvar img"),
  ...extra,
});

function fakePhotoshop(): DesignAppAdapter {
  return {
    id: "photoshop",
    name: "Adobe Photoshop",
    stageKind: "script",
    qcChecks: [],
    capabilityManifest: () => "photoshop guide",
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
      return { ok: true, outputs: [{ key: `${input.key}-1`, label: path.basename(file), filePath: file }], values: { cutouts: [file] }, findings: [], log: [] };
    },
  } as unknown as DesignAppAdapter;
}

type Answer = (messages: ChatMessage[], schemaName: string) => Record<string, unknown>;

let dir: string;
let storage: JsonStorage;
let starters: StarterService;
let library: LibraryService;
let flows: FlowService;
let service: RoutineService;
let answer: Answer;
let seen: { schema: string; messages: ChatMessage[] }[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-refine-"));
  seen = [];
  answer = () => ({ action: "propose_revision", changeSummary: "Adds a white border around each cutout.", reason: "Border", routine: revision() });
  const registry = new AdapterRegistry([fakePhotoshop()]);
  storage = new JsonStorage(path.join(dir, "data"));
  await fs.mkdir(path.join(dir, "starters"), { recursive: true });
  const { starter } = toStarterFile(cutout({ name: "Starter cutout" }), { converter: false });
  await fs.writeFile(path.join(dir, "starters", "cutout.json"), JSON.stringify(starter));
  starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  library = new LibraryService({ storage, starters });
  flows = new FlowService({ storage, library, starters, registry });
  const ai: AiService = {
    async turn(messages: ChatMessage[], schema, _actions, ctx) {
      ctx.onAiCall();
      seen.push({ schema: schema.name, messages: structuredClone(messages) });
      return answer(messages, schema.name);
    },
    reviewTrial: async () => ({}),
    reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }),
    checkObjectInRegion: async () => ({ level: "object", label: "x", passed: true }),
  } as AiService;
  service = new RoutineService({
    storage,
    registry,
    library,
    flows,
    ai,
    access: { ensureReady: async () => undefined, provider: () => "meta-api", noteQuota: () => undefined } as unknown as AiAccessService,
    qc: new QcService(ai),
    getStyle: async () => null,
    apps: { statusOf: async () => "connected" } as unknown as AppStatusService,
    emit: () => undefined,
    workRoot: path.join(dir, "work"),
    templates: [],
  });
  for (const name of ["apricot.jpg", "fig.jpg", "plum.jpg"]) await fs.writeFile(path.join(dir, name), "jpg");
});

/** A routine run of the cutout routine on three photos; the fig cutout was flagged. */
async function savedRun(): Promise<Run> {
  const photos = ["apricot.jpg", "fig.jpg", "plum.jpg"].map((n) => path.join(dir, n));
  const run = {
    id: "run1",
    target: { kind: "routine", id: "cutout" },
    name: "Cut out",
    version: 1,
    appIds: ["photoshop"],
    inputs: { "input-photos": photos },
    outputFolders: {},
    qcMode: "standard",
    options: {},
    status: "succeeded",
    aiCalls: 0,
    startedAt: "2026-10-02T00:00:00.000Z",
    nodes: [],
    edges: [],
    outputs: photos.map((p, i) => ({
      id: `out${i + 1}`,
      label: path.basename(p).replace(".jpg", ".png"),
      status: "done",
      node: "routine",
      itemKey: fileKey(p),
      itemLabel: path.basename(p),
      ...(p.endsWith("fig.jpg")
        ? {
            preview: { kind: "image", src: "data:image/png;base64,AAAA", label: "fig.png" },
            qc: { status: "flagged", checks: [{ level: "visual", label: "Edges", passed: false, reason: "The stem was cut off." }] },
          }
        : {}),
    })),
  } as unknown as Run;
  await storage.saveRun(run);
  const routine = (await library.require("cutout"))!;
  await storage.saveRoutine({
    ...routine,
    runs: [{ id: run.id, startedAt: run.startedAt, status: "succeeded", inputsSummary: "3 photos", qcStatus: "flagged", outputCount: 3, flaggedCount: 1, aiCalls: 0, routineVersion: 1 }],
  });
  return run;
}

async function until(id: string, done: (c: Creation) => boolean, allowFailed = false): Promise<Creation> {
  for (let i = 0; i < 600; i++) {
    const c = service.getCreation(id)!;
    if (done(c)) return c;
    if (c.status === "failed" && !allowFailed) throw new Error(`Refine failed: ${c.error?.message} ${c.error?.detail ?? ""}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

const textOf = (m: ChatMessage) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n"));

describe("contract changes", () => {
  it("calls a new optional input, a new output and a new setting with a default compatible", () => {
    const after = cutout({
      inputs: [...cutout().inputs, { key: "logo", label: "Logo", type: "file", required: false, extensions: ["png"] }],
      outputs: [...cutout().outputs, { key: "contact", label: "Contact sheet", type: "file", required: false, extensions: ["pdf"] }],
      settings: [{ key: "border", label: "Border width", type: "number", required: false, default: 8 }],
    });
    const changes = contractChanges(cutout(), after);
    expect(changes.map((c) => [c.key, c.breaking])).toEqual([
      ["logo", false],
      ["contact", false],
      ["border", false],
    ]);
    expect(isBreaking(changes)).toBe(false);
  });

  it("calls a removed or renamed port, a changed type, a new required input or setting, and iterating differently breaking", () => {
    const after = cutout({
      inputs: [
        { key: "photos", label: "Photos", type: "rows", required: true },
        { key: "mask", label: "Mask", type: "file", required: true, extensions: ["png"] },
      ],
      outputs: [{ key: "images", label: "Images", type: "fileList", required: true, extensions: ["png"] }],
      settings: [{ key: "tone", label: "Tone", type: "text", required: true }],
      iterate: undefined,
    });
    const changes = contractChanges(cutout(), after);
    expect(changes.filter((c) => c.breaking).map((c) => c.key)).toEqual(["iterate", "photos", "mask", "cutouts", "tone"]);
    // A renamed output is a removed one (breaking) plus a new one (compatible on its own).
    expect(changes.find((c) => c.key === "cutouts")!.message).toBe("Output “Cutouts” was removed.");
    expect(changes.find((c) => c.key === "images")).toMatchObject({ breaking: false });
    expect(isBreaking(changes)).toBe(true);
  });

  it("treats a widened input as compatible and a narrowed one as breaking", () => {
    const widened = cutout({ inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg", "png"] }] });
    const narrowed = cutout({ outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["tif"] }] });
    expect(isBreaking(contractChanges(cutout(), widened))).toBe(false);
    expect(isBreaking(contractChanges(cutout(), narrowed))).toBe(true);
    expect(contractChanges(cutout(), cutout())).toEqual([]);
  });

  it("describes step changes in plain language", () => {
    expect(diffSteps(["Removes the background", "Saves each photo as a PNG"], ["Removes the background", "Adds a white border", "Saves each photo as a WebP"])).toEqual([
      { kind: "same", before: "Removes the background", after: "Removes the background" },
      { kind: "changed", before: "Saves each photo as a PNG", after: "Adds a white border" },
      { kind: "added", after: "Saves each photo as a WebP" },
    ]);
  });
});

describe("versions", () => {
  it("restores an earlier version as a new version, keeping the history", async () => {
    await library.save(cutout());
    await library.save(cutout({ script: "changed", version: 2, versions: [...cutout().versions, { version: 2, createdAt: "", aiCalls: 4, note: "Changed" }] }));
    const restored = await library.restore("cutout", 1);
    expect(restored).toMatchObject({ version: 3, script: SCRIPT });
    expect(restored.versions.map((v) => [v.version, v.note])).toEqual([
      [1, "Created"],
      [2, "Changed"],
      [3, "Restored version 1"],
    ]);
    expect((await library.getVersion("cutout", 2))!.script).toBe("changed");
    expect((await library.getVersion("cutout", 1))!.script).toBe(SCRIPT);
    expect((await library.require("cutout")).version).toBe(3);
  });

  it("can't restore a starter", async () => {
    await expect(library.restore("starter-starter-cutout", 1)).rejects.toThrow(/Duplicate/);
  });
});

describe("flows and new versions", () => {
  const flow = (): Flow => ({
    id: "f1",
    name: "Shop photos",
    description: "",
    version: 1,
    createdAt: "",
    updatedAt: "",
    runs: [],
    createdWithAiCalls: 0,
    nodes: [
      { id: "in", kind: "input", port: { key: "photos", label: "Photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
      { id: "n-cut", kind: "routine", routineId: "cutout", routineVersion: 1, position: { x: 0, y: 0 } },
      { id: "out", kind: "output", port: { key: "out", label: "Cutouts folder", type: "fileList", required: false }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", from: { nodeId: "in", port: "photos" }, to: { nodeId: "n-cut", port: "photos" } },
      { id: "e2", from: { nodeId: "n-cut", port: "cutouts" }, to: { nodeId: "out", port: "out" } },
    ],
  });
  const v = (n: number, extra: Partial<Routine>) => cutout({ version: n, versions: Array.from({ length: n }, (_, i) => ({ version: i + 1, createdAt: "", aiCalls: 1, note: `v${i + 1}` })), ...extra });

  it("updates every flow to a compatible version; the flow shows the update until then", async () => {
    await library.save(cutout());
    await flows.save(flow());
    await library.save(v(2, { settings: [{ key: "border", label: "Border width", type: "number", required: false, default: 8 }] }));
    expect(await flows.usage("cutout")).toEqual([expect.objectContaining({ flowId: "f1", nodes: [{ nodeId: "n-cut", version: 1 }], latest: 2, compatible: true })]);
    expect((await flows.context((await flows.get("f1"))!)).latest).toEqual({ cutout: 2 });

    expect(await flows.updateAll("cutout")).toEqual({ updated: ["Shop photos"], skipped: [] });
    const updated = (await flows.get("f1"))!;
    expect(updated.nodes.find((n) => n.id === "n-cut")).toMatchObject({ routineVersion: 2 });
    expect((await flows.context(updated)).validation.ok).toBe(true);
  });

  it("doesn't update a flow to a breaking version; updating the node flags its connections until they're reconnected", async () => {
    await library.save(cutout());
    await flows.save(flow());
    const renamed = v(2, { outputs: [{ key: "images", label: "Images", type: "fileList", required: true, extensions: ["png"] }] });
    await library.save(renamed);

    const [usage] = await flows.usage("cutout");
    expect(usage).toMatchObject({ latest: 2, compatible: false });
    expect(usage.changes.filter((c) => c.breaking).map((c) => c.key)).toEqual(["cutouts"]);
    const result = await flows.updateAll("cutout");
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ name: "Shop photos" })]);
    expect((await flows.get("f1"))!.nodes.find((n) => n.id === "n-cut")).toMatchObject({ routineVersion: 1 });

    // "Update" on the node in the canvas: the edge from the removed output is flagged.
    const pinned = flow();
    pinned.nodes = pinned.nodes.map((n) => (n.kind === "routine" ? { ...n, routineVersion: 2 } : n));
    const ctx = await flows.context(pinned);
    expect(ctx.validation.ok).toBe(false);
    expect(ctx.validation.issues.some((i) => i.edgeId === "e2")).toBe(true);
    // Reconnected to the new output, the flow is fine again.
    pinned.edges[1] = { ...pinned.edges[1], from: { nodeId: "n-cut", port: "images" } };
    expect((await flows.context(pinned)).validation.ok).toBe(true);
  });
});

describe("refining with the AI", () => {
  it("opens from a Results item with that item as the problem and the default test item", async () => {
    await library.save(cutout());
    await savedRun();
    const setup = await service.refineSetup("cutout", { runId: "run1", outputId: "out2" });
    expect(setup.items.map((i) => i.label)).toEqual(["apricot.jpg", "fig.jpg", "plum.jpg"]);
    expect(setup.defaultItems).toEqual([fileKey(path.join(dir, "fig.jpg"))]);
    expect(setup.problem).toMatchObject({ runId: "run1", outputId: "out2", label: "fig.png", itemLabel: "fig.jpg", input: "fig.jpg", preview: { src: "data:image/png;base64,AAAA" } });
    expect(setup.problem!.qc!.checks[0].reason).toBe("The stem was cut off.");

    // Without a problem: the last run's first item.
    const plain = await service.refineSetup("cutout");
    expect(plain.problem).toBeUndefined();
    expect(plain.defaultItems).toEqual([fileKey(path.join(dir, "apricot.jpg"))]);
  });

  it("opens from an item of a flow run with the inputs that reached that node", async () => {
    await library.save(cutout());
    const photos = ["apricot.jpg", "fig.jpg"].map((n) => path.join(dir, n));
    await flows.save({
      id: "f1",
      name: "Shop photos",
      description: "",
      version: 1,
      createdAt: "",
      updatedAt: "",
      runs: [],
      createdWithAiCalls: 0,
      nodes: [
        { id: "in", kind: "input", port: { key: "photos", label: "Photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
        { id: "n-cut", kind: "routine", routineId: "cutout", routineVersion: 1, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e1", from: { nodeId: "in", port: "photos" }, to: { nodeId: "n-cut", port: "photos" } }],
    });
    await storage.saveRun({
      ...(await savedRun()),
      id: "flowrun",
      target: { kind: "flow", id: "f1" },
      inputs: { in: photos },
      outputs: [{ id: "o", label: "fig.png", status: "done", node: "n-cut", itemKey: fileKey(photos[1]), itemLabel: "fig.jpg" }],
    });
    const setup = await service.refineSetup("cutout", { runId: "flowrun", outputId: "o" }, { flowId: "f1", nodeId: "n-cut" });
    expect(setup.items.map((i) => i.label)).toEqual(["apricot.jpg", "fig.jpg"]);
    expect(setup.defaultItems).toEqual([fileKey(photos[1])]);
    expect(setup.problem).toMatchObject({ label: "fig.png", input: "fig.jpg" });
  });

  it("tries the change on the test items, shows before and after, and saves it as the next version", async () => {
    await library.save(cutout());
    await savedRun();
    const figKey = fileKey(path.join(dir, "fig.jpg"));
    const c = await service.refine({ routineId: "cutout", request: "Add a white border", images: [], problem: { runId: "run1", outputId: "out2" }, testItems: [figKey] });
    const ready = await until(c.id, (x) => x.status === "ready");

    // The model got the routine, the request, the problem item with its preview and QC, and the revision tools.
    expect(seen[0].schema).toBe("doppl_revision_turn");
    const first = seen[0].messages.map(textOf).join("\n");
    expect(first).toContain("Add a white border");
    expect(first).toContain("The stem was cut off.");
    expect(first).toContain("[image]");
    expect(first).toContain("Removes the background");

    expect(ready.mode).toBe("refine");
    expect(ready.refine).toMatchObject({
      routineId: "cutout",
      fromVersion: 1,
      request: "Add a white border",
      changeSummary: "Adds a white border around each cutout.",
      items: [{ key: figKey, label: "fig.jpg" }],
      problemLabel: "fig.jpg",
    });
    expect(ready.refine!.before.map((o) => o.label)).toEqual(["fig.png"]);
    expect(ready.outputs.map((o) => o.label)).toEqual(["fig.png"]);
    expect(ready.refine!.steps.map((s) => s.kind)).toEqual(["same", "added", "same"]);
    expect(ready.refine!.contract).toEqual([expect.objectContaining({ key: "border", breaking: false })]);
    expect(ready.draft!.name).toBe("Cut out");
    // Nothing changes until it's saved.
    expect((await library.require("cutout")).version).toBe(1);

    const saved = await service.save(c.id, { name: "" });
    expect(saved.routine).toMatchObject({ id: "cutout", version: 2, name: "Cut out" });
    const latest = await library.require("cutout");
    expect(latest.versions.at(-1)).toMatchObject({ version: 2, note: "Adds a white border around each cutout.", request: "Add a white border", aiCalls: 1 });
    expect(latest.settings.map((s) => s.key)).toEqual(["border"]);
    expect(latest.runs).toHaveLength(1);
    expect((await library.getVersion("cutout", 1))!.script).toBe(SCRIPT);
  });

  it("takes a follow-up in the same session", async () => {
    await library.save(cutout());
    await savedRun();
    const c = await service.refine({ routineId: "cutout", request: "Add a white border", images: [], testItems: [] });
    await until(c.id, (x) => x.status === "ready");
    answer = () => ({ action: "propose_revision", changeSummary: "Adds a thicker white border.", reason: "Thicker", routine: revision({ settings: [{ key: "border", label: "Border width", type: "number", required: false, default: 16 }] }) });
    await service.refineFollowUp(c.id, "Make the border thicker");
    const again = await until(c.id, (x) => x.status === "ready" && x.refine?.changeSummary === "Adds a thicker white border.");
    expect(seen.map((s) => textOf(s.messages.at(-1)!)).at(-1)).toContain("Make the border thicker");
    expect(again.draft!.settings[0].default).toBe(16);
    expect(again.refine!.before).toHaveLength(1);
  });

  it("keeps the original untouched when no revision passes within the limit", async () => {
    await library.save(cutout());
    await savedRun();
    const before = await library.require("cutout");
    answer = () => ({ action: "propose_revision", changeSummary: "Broken", reason: "x", routine: revision({ outputs: [], script: "" }) });
    const c = await service.refine({ routineId: "cutout", request: "Add a white border", images: [], testItems: [] });
    const failed = await until(c.id, (x) => x.status === "failed", true);
    expect(failed.error?.message).toBeTruthy();
    expect(seen.length).toBeGreaterThan(1);
    expect(await library.require("cutout")).toEqual(before);
    expect(await library.getVersion("cutout", 2)).toBeNull();
  });

  it("suggests a flow when the change needs another app", async () => {
    await library.save(cutout());
    await savedRun();
    answer = () => ({ action: "decline", reason: "Laying the cutouts out on cards needs Figma." });
    const c = await service.refine({ routineId: "cutout", request: "Also put each cutout on a Figma card", images: [], testItems: [] });
    const failed = await until(c.id, (x) => x.status === "failed", true);
    expect(failed.error).toMatchObject({ kind: "needs-flow" });
    expect(failed.error!.detail ?? failed.error!.message).toContain("Figma");
    expect((await library.require("cutout")).version).toBe(1);
  });

  it("won't refine a starter directly; a duplicate can be refined", async () => {
    const starterId = "starter-starter-cutout";
    expect((await library.require(starterId)).starter).toBeTruthy();
    await expect(service.refine({ routineId: starterId, request: "Add a border", images: [], testItems: [] })).rejects.toThrow(/Duplicate/);
    const copy = await library.duplicate(starterId);
    expect(copy.starter).toBeFalsy();
    await fs.mkdir(path.join(dir, "samples"));
    await fs.writeFile(path.join(dir, "samples", "pear.jpg"), "jpg");
    const c = await service.refine({ routineId: copy.id, request: "Add a border", images: [], testItems: [] });
    // A copy that never ran asks for sample photos to try the change on.
    await until(c.id, (x) => x.status === "waiting" && !!x.needs);
    await service.addSamples(c.id, { files: [], folders: [path.join(dir, "samples")] });
    await service.confirmSamples(c.id);
    const ready = await until(c.id, (x) => x.status === "ready");
    expect(ready.refine!.routineId).toBe(copy.id);
    const saved = await service.save(c.id, { name: "" });
    expect(saved.routine).toMatchObject({ id: copy.id, version: 2 });
    expect(starters.get(starterId)!.version).toBe(1);
  });
});

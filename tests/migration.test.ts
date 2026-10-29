import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type ValidatorApps, validateRoutine } from "../electron/core/routines/contract";
import { migrateRoutines } from "../electron/core/services/routineMigration";
import { JsonStorage } from "../electron/core/services/storage";
import { type FlowRoutines, validateFlow } from "../electron/core/flows/validateFlow";
import type { Flow, Routine, Run } from "../electron/core/types";

// Routine and run files the way earlier Doppl builds wrote them (test fixtures in a temporary folder).

const multiStage = {
  id: "multi",
  name: "Labels and mockups",
  appId: "figma",
  description: "Labels per product, then mockups.",
  steps: [],
  params: [
    { key: "products", label: "Products", type: "dataFile", required: true, columns: ["name", "photo"] },
    { key: "mockup", label: "Mockup", type: "file", required: true, extensions: ["psd"] },
    { key: "out", label: "Output folder", type: "folder", required: true, role: "output" },
    { key: "quality", label: "JPG quality", type: "number", required: false, default: 85 },
  ],
  script: "",
  version: 2,
  createdWithAiCalls: 11,
  appVersion: "",
  requiredFonts: [],
  runs: [{ id: "old-run", startedAt: "2026-10-03T00:00:00.000Z", status: "partial", inputsSummary: "products.csv", qcStatus: "pass", outputCount: 3, flaggedCount: 0, aiCalls: 0, routineVersion: 2 }],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  versions: [
    { version: 1, createdAt: "", aiCalls: 9, note: "Created from “labels”" },
    { version: 2, createdAt: "", aiCalls: 2, note: "Repaired with AI" },
  ],
  modifiesDocument: true,
  qcProfile: "web",
  keyObjects: ["label"],
  lastParams: { products: "/Users/ana/products.csv", out: "/Users/ana/out", quality: 90 },
  stages: [
    {
      id: "s1",
      name: "Labels",
      appId: "figma",
      kind: "actions",
      repeat: { over: "{{params.products.rows}}" },
      inputs: ["{{params.products}}"],
      outputs: [{ key: "files", type: "fileList" }],
      document: "open",
      body: {
        actions: [
          { action: "duplicateNode", id: "l", node: "Label" },
          { action: "setText", node: "$l.#Name", text: "{{item.name}}" },
          { action: "exportNode", node: "$l", format: "PNG", fileName: "{{item.name}}", output: "files" },
        ],
      },
    },
    {
      id: "s2",
      name: "Mockups",
      appId: "photoshop",
      kind: "script",
      document: "none",
      repeat: { over: "{{params.products.rows}}" },
      inputs: ["{{stage.s1.outputs.files}}", "{{params.mockup}}"],
      outputs: [{ key: "images", type: "fileList" }],
      body: 'var doc = openDocument(params.mockup);\nreplaceSmartObject(findLayer("Label"), ctx.findFile(ctx.stages.s1.outputs.files, ctx.item.name));\nexportImage(ctx.join(params.out, ctx.item.name + ".jpg"), "jpg", params.quality);',
    },
  ],
};

const singleScript = {
  id: "single",
  name: "Export pages",
  appId: "indesign",
  description: "Exports pages as PNG.",
  steps: [{ id: "a", plainLanguage: "Exports every page" }],
  params: [
    { key: "out", label: "Output folder", type: "folder", required: true },
    { key: "resolution", label: "Resolution", type: "number", required: true, default: 150 },
  ],
  script: 'var f = ctx.ensureFolder(params.out); ctx.log(params.resolution);',
  version: 1,
  createdWithAiCalls: 3,
  appVersion: "21.0",
  requiredFonts: [],
  runs: [],
  createdAt: "",
  updatedAt: "",
  versions: [{ version: 1, createdAt: "", aiCalls: 3, note: "Created" }],
  modifiesDocument: false,
  qcProfile: "print",
};

const oldRun = {
  id: "old-run",
  routineId: "multi",
  routineName: "Labels and mockups",
  routineVersion: 2,
  appId: "figma",
  params: { products: "/Users/ana/products.csv" },
  qcMode: "auto",
  options: { target: "copy", documents: { figma: "figma:abc" } },
  status: "partial",
  aiCalls: 0,
  outputs: [{ id: "s1:row-1-export-1", label: "Honey.png", status: "done", stageId: "s1", itemKey: "row-1" }],
  startedAt: "2026-10-03T00:00:00.000Z",
  stages: [{ stageId: "s1", name: "Labels", appId: "figma", status: "done", total: 1, done: 1, failed: 0, items: [] }],
};

let root: string;
let storage: JsonStorage;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-migrate-"));
  for (const [dir, data] of [["routines", multiStage], ["routines", singleScript], ["runs", oldRun]] as const) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, dir, `${data.id}.json`), JSON.stringify(data));
  }
  storage = new JsonStorage(root);
});

const apps: ValidatorApps = { has: () => true, stageKind: (id) => (id === "figma" ? "actions" : "script"), lintScript: () => [] };

describe("migration to routines and flows", () => {
  it("backs up every file it changes, once", async () => {
    const res = await migrateRoutines(storage);
    expect(res).toMatchObject({ routines: 3, flows: 1, runs: 1 });
    const backup = res.backup!;
    expect(JSON.parse(await fs.readFile(path.join(backup, "routines", "multi.json"), "utf8"))).toEqual(multiStage);
    expect(JSON.parse(await fs.readFile(path.join(backup, "runs", "old-run.json"), "utf8"))).toEqual(oldRun);
    expect(await migrateRoutines(storage)).toEqual({ routines: 0, flows: 0, runs: 0, backup: null });
  });

  it("turns a multi-stage routine into a flow plus one routine per stage", async () => {
    await migrateRoutines(storage);
    expect(await storage.getRoutine("multi")).toBeNull();
    const [flow] = await storage.listFlows();
    const routines = await storage.listRoutines();
    const labels = routines.find((r) => r.name === "Labels and mockups · Labels")!;
    const mockups = routines.find((r) => r.name === "Labels and mockups · Mockups")!;

    // Contracts: params as inputs and settings, earlier stage outputs as inputs, documents as document inputs.
    expect(labels.inputs.map((p) => [p.key, p.type])).toEqual([
      ["document", "document"],
      ["products", "rows"],
    ]);
    expect(labels.iterate).toEqual({ input: "products" });
    expect(labels.outputs).toEqual([{ key: "files", label: "files", type: "fileList", required: true }]);
    expect(mockups.inputs.map((p) => [p.key, p.type])).toEqual(
      expect.arrayContaining([
        ["products", "rows"],
        ["mockup", "file"],
        ["out", "folder"],
        ["s1Files", "fileList"],
      ]),
    );
    expect(mockups.settings.map((s) => [s.key, s.default])).toEqual([["quality", 85]]);
    // Placeholders and scripts point at the routine's own inputs.
    expect(labels.actions![1].text).toBe("{{item.name}}");
    expect(mockups.script).toContain("ctx.findFile(params.s1Files, ctx.item.name)");
    for (const r of [labels, mockups]) expect(validateRoutine(r, apps).errors).toEqual([]);

    // History: versions kept, AI calls on the flow (not counted twice), runs moved to the flow.
    expect(labels.versions.map((v) => [v.version, v.aiCalls])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(labels.version).toBe(2);
    expect(flow).toMatchObject({ name: "Labels and mockups", version: 2, createdWithAiCalls: 11, runs: multiStage.runs });

    // The flow: params as input nodes, stage outputs as edges, a second list pairs by row.
    expect(flow.nodes.filter((n) => n.kind === "input").map((n) => n.id).sort()).toEqual(["input-mockup", "input-out", "input-products"]);
    const handoff = flow.edges.find((e) => e.from.port === "files")!;
    expect(handoff).toMatchObject({ to: { port: "s1Files" }, match: { by: "index" } });
    const info: FlowRoutines = {
      routines: Object.fromEntries(flow.nodes.filter((n) => n.kind === "routine").map((n) => [n.id, routines.find((r) => n.kind === "routine" && r.id === n.routineId)!])),
      stageKind: (id) => (id === "figma" ? "actions" : "script"),
    };
    expect(validateFlow(flow, info)).toEqual({ ok: true, issues: [] });
    // Values picked last time move to this Mac's last-values file.
    expect(await storage.getLastValues(`flow:${flow.id}`)).toMatchObject({ inputs: { "input-products": "/Users/ana/products.csv", "input-out": "/Users/ana/out" }, settings: { quality: 90 } });
    expect(JSON.stringify(flow)).not.toContain("/Users/ana");
  });

  it("gives a single-app routine inputs and settings, keeping its script", async () => {
    await migrateRoutines(storage);
    const r = (await storage.getRoutine("single")) as Routine;
    expect(r).toMatchObject({ format: 2, kind: "script", outputs: [], createdWithAiCalls: 3, version: 1 });
    expect(r.inputs.map((p) => [p.key, p.type])).toEqual([
      ["document", "document"],
      ["out", "folder"],
    ]);
    expect(r.settings).toEqual([{ key: "resolution", label: "Resolution", type: "number", required: true, default: 150 }]);
    expect(r.script).toBe(singleScript.script);
    expect(validateRoutine(r, apps).errors).toEqual([]);
    expect((r as unknown as { params?: unknown }).params).toBeUndefined();
  });

  it("brings runs along, as runs of the flow", async () => {
    await migrateRoutines(storage);
    const [flow] = (await storage.listFlows()) as Flow[];
    const run = (await storage.getRun("old-run")) as Run;
    expect(run.target).toEqual({ kind: "flow", id: flow.id });
    expect(run).toMatchObject({ name: "Labels and mockups", version: 2, options: { target: "copy", documents: { figma: "figma:abc" } } });
    expect(run.nodes[0]).toMatchObject({ nodeId: "node-s1", kind: "routine", name: "Labels" });
    expect(run.outputs[0]).toMatchObject({ node: "node-s1", itemKey: "row-1" });
    expect(run.outputs[0]).not.toHaveProperty("stageId");
  });
});

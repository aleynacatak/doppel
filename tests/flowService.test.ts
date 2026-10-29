import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter } from "../electron/adapters/types";
import { type FlowRoutines, validateFlow } from "../electron/core/flows/validateFlow";
import { FlowService, routineFlow } from "../electron/core/services/flowService";
import { LibraryService } from "../electron/core/services/libraryService";
import { StarterService } from "../electron/core/services/starterService";
import { JsonStorage } from "../electron/core/services/storage";
import type { Flow, Routine } from "../electron/core/types";

const registry = new AdapterRegistry([
  { id: "figma", name: "Figma", stageKind: "actions" } as unknown as DesignAppAdapter,
  { id: "photoshop", name: "Adobe Photoshop", stageKind: "script" } as unknown as DesignAppAdapter,
]);

const base = { version: 1, createdWithAiCalls: 0, appVersion: "", requiredFonts: [], runs: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", versions: [{ version: 1, createdAt: "", aiCalls: 0, note: "v1" }], modifiesDocument: false, qcProfile: "web" as const, steps: [], description: "", format: 2 as const };

const cutout = (): Routine => ({
  ...base,
  id: "cutout",
  name: "Cut out",
  appId: "photoshop",
  kind: "script",
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  settings: [],
  iterate: { input: "photos" },
  outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
  script: 'ctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
});

const cards = (): Routine => ({
  ...base,
  id: "cards",
  name: "Cards",
  appId: "figma",
  kind: "actions",
  inputs: [
    { key: "file", label: "Figma file", type: "document", required: true },
    { key: "products", label: "Products", type: "rows", required: true, columns: ["title", "photo"] },
    { key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] },
  ],
  settings: [],
  iterate: { input: "products" },
  outputs: [{ key: "cards", label: "Cards", type: "fileList", required: true, extensions: ["png"] }],
  actions: [{ action: "setImageFill", node: "Photo", image: { file: "{{matched.cutouts}}" } }],
  script: "",
});

const flow = (): Flow => ({
  id: "f1",
  name: "Labels",
  description: "",
  version: 1,
  createdAt: "",
  updatedAt: "",
  runs: [],
  createdWithAiCalls: 4,
  nodes: [
    { id: "in-data", kind: "input", port: { key: "data", label: "Product data", type: "rows", required: true }, position: { x: 0, y: 0 } },
    { id: "in-photos", kind: "input", port: { key: "photos", label: "Photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
    { id: "n-cut", kind: "routine", routineId: "cutout", routineVersion: 1, position: { x: 0, y: 0 } },
    { id: "n-cards", kind: "routine", routineId: "cards", routineVersion: 1, position: { x: 0, y: 0 } },
    { id: "out", kind: "output", port: { key: "out", label: "Cards folder", type: "fileList", required: false }, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: "e1", from: { nodeId: "in-photos", port: "photos" }, to: { nodeId: "n-cut", port: "photos" } },
    { id: "e2", from: { nodeId: "in-data", port: "data" }, to: { nodeId: "n-cards", port: "products" } },
    { id: "e3", from: { nodeId: "n-cut", port: "cutouts" }, to: { nodeId: "n-cards", port: "cutouts" }, match: { by: "fileNameEqualsColumn", column: "photo", ignoreExtension: true } },
    { id: "e4", from: { nodeId: "n-cards", port: "cards" }, to: { nodeId: "out", port: "out" } },
  ],
});

let dir: string;
let storage: JsonStorage;
let starters: StarterService;
let library: LibraryService;
let flows: FlowService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-flowservice-"));
  storage = new JsonStorage(path.join(dir, "data"));
  starters = new StarterService(path.join(dir, "starters"));
  await starters.load();
  library = new LibraryService({ storage, starters });
  flows = new FlowService({ storage, library, starters, registry });
  await library.save(cutout());
  await library.save(cards());
});

const info = (routines: FlowRoutines["routines"]): FlowRoutines => ({ routines, stageKind: (id) => (id === "figma" ? "actions" : id === "photoshop" ? "script" : null) });
const codes = (f: Flow, routines: FlowRoutines["routines"]) => validateFlow(f, info(routines)).issues.map((i) => [i.code, i.nodeId ?? i.edgeId]);

describe("flow validation", () => {
  it("accepts a connected flow", () => {
    expect(validateFlow(flow(), info({ "n-cut": cutout(), "n-cards": cards() }))).toEqual({ ok: true, issues: [] });
  });

  it("reports problems per node and edge", () => {
    const f = flow();
    f.edges[2] = { ...f.edges[2], match: undefined };
    f.edges.splice(1, 1);
    f.edges.push({ id: "e5", from: { nodeId: "in-data", port: "data" }, to: { nodeId: "n-cut", port: "photos" } });
    f.edges.push({ id: "e6", from: { nodeId: "in-photos", port: "photos" }, to: { nodeId: "n-cut", port: "photos" } });
    f.nodes.push({ id: "out2", kind: "output", port: { key: "o", label: "Extra", type: "fileList", required: false }, position: { x: 0, y: 0 } });
    expect(codes(f, { "n-cut": cutout(), "n-cards": cards() })).toEqual(
      expect.arrayContaining([
        ["needs-match", "e3"],
        ["incompatible", "e5"],
        ["duplicate-input", "e5"],
        ["duplicate-input", "e6"],
        ["missing-input", "n-cards"],
        ["no-source", "out2"],
      ]),
    );
    const issues = validateFlow(f, info({ "n-cut": cutout(), "n-cards": cards() })).issues;
    expect(issues.find((i) => i.edgeId === "e5" && i.code === "incompatible")!.message).toBe("data rows can't go into an input that takes JPG files.");
    expect(issues.find((i) => i.code === "missing-input")).toMatchObject({ port: "products", message: "Cards needs “Products”: connect it." });
  });

  it("rejects cycles, missing routines and versions, older routines, and edges between wrong ports", () => {
    const f = flow();
    f.edges.push({ id: "loop", from: { nodeId: "n-cards", port: "cards" }, to: { nodeId: "n-cut", port: "photos" } });
    f.edges.push({ id: "wrong", from: { nodeId: "n-cut", port: "nope" }, to: { nodeId: "n-cards", port: "cutouts" } });
    expect(codes(f, { "n-cut": cutout(), "n-cards": cards() })).toEqual(expect.arrayContaining([["cycle", "n-cut"], ["cycle", "n-cards"], ["unknown-port", "wrong"]]));
    expect(codes(flow(), { "n-cut": "missing-routine", "n-cards": "missing-version" })).toEqual([
      ["missing-routine", "n-cut"],
      ["missing-version", "n-cards"],
    ]);
    expect(codes(flow(), { "n-cut": { ...cutout(), appId: "figma" }, "n-cards": cards() })).toContainEqual(["legacy-routine", "n-cut"]);
    expect(codes({ ...flow(), nodes: [], edges: [] }, {})).toEqual([["empty", undefined]]);
  });

  it("checks that a join's rule fits the two lists", () => {
    const f = flow();
    f.edges[2].match = { by: "columnEquals", leftColumn: "photo", rightColumn: "photo" };
    expect(codes(f, { "n-cut": cutout(), "n-cards": cards() })).toEqual([["bad-match", "e3"]]);
  });
});

describe("version pinning", () => {
  it("keeps earlier versions so a node runs the version it pins, and shows when a newer one exists", async () => {
    const saved = await flows.save(flow());
    expect(saved.version).toBe(1);
    // A new version of "Cut out" makes JPG cutouts, which "Cards" doesn't take.
    const v2 = { ...cutout(), version: 2, outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList" as const, required: true, extensions: ["jpg"] }], script: 'ctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".jpg"), "jpg"));' };
    await library.save(v2);
    const ctx = await flows.context(saved);
    expect(ctx.latest).toEqual({ cutout: 2, cards: 1 });
    expect(ctx.routines["n-cut"].version).toBe(1);
    expect(ctx.routines["n-cut"].outputs[0].extensions).toEqual(["png"]);
    expect(ctx.validation.ok).toBe(true);
    // Updating the node re-checks its edges against the new version.
    const updated = await flows.pinVersion(saved.id, "n-cut", 2);
    expect(updated.version).toBe(2);
    const after = await flows.context(updated);
    expect(after.validation.issues).toEqual([expect.objectContaining({ code: "incompatible", edgeId: "e3" })]);
    // A version that isn't there anymore can't run.
    const gone = await flows.context({ ...updated, nodes: updated.nodes.map((n) => (n.id === "n-cut" && n.kind === "routine" ? { ...n, routineVersion: 7 } : n)) });
    expect(gone.validation.issues[0]).toMatchObject({ code: "missing-version", nodeId: "n-cut" });
  });

  it("lists flows with the apps of their routines, and never stores picked values", async () => {
    await flows.save(flow());
    const [listed] = await flows.list();
    expect(listed.appIds).toEqual(["photoshop", "figma"]);
    const file = JSON.parse(await fs.readFile(path.join(dir, "data", "flows", "f1.json"), "utf8"));
    expect(file.appIds).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain(dir);
  });
});

describe("joins in the editor", () => {
  it("suggests a rule from the picked files and shows the first pairs", async () => {
    const f = flow();
    f.edges[2] = { id: "e3", from: { nodeId: "in-photos", port: "photos" }, to: { nodeId: "n-cards", port: "cutouts" } };
    const csv = path.join(dir, "products.csv");
    await fs.writeFile(csv, "title,photo\nApricot,apricot.jpg\nFig,fig.jpg\nPlum,plum.jpg\n");
    const photos = [path.join(dir, "Apricot.png"), path.join(dir, "fig.png")];
    for (const p of photos) await fs.writeFile(p, "png");
    const preview = await flows.previewMatch(f, "e3", null, { "in-data": csv, "in-photos": photos });
    expect(preview.rule).toEqual({ by: "fileNameEqualsColumn", column: "photo", ignoreExtension: true });
    expect(preview.pairs).toEqual([
      { item: "Row 1 · Apricot", match: "Apricot.png", problem: undefined },
      { item: "Row 2 · Fig", match: "fig.png", problem: undefined },
      { item: "Row 3 · Plum", match: null, problem: "No cutout for Row 3 · Plum: plum.jpg not found." },
    ]);
    const nothing = await flows.previewMatch(f, "e3", null, {});
    expect(nothing.note).toContain("Pick the files and data first");
    expect((await flows.previewMatch(f, "e1", null, {})).note).toBe("This connection doesn't pair items.");
  });

  it("offers starter converters that bridge an incompatible edge, and places one", async () => {
    await fs.mkdir(path.join(dir, "starters"), { recursive: true });
    const converter = { ...cutout(), id: "starter-jpg-to-png", name: "JPG to PNG", starter: { tags: ["converter"] }, iterate: { input: "photos" } };
    const other = { ...cutout(), id: "starter-not-converter", name: "Not a converter", starter: { tags: [] } };
    await fs.writeFile(path.join(dir, "starters", "jpg-to-png.json"), JSON.stringify(converter));
    await fs.writeFile(path.join(dir, "starters", "other.json"), JSON.stringify(other));
    await starters.load();
    const f = flow();
    f.nodes.push({ id: "in-jpgs", kind: "input", port: { key: "jpgs", label: "JPGs", type: "fileList", required: true, extensions: ["jpg"] }, position: { x: 0, y: 0 } });
    f.edges[2] = { id: "e3", from: { nodeId: "in-jpgs", port: "jpgs" }, to: { nodeId: "n-cards", port: "cutouts" }, match: { by: "index" } };
    expect(validateFlow(f, info({ "n-cut": cutout(), "n-cards": cards() })).issues.map((i) => i.code)).toEqual(["incompatible"]);
    const options = await flows.converterOptions(f, "e3");
    expect(options).toEqual([{ routineId: "starter-jpg-to-png", version: 1, name: "JPG to PNG", description: "" }]);
    const next = await flows.insertConverter(f, "e3", "starter-jpg-to-png");
    expect(next.edges.find((e) => e.id === "e3")).toBeUndefined();
    const ctx = await flows.context(next);
    expect(ctx.validation.ok).toBe(true);
    expect(f.edges.find((e) => e.id === "e3")).toBeDefined();
  });
});

describe("a routine on its own", () => {
  it("runs as a flow of one node: its inputs as input nodes, its file outputs as Save to folder", () => {
    const f = routineFlow(cards(), { cutouts: { by: "fileNameEqualsColumn", column: "photo", ignoreExtension: true } });
    expect(f.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["input-products", "input"],
      ["input-cutouts", "input"],
      ["routine", "routine"],
      ["output-cards", "output"],
    ]);
    expect(f.edges.find((e) => e.to.port === "cutouts")!.match).toMatchObject({ by: "fileNameEqualsColumn" });
    expect(validateFlow(f, info({ routine: cards() })).ok).toBe(true);
  });
});

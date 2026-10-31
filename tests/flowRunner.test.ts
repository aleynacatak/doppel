import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../electron/adapters/adobe/bridge";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import { FlowInvalidError, FlowRunner, type FlowRunSpec } from "../electron/core/flows/flowRunner";
import { simulatedApps } from "../electron/core/flows/mockAdapters";
import type { FlowRoutines } from "../electron/core/flows/validateFlow";
import type { Flow, Routine } from "../electron/core/types";
import { fakeImage } from "./helpers/images";

// Two fake apps: "figma" makes one PNG per data row (a row named BAD fails), "photoshop" turns each PNG into a JPG.
// A third routine (Figma) iterates over the rows again and pairs each with its label by file name.

let dir: string;
const calls: string[] = [];

function fakeFigma(): DesignAppAdapter {
  return {
    id: "figma",
    name: "Figma",
    stageKind: "actions",
    qcChecks: [],
    async beginStage(ctx: StageRunContext) {
      calls.push(`figma:begin:${ctx.stage.id}:${ctx.target}`);
      return { state: {}, documentName: "File · Page" };
    },
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      const actions = (input.body as { actions: { text?: string; image?: { file: string } }[] }).actions;
      const text = actions.find((a) => a.text)?.text ?? "";
      const image = actions.find((a) => a.image)?.image?.file;
      calls.push(`figma:item:${ctx.stage.id}:${text}${image ? `+${path.basename(image)}` : ""}`);
      if (text === "BAD") return { ok: false, error: "Action 2 (setText): no layer", scriptFailure: true, outputs: [], values: {}, findings: [], log: [] };
      const file = path.join(ctx.workDir, `${text}.png`);
      await fs.writeFile(file, "png");
      return {
        ok: true,
        outputs: [{ key: `${input.key}-export-1`, label: `${text}.png`, filePath: file }],
        values: { files: [file] },
        findings: text === "Jam" ? [{ type: "text-overflow" as const, message: '"Name" doesn\'t fit its text box' }] : [],
        log: [],
      };
    },
    async endStage(_s: unknown, ctx: StageRunContext) {
      calls.push(`figma:end:${ctx.stage.id}`);
    },
    async endRun(runId: string) {
      calls.push(`figma:endRun:${runId}`);
    },
  } as unknown as DesignAppAdapter;
}

function fakePhotoshop(fail?: "not-running"): DesignAppAdapter {
  return {
    id: "photoshop",
    name: "Adobe Photoshop",
    stageKind: "script",
    qcChecks: [],
    async beginStage() {
      calls.push("ps:begin");
      return { state: {} };
    },
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      if (fail) throw new BridgeError("not-running", "Photoshop isn't running.");
      const item = input.item as { path: string; stem: string };
      calls.push(`ps:item:${item.stem}:${String(input.params.quality)}`);
      const out = path.join(ctx.workDir, `${item.stem}.jpg`);
      await fs.writeFile(out, await fs.readFile(item.path));
      return { ok: true, outputs: [{ key: `${input.key}-file-1`, label: path.basename(out), filePath: out }], values: { images: [out] }, findings: [], log: [] };
    },
    async endStage() {
      calls.push("ps:end");
    },
  } as unknown as DesignAppAdapter;
}

const base = { version: 1, createdWithAiCalls: 0, appVersion: "", requiredFonts: [], runs: [], createdAt: "", updatedAt: "", versions: [], modifiesDocument: true, qcProfile: "web" as const, steps: [], description: "", script: "", format: 2 as const };

const labels: Routine = {
  ...base,
  id: "labels",
  name: "Labels",
  appId: "figma",
  kind: "actions",
  inputs: [
    { key: "file", label: "Figma file", type: "document", required: true },
    { key: "products", label: "Products", type: "rows", required: true, columns: ["name", "ean"] },
  ],
  settings: [],
  iterate: { input: "products" },
  outputs: [{ key: "files", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
  actions: [
    { action: "duplicateNode", id: "l", node: "Label" },
    { action: "setText", node: "$l.#Name", text: "{{item.name}}" },
  ],
};

const mockups: Routine = {
  ...base,
  id: "mockups",
  name: "Mockups",
  appId: "photoshop",
  kind: "script",
  inputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
  settings: [{ key: "quality", label: "Quality", type: "number", required: false, default: 80 }],
  iterate: { input: "labels" },
  outputs: [{ key: "images", label: "Mockups", type: "fileList", required: true, extensions: ["jpg"] }],
  script: "/* script */",
};

const cards: Routine = {
  ...base,
  id: "cards",
  name: "Cards",
  appId: "figma",
  kind: "actions",
  inputs: [
    { key: "products", label: "Products", type: "rows", required: true },
    { key: "labels", label: "Label images", type: "fileList", required: true, extensions: ["png"] },
  ],
  settings: [],
  iterate: { input: "products" },
  outputs: [{ key: "files", label: "Cards", type: "fileList", required: true }],
  actions: [
    { action: "setText", node: "Card", text: "card-{{item.name}}" },
    { action: "setImageFill", node: "Card", image: { file: "{{matched.labels}}" } },
  ],
};

function flow(extra: Partial<Flow> = {}): Flow {
  return {
    id: "flow1",
    name: "Labels and mockups",
    description: "",
    version: 3,
    createdAt: "",
    updatedAt: "",
    runs: [],
    createdWithAiCalls: 0,
    nodes: [
      { id: "in-products", kind: "input", port: { key: "products", label: "Product data", type: "rows", required: true }, position: { x: 0, y: 0 } },
      { id: "n-labels", kind: "routine", routineId: "labels", routineVersion: 1, position: { x: 0, y: 0 } },
      { id: "n-mockups", kind: "routine", routineId: "mockups", routineVersion: 1, settings: { quality: 95 }, position: { x: 0, y: 0 } },
      { id: "out", kind: "output", port: { key: "out", label: "Mockups folder", type: "fileList", required: false }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", from: { nodeId: "in-products", port: "products" }, to: { nodeId: "n-labels", port: "products" } },
      { id: "e2", from: { nodeId: "n-labels", port: "files" }, to: { nodeId: "n-mockups", port: "labels" } },
      { id: "e3", from: { nodeId: "n-mockups", port: "images" }, to: { nodeId: "out", port: "out" } },
    ],
    ...extra,
  };
}

const info = (routines: Record<string, Routine>): FlowRoutines => ({ routines, stageKind: (id) => (id === "figma" ? "actions" : "script") });

async function spec(extra: Partial<FlowRunSpec> = {}): Promise<FlowRunSpec> {
  const csv = path.join(dir, "products.csv");
  await fs.writeFile(csv, "name,ean\nHoney,4006381333931\nBAD,5901234123457\nJam,9780306406157\n");
  return {
    runId: "run1",
    flow: flow(),
    info: info({ "n-labels": labels, "n-mockups": mockups }),
    inputs: { "in-products": csv },
    outputFolders: { out: path.join(dir, "out") },
    documents: { figma: "figma:abc" },
    target: "copy",
    runDir: path.join(dir, "runs", "run1"),
    copiesDir: path.join(dir, "copies"),
    isCancelled: () => false,
    ...extra,
  };
}

const hooks = { onProgress: () => undefined, onOutputs: () => undefined };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-flows-"));
  calls.length = 0;
});

describe("flow runner", () => {
  it("hands files from Figma to Photoshop item by item, with partial failure, and saves to the picked folder", async () => {
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec(), hooks);

    expect(res.status).toBe("partial");
    expect(res.nodes.map((n) => n.nodeId)).toEqual(["in-products", "n-labels", "n-mockups", "out"]);
    const [, figma, ps, out] = res.nodes;
    expect(figma.items.map((i) => [i.label, i.status])).toEqual([
      ["Row 1 · Honey", "done"],
      ["Row 2 · BAD", "failed"],
      ["Row 3 · Jam", "done"],
    ]);
    expect(figma.status).toBe("partial");
    // Only the rows that worked reach Photoshop, still keyed by their row; settings come from the node.
    expect(ps.items.map((i) => [i.key, i.label, i.status])).toEqual([
      ["row-1", "Honey.png", "done"],
      ["row-3", "Jam.png", "done"],
    ]);
    expect(calls).toEqual([
      "figma:begin:n-labels:copy",
      "figma:item:n-labels:Honey",
      "figma:item:n-labels:BAD",
      "figma:item:n-labels:Jam",
      "figma:end:n-labels",
      "ps:begin",
      "ps:item:Honey:95",
      "ps:item:Jam:95",
      "ps:end",
      "figma:endRun:run1",
    ]);
    // Each node works in its own folder; the output node copies the final files.
    expect(await fs.readdir(path.join(dir, "runs", "run1", "n-labels"))).toEqual(["Honey.png", "Jam.png"]);
    expect((await fs.readdir(path.join(dir, "out"))).sort()).toEqual(["Honey.jpg", "Jam.jpg"]);
    expect(out).toMatchObject({ status: "done", done: 2 });
    // Edge labels say what flowed.
    expect(res.edges.find((e) => e.edgeId === "e2")).toEqual({ edgeId: "e2", count: 2, label: "2 PNG" });
    // Results per node and item, failed items included; findings tied to the item's outputs.
    // The routine's own error is the routine's to fix; the action it failed in goes to the details.
    expect(res.outputs.find((o) => o.itemKey === "row-2")).toMatchObject({ node: "n-labels", status: "failed", error: "No layer", errorDetail: "Action 2 (setText): no layer", cause: "routine" });
    expect(res.findings).toEqual([expect.objectContaining({ type: "text-overflow", outputKey: "n-labels:row-3-export-1" })]);
  });

  it("runs a row with an empty cell: it's normal data, made without that value", async () => {
    const csv = path.join(dir, "no-code.csv");
    await fs.writeFile(csv, "name,ean\nHoney,4006381333931\nNoCode,\n");
    const res = await new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()])).run(await spec({ inputs: { "in-products": csv } }), hooks);
    expect(res.nodes[0].items.every((i) => i.status !== "failed")).toBe(true);
    expect(res.nodes[1].items.map((i) => [i.label, i.status])).toEqual([
      ["Row 1 · Honey", "done"],
      ["Row 2 · NoCode", "done"],
    ]);
  });

  it("previews the files a routine saved, and the copies saved to the folder show the same preview", async () => {
    const preview = (target: string) => ({ kind: "image" as const, src: `data:image/png;base64,${Buffer.from(target).toString("base64")}`, label: path.basename(target) });
    const photoshop = { ...fakePhotoshop(), renderPreview: async (target: string) => preview(target) } as unknown as DesignAppAdapter;
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), photoshop]));
    const res = await runner.run(await spec(), hooks);
    const made = res.outputs.filter((o) => o.node === "n-mockups");
    expect(made.map((o) => [o.label, o.preview?.label])).toEqual([
      ["Honey.jpg", "Honey.jpg"],
      ["Jam.jpg", "Jam.jpg"],
    ]);
    expect(made[0].preview!.src).toBe(preview(`file:${made[0].filePath}`).src);
    const saved = res.outputs.filter((o) => o.node === "out");
    expect(saved.map((o) => o.preview?.src)).toEqual(made.map((o) => o.preview!.src));
    // The fake Figma can't render previews: its outputs stay without one and the run goes on.
    expect(res.outputs.find((o) => o.node === "n-labels" && o.status === "done")!.preview).toBeUndefined();
  });

  it("pairs a second list with each item through the edge's match rule and reports what has no match", async () => {
    const f = flow({
      nodes: [...flow().nodes.slice(0, 2), { id: "n-cards", kind: "routine", routineId: "cards", routineVersion: 1, position: { x: 0, y: 0 } }],
      edges: [
        flow().edges[0],
        { id: "e4", from: { nodeId: "in-products", port: "products" }, to: { nodeId: "n-cards", port: "products" } },
        { id: "e5", from: { nodeId: "n-labels", port: "files" }, to: { nodeId: "n-cards", port: "labels" }, match: { by: "fileNameEqualsColumn", column: "name", ignoreExtension: true } },
      ],
    });
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec({ flow: f, info: info({ "n-labels": labels, "n-cards": cards }) }), hooks);
    const cardsNode = res.nodes.find((n) => n.nodeId === "n-cards")!;
    expect(cardsNode.items.map((i) => [i.key, i.status, i.error])).toEqual([
      ["row-1", "done", undefined],
      ["row-2", "skipped", "Skipped: it failed in Labels."],
      ["row-3", "done", undefined],
    ]);
    expect(calls).toContain("figma:item:n-cards:card-Honey+Honey.png");
    expect(calls).toContain("figma:item:n-cards:card-Jam+Jam.png");
  });

  it("reports an unmatched item one by one instead of failing the run", async () => {
    const f = flow({
      nodes: [flow().nodes[0], { id: "in-labels", kind: "input", port: { key: "labels", label: "Label images", type: "fileList", required: true }, position: { x: 0, y: 0 } }, { id: "n-cards", kind: "routine", routineId: "cards", routineVersion: 1, position: { x: 0, y: 0 } }],
      edges: [
        { id: "e4", from: { nodeId: "in-products", port: "products" }, to: { nodeId: "n-cards", port: "products" } },
        { id: "e5", from: { nodeId: "in-labels", port: "labels" }, to: { nodeId: "n-cards", port: "labels" }, match: { by: "fileNameEqualsColumn", column: "name", ignoreExtension: true } },
      ],
    });
    await fs.writeFile(path.join(dir, "honey.png"), fakeImage("honey.png"));
    const res = await new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()])).run(
      await spec({ flow: f, info: info({ "n-cards": cards }), inputs: { ...(await spec()).inputs, "in-labels": [path.join(dir, "honey.png")] } }),
      hooks,
    );
    const cardsNode = res.nodes.find((n) => n.nodeId === "n-cards")!;
    expect(cardsNode.items.find((i) => i.key === "row-1")!.status).toBe("done");
    // No partner: the files' problem, not the routine's.
    expect(cardsNode.items.find((i) => i.key === "row-3")).toMatchObject({ status: "failed", error: "No label image for Row 3 · Jam: Jam not found.", cause: "files" });
    expect(res.status).toBe("partial");
  });

  it("runs one sample item for trials, and only the given items again", async () => {
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const one = await runner.run(await spec({ sampleIndex: 2, target: "trial" }), hooks);
    expect(calls.filter((c) => c.includes(":item:"))).toEqual(["figma:item:n-labels:Jam", "ps:item:Jam:95"]);
    expect(one.status).toBe("succeeded");
    calls.length = 0;
    const again = await runner.run(await spec({ onlyItems: new Set(["row-3"]) }), hooks);
    expect(again.nodes[1].items.map((i) => i.key)).toEqual(["row-3"]);
    expect(again.nodes[2].items.map((i) => i.key)).toEqual(["row-3"]);
    expect(again.status).toBe("succeeded");
  });

  it("pairs what an earlier step made for a row with that row, whatever its file is called", async () => {
    // The labels are named after the product, but the edge looks for the EAN in the file names (like cutouts named
    // by SKU that a later step looked for by name): both came from the same rows, so they pair by row.
    const f = flow({
      nodes: [...flow().nodes.slice(0, 2), { id: "n-cards", kind: "routine", routineId: "cards", routineVersion: 1, position: { x: 0, y: 0 } }],
      edges: [
        flow().edges[0],
        { id: "e4", from: { nodeId: "in-products", port: "products" }, to: { nodeId: "n-cards", port: "products" } },
        { id: "e5", from: { nodeId: "n-labels", port: "files" }, to: { nodeId: "n-cards", port: "labels" }, match: { by: "fileNameEqualsColumn", column: "ean", ignoreExtension: true } },
      ],
    });
    const res = await new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()])).run(await spec({ flow: f, info: info({ "n-labels": labels, "n-cards": cards }) }), hooks);
    expect(res.nodes.find((n) => n.nodeId === "n-cards")!.items.map((i) => [i.key, i.status])).toEqual([
      ["row-1", "done"],
      ["row-2", "skipped"],
      ["row-3", "done"],
    ]);
    expect(calls).toContain("figma:item:n-cards:card-Honey+Honey.png");
    expect(calls).toContain("figma:item:n-cards:card-Jam+Jam.png");
  });

  it("runs failed rows again with every photo there to find partners in", async () => {
    const f = flow({
      nodes: [flow().nodes[0], { id: "in-labels", kind: "input", port: { key: "labels", label: "Label images", type: "fileList", required: true }, position: { x: 0, y: 0 } }, { id: "n-cards", kind: "routine", routineId: "cards", routineVersion: 1, position: { x: 0, y: 0 } }],
      edges: [
        { id: "e4", from: { nodeId: "in-products", port: "products" }, to: { nodeId: "n-cards", port: "products" } },
        { id: "e5", from: { nodeId: "in-labels", port: "labels" }, to: { nodeId: "n-cards", port: "labels" }, match: { by: "fileNameEqualsColumn", column: "name", ignoreExtension: true } },
      ],
    });
    for (const n of ["honey.png", "jam.png"]) await fs.writeFile(path.join(dir, n), fakeImage(n));
    const photos = [path.join(dir, "honey.png"), path.join(dir, "jam.png")];
    const res = await new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()])).run(
      await spec({ flow: f, info: info({ "n-cards": cards }), inputs: { ...(await spec()).inputs, "in-labels": photos }, onlyItems: new Set(["row-3"]) }),
      hooks,
    );
    expect(res.nodes.find((n) => n.nodeId === "n-cards")!.items.map((i) => [i.key, i.status])).toEqual([["row-3", "done"]]);
    expect(calls).toContain("figma:item:n-cards:card-Jam+jam.png");
  });

  it("runs an earlier step over all its photos again when rows failed further on", async () => {
    const cardsFromJpgs: Routine = { ...cards, inputs: [cards.inputs[0], { ...cards.inputs[1], extensions: ["jpg"] }] };
    const f = flow({
      nodes: [
        flow().nodes[0],
        { id: "in-photos", kind: "input", port: { key: "photos", label: "Photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
        { id: "n-mockups", kind: "routine", routineId: "mockups", routineVersion: 1, position: { x: 0, y: 0 } },
        { id: "n-cards", kind: "routine", routineId: "cards", routineVersion: 1, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", from: { nodeId: "in-photos", port: "photos" }, to: { nodeId: "n-mockups", port: "labels" } },
        { id: "e4", from: { nodeId: "in-products", port: "products" }, to: { nodeId: "n-cards", port: "products" } },
        { id: "e5", from: { nodeId: "n-mockups", port: "images" }, to: { nodeId: "n-cards", port: "labels" }, match: { by: "fileNameEqualsColumn", column: "name", ignoreExtension: true } },
      ],
    });
    for (const n of ["honey.png", "jam.png"]) await fs.writeFile(path.join(dir, n), fakeImage(n));
    const res = await new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()])).run(
      await spec({ flow: f, info: info({ "n-mockups": mockups, "n-cards": cardsFromJpgs }), inputs: { ...(await spec()).inputs, "in-photos": [path.join(dir, "honey.png"), path.join(dir, "jam.png")] }, onlyItems: new Set(["row-3"]) }),
      hooks,
    );
    expect(res.nodes.find((n) => n.nodeId === "n-mockups")!.items.map((i) => i.status)).toEqual(["done", "done"]);
    expect(res.nodes.find((n) => n.nodeId === "n-cards")!.items.map((i) => [i.key, i.status])).toEqual([["row-3", "done"]]);
    expect(calls).toContain("figma:item:n-cards:card-Jam+jam.jpg");
  });

  it("fails the rest of a node when its app goes away", async () => {
    const res = await new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop("not-running")])).run(await spec(), hooks);
    const ps = res.nodes[2];
    expect(ps.items.every((i) => i.status === "failed" && i.error === "Photoshop isn't running.")).toBe(true);
    expect(ps.status).toBe("failed");
    expect(calls.filter((c) => c === "ps:end")).toHaveLength(1);
    expect(res.nodes[3]).toMatchObject({ status: "skipped", note: "Nothing reached this node to save." });
  });

  it("stops between items when cancelled, keeps what was finished, and still cleans up", async () => {
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec({ isCancelled: () => calls.filter((c) => c.startsWith("figma:item")).length >= 1 }), hooks);
    expect(res.status).toBe("cancelled");
    expect(calls).toEqual(["figma:begin:n-labels:copy", "figma:item:n-labels:Honey", "figma:end:n-labels", "figma:endRun:run1"]);
    expect(res.nodes[2].status).toBe("skipped");
    expect(await fs.readdir(path.join(dir, "runs", "run1", "n-labels"))).toEqual(["Honey.png"]);
  });

  it("refuses to run an invalid flow, and reports a data file that can't be used", async () => {
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const broken = flow({ edges: flow().edges.slice(1) });
    await expect(runner.run(await spec({ flow: broken }), hooks)).rejects.toBeInstanceOf(FlowInvalidError);
    const bad = path.join(dir, "bad.csv");
    await fs.writeFile(bad, "title\nA\n");
    const res = await runner.run(await spec({ inputs: { "in-products": bad } }), hooks);
    expect(res.status).toBe("failed");
    expect(res.nodes[0].error).toContain('missing the columns "name" and "ean"');
    expect(res.nodes[1]).toMatchObject({ status: "skipped", error: "Skipped: Product data didn't produce what it needs." });
  });

  it("never overwrites files in the output folder", async () => {
    await fs.mkdir(path.join(dir, "out"), { recursive: true });
    await fs.writeFile(path.join(dir, "out", "Honey.jpg"), "mine");
    const runner = new FlowRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    await runner.run(await spec(), hooks);
    expect((await fs.readdir(path.join(dir, "out"))).sort()).toEqual(["Honey-2.jpg", "Honey.jpg", "Jam.jpg"]);
    expect(await fs.readFile(path.join(dir, "out", "Honey.jpg"), "utf8")).toBe("mine");
  });

  it("names results that share a file name by their size", async () => {
    await fs.mkdir(path.join(dir, "photos"));
    for (const n of ["honey.png", "jam.png"]) await fs.writeFile(path.join(dir, "photos", n), fakeImage(n));
    const sizes: Routine = { ...mockups, id: "sizes", name: "Sizes", inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["png"] }], iterate: { input: "photos" }, outputs: [{ key: "images", label: "Images", type: "fileList", required: true }] };
    const resizer = {
      id: "photoshop",
      name: "Adobe Photoshop",
      stageKind: "script",
      qcChecks: [],
      beginStage: async () => ({ state: {} }),
      endStage: async () => undefined,
      async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
        const item = input.item as { stem: string };
        // Jam's two sizes are the same: nothing tells them apart but the order.
        const made = await Promise.all(
          (item.stem === "jam" ? [[500, 500], [500, 500]] : [[1080, 1350], [1080, 1080]]).map(async ([w, h], k) => {
            const file = path.join(ctx.workDir, `size-${k}`, `${item.stem}.png`);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, fakeImage(file, w, h));
            return file;
          }),
        );
        return { ok: true, outputs: made.map((f, k) => ({ key: `${input.key}-${k}`, label: path.basename(f), filePath: f })), values: { images: made }, findings: [], log: [] };
      },
    } as unknown as DesignAppAdapter;
    const runFlow: Flow = {
      ...flow(),
      nodes: [
        { id: "in", kind: "input", port: { key: "photos", label: "Photos", type: "fileList", required: true }, position: { x: 0, y: 0 } },
        { id: "n", kind: "routine", routineId: "sizes", routineVersion: 1, position: { x: 0, y: 0 } },
        { id: "out", kind: "output", port: { key: "out", label: "Images", type: "fileList", required: false }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "e1", from: { nodeId: "in", port: "photos" }, to: { nodeId: "n", port: "photos" } },
        { id: "e2", from: { nodeId: "n", port: "images" }, to: { nodeId: "out", port: "out" } },
      ],
    };
    const runner = new FlowRunner(new AdapterRegistry([resizer]));
    const result = await runner.run(await spec({ flow: runFlow, info: info({ n: sizes }), inputs: { in: path.join(dir, "photos") } }), hooks);
    expect((await fs.readdir(path.join(dir, "out"))).sort()).toEqual(["honey-1080x1080.png", "honey-1080x1350.png", "jam-2.png", "jam.png"]);
    expect(result.nodes.find((n) => n.nodeId === "out")?.note).toBe("2 results with the same name end with their size in pixels. 2 results with the same name end in -2, -3… in the order they were made.");
  });

  it("runs end to end with simulated apps and forced failures (dev panel)", async () => {
    const real = new AdapterRegistry([fakeFigma(), fakePhotoshop()]);
    const runner = new FlowRunner(simulatedApps(real, 0));
    const res = await runner.run(await spec({ forceFail: { "n-labels": { items: [1] } } }), hooks);
    expect(calls).toEqual([]);
    const figma = res.nodes[1];
    expect(figma.items.map((i) => [i.key, i.status])).toEqual([
      ["row-1", "failed"],
      ["row-2", "done"],
      ["row-3", "done"],
    ]);
    expect(figma.items[0].error).toBe("Forced failure (dev panel).");
    expect(res.nodes[2].items.map((i) => i.key)).toEqual(["row-2", "row-3"]);
    expect((await fs.readdir(path.join(dir, "out"))).sort()).toEqual(["Row 2 - BAD.jpg", "Row 3 - Jam.jpg"]);
    const whole = await runner.run(await spec({ runId: "run2", runDir: path.join(dir, "runs", "run2"), forceFail: { "n-mockups": { node: true } } }), hooks);
    expect(whole.nodes[2]).toMatchObject({ status: "failed", error: "Forced failure (dev panel)." });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../electron/adapters/adobe/bridge";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import { StageRunner, type StageRunSpec } from "../electron/core/stages/stageRunner";
import type { ParamDef, Stage } from "../electron/core/types";

// Two fake apps: "figma" makes one PNG per data row (a row named BAD fails), "photoshop" turns each PNG into a JPG
// in the output folder. They record what the runner asked of them.

let dir: string;
const calls: string[] = [];

function fakeFigma(): DesignAppAdapter {
  return {
    id: "figma",
    name: "Figma",
    stageKind: "actions",
    async beginStage(ctx: StageRunContext) {
      calls.push(`figma:begin:${ctx.target}`);
      return { state: {}, documentName: "File · Page" };
    },
    async runStageItem(_s: unknown, input: StageItemInput, ctx: StageRunContext) {
      const actions = (input.body as { actions: { text?: string }[] }).actions;
      const text = actions.find((a) => a.text)!.text!;
      calls.push(`figma:item:${text}`);
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
    async endStage() {
      calls.push("figma:end");
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
    async beginStage() {
      calls.push("ps:begin");
      return { state: {} };
    },
    async runStageItem(_s: unknown, input: StageItemInput) {
      if (fail) throw new BridgeError("not-running", "Photoshop isn't running.");
      const item = input.item as { path: string; stem: string };
      calls.push(`ps:item:${item.stem}`);
      const out = path.join(String(input.params.out), `${item.stem}.jpg`);
      await fs.writeFile(out, await fs.readFile(item.path));
      return { ok: true, outputs: [{ key: `${input.key}-file-1`, label: path.basename(out), filePath: out }], values: { images: [out] }, findings: [], log: [] };
    },
    async endStage() {
      calls.push("ps:end");
    },
  } as unknown as DesignAppAdapter;
}

const params: ParamDef[] = [
  { key: "products", label: "Products", type: "dataFile", required: true, columns: ["name", "ean"] },
  { key: "out", label: "Output", type: "folder", required: true, role: "output" },
];

const stages: Stage[] = [
  {
    id: "s1",
    name: "Labels",
    appId: "figma",
    kind: "actions",
    repeat: { over: "{{params.products.rows}}" },
    inputs: [],
    outputs: [{ key: "files", type: "fileList" }],
    body: { actions: [{ action: "duplicateNode", id: "l", node: "Label" }, { action: "setText", node: "$l.#Name", text: "{{item.name}}" }] },
  },
  {
    id: "s2",
    name: "Mockups",
    appId: "photoshop",
    kind: "script",
    document: "none",
    repeat: { over: "{{stage.s1.outputs.files}}" },
    inputs: [],
    outputs: [{ key: "images", type: "fileList" }],
    body: "/* script */",
  },
];

async function spec(extra: Partial<StageRunSpec> = {}): Promise<StageRunSpec> {
  const csv = path.join(dir, "products.csv");
  await fs.writeFile(csv, "name,ean\nHoney,4006381333931\nBAD,5901234123457\nJam,9780306406157\nNoCode,\n");
  const out = path.join(dir, "out");
  await fs.mkdir(out, { recursive: true });
  return {
    runId: "run1",
    routineName: "Labels and mockups",
    stages,
    params,
    values: { products: csv, out },
    target: "copy",
    documents: { figma: "figma:abc" },
    runDir: path.join(dir, "runs", "run1"),
    copiesDir: path.join(dir, "copies"),
    isCancelled: () => false,
    ...extra,
  };
}

const hooks = { onProgress: () => undefined, onOutputs: () => undefined };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-stages-"));
  calls.length = 0;
});

describe("stage runner", () => {
  it("hands files from Figma to Photoshop, item by item, and records partial failure", async () => {
    const runner = new StageRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec(), hooks);

    expect(res.status).toBe("partial");
    const [s1, s2] = res.stages;
    expect(s1.items.map((i) => [i.label, i.status])).toEqual([
      ["Row 1 · Honey", "done"],
      ["Row 2 · BAD", "failed"],
      ["Row 3 · Jam", "done"],
      ["Row 4 · NoCode", "failed"],
    ]);
    expect(s1.items[3].error).toBe('Row 4: "ean" is empty.');
    expect(s1.status).toBe("partial");
    // Only the rows that worked reach Photoshop, still keyed by their row.
    expect(s2.items.map((i) => [i.key, i.label, i.status])).toEqual([
      ["row-1", "Honey.png", "done"],
      ["row-3", "Jam.png", "done"],
    ]);
    expect(s2.status).toBe("done");
    expect(calls).toEqual([
      "figma:begin:copy",
      "figma:item:Honey",
      "figma:item:BAD",
      "figma:item:Jam",
      "figma:end",
      "ps:begin",
      "ps:item:Honey",
      "ps:item:Jam",
      "ps:end",
      "figma:endRun:run1",
    ]);
    // Files: Figma's in the stage's working folder, Photoshop's in the picked output folder.
    expect(await fs.readdir(path.join(dir, "runs", "run1", "s1"))).toEqual(["Honey.png", "Jam.png"]);
    expect((await fs.readdir(path.join(dir, "out"))).sort()).toEqual(["Honey.jpg", "Jam.jpg"]);
    expect(res.stageOutputs.s2.outputs.images).toHaveLength(2);
    // Results per stage and item, failed items included; findings tied to the item's outputs.
    const s1Status = Object.fromEntries(res.outputs.filter((o) => o.stageId === "s1").map((o) => [o.itemKey, o.status]));
    expect(s1Status).toEqual({ "row-1": "done", "row-2": "failed", "row-3": "done", "row-4": "failed" });
    expect(res.outputs.find((o) => o.itemKey === "row-2")).toMatchObject({ status: "failed", error: "Action 2 (setText): no layer" });
    expect(res.findings).toEqual([expect.objectContaining({ type: "text-overflow", outputKey: "s1:row-3-export-1" })]);
  });

  it("runs one sample item for previews and trials", async () => {
    const runner = new StageRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec({ sampleIndex: 2, target: "trial", stopAfter: "s1" }), hooks);
    expect(res.stages).toHaveLength(1);
    expect(calls).toEqual(["figma:begin:trial", "figma:item:Jam", "figma:end", "figma:endRun:run1"]);
    expect(res.status).toBe("succeeded");
  });

  it("runs only the given items again", async () => {
    const runner = new StageRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec({ onlyItems: new Set(["row-3"]) }), hooks);
    expect(res.stages[0].items.map((i) => i.key)).toEqual(["row-3"]);
    expect(res.stages[1].items.map((i) => i.key)).toEqual(["row-3"]);
    expect(res.status).toBe("succeeded");
  });

  it("fails the rest of a stage when its app goes away", async () => {
    const runner = new StageRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop("not-running")]));
    const res = await runner.run(await spec(), hooks);
    expect(res.stages[1].items.every((i) => i.status === "failed" && i.error === "Photoshop isn't running.")).toBe(true);
    expect(res.stages[1].status).toBe("failed");
    expect(calls.filter((c) => c === "ps:end")).toHaveLength(1);
  });

  it("stops between items when cancelled and still cleans up", async () => {
    let n = 0;
    const runner = new StageRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const res = await runner.run(await spec({ isCancelled: () => calls.filter((c) => c.startsWith("figma:item")).length >= 1 && ++n > 0 }), hooks);
    expect(res.status).toBe("cancelled");
    expect(calls).toEqual(["figma:begin:copy", "figma:item:Honey", "figma:end", "figma:endRun:run1"]);
    expect(res.stages[1].status).toBe("skipped");
  });

  it("reports a data file that can't be used", async () => {
    const runner = new StageRunner(new AdapterRegistry([fakeFigma(), fakePhotoshop()]));
    const bad = path.join(dir, "bad.csv");
    await fs.writeFile(bad, "title\nA\n");
    await expect(runner.run({ ...(await spec()), values: { products: bad, out: dir } }, hooks)).rejects.toThrow('missing the columns "name" and "ean"');
  });
});

import { describe, expect, it } from "vitest";
import { sampleExports } from "../electron/core/routines/trialSample";
import type { FigmaActionStep } from "../electron/core/types";
import { parseWireActions } from "../electron/shared/figmaActions";
import { Interpreter } from "../figma-plugin/src/interpreter";
import { FakeFigma } from "./helpers/fakeFigma";

const exportOf = (node: string, output = "screens", scale = 2): FigmaActionStep => ({ action: "exportNode", node, format: "PNG", scale, fileName: node, output });
const made = (actions: FigmaActionStep[]) => actions.filter((a) => a.action === "exportNode").map((a) => `${a.node}@${a.scale}`);

describe("the exports a trial makes", () => {
  it("makes the first and last of each output, as in a routine of 12 frames at 1x and 2x", () => {
    const frames = Array.from({ length: 12 }, (_, i) => `frame${i + 1}`);
    const actions = [...frames.map((f) => exportOf(f, "screens_1x", 1)), ...frames.map((f) => exportOf(f, "screens_2x", 2))];
    const { actions: tried, sample } = sampleExports(actions);
    expect(sample).toEqual({ tried: 4, total: 24 });
    expect(made(tried)).toEqual(["frame1@1", "frame12@1", "frame1@2", "frame12@2"]);
    expect(tried).toHaveLength(24);
  });

  it("tries each scale and format, even when they go to one output", () => {
    const actions = ["a", "b", "c"].flatMap((f) => [exportOf(f, "all", 1), exportOf(f, "all", 2)]);
    expect(made(sampleExports(actions).actions)).toEqual(["a@1", "a@2", "c@1", "c@2"]);
    const formats = [...["a", "b", "c"].map((f) => exportOf(f)), { action: "exportNode", node: "a", format: "SVG", output: "screens" }];
    expect(sampleExports(formats).actions.filter((a) => a.format === "SVG")).toHaveLength(1);
  });

  it("leaves a short list alone, and everything that isn't an export", () => {
    const actions: FigmaActionStep[] = [{ action: "duplicateNode", id: "copy", node: "Card" }, exportOf("$copy"), exportOf("Other")];
    expect(sampleExports(actions)).toEqual({ actions });
  });

  it("doesn't change the routine's own list", () => {
    const actions = ["a", "b", "c"].map((f) => exportOf(f));
    const before = structuredClone(actions);
    sampleExports(actions);
    expect(actions).toEqual(before);
  });
});

describe("a sampled list in the plugin", () => {
  function page() {
    const figma = new FakeFigma();
    for (const name of ["a", "b", "c", "d"]) figma.node("FRAME", name, figma.currentPage, { width: 100, height: 100 });
    return figma;
  }

  async function run(figma: FakeFigma, actions: FigmaActionStep[]) {
    const parsed = parseWireActions({ actions });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return new Interpreter({
      figma: figma as unknown as PluginAPI,
      page: figma.currentPage as unknown as PageNode,
      createdPages: [],
      isCancelled: () => false,
      progress: () => undefined,
    }).runAll(parsed.actions);
  }

  it("exports the sample, adds nothing to the output for the others, and later actions can still use their ids", async () => {
    const figma = page();
    const actions = [exportOf("a"), { ...exportOf("b"), id: "second" }, exportOf("c"), exportOf("d"), { action: "renameNode", node: "$second", name: "renamed" }];
    const res = await run(figma, sampleExports(actions).actions);
    expect(res.ok).toBe(true);
    expect(res.exports.map((e) => e.fileName)).toEqual(["a", "d"]);
    expect(res.outputs.screens).toBeUndefined();
    expect(figma.currentPage.children.map((n) => n.name)).toContain("renamed");
  });

  it("still fails when a frame it didn't export isn't there", async () => {
    const res = await run(page(), sampleExports([exportOf("a"), exportOf("Missing"), exportOf("d")]).actions);
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("Missing");
  });
});

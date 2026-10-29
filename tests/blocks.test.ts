import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIGMA_BLOCKS } from "../electron/adapters/figma/blocks";
import { INDESIGN_HELPERS } from "../electron/adapters/indesign/helpers";
import { indesignLibrary } from "../electron/adapters/indesign/library";
import { lintPhotoshopScript } from "../electron/adapters/photoshop/lint";
import { PHOTOSHOP_HELPERS } from "../electron/adapters/photoshop/helpers";
import { photoshopLibrary } from "../electron/adapters/photoshop/library";
import { AdapterRegistry } from "../electron/adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageRunContext } from "../electron/adapters/types";
import { analyzeCode, similarity, stepBlocks, tagSteps } from "../electron/core/blocks/analysis";
import { BlockService, PROMOTION_RULE, promotionDecision, scoreOf } from "../electron/core/blocks/candidates";
import { expandComposites } from "../electron/core/blocks/composites";
import { BUILTIN_BLOCKS, BlockRegistry, blocks } from "../electron/core/blocks/registry";
import { runHelperTests } from "../electron/core/blocks/testRunner";
import type { CompositeAction, HelperDef, HelperTestResult } from "../electron/core/blocks/types";
import { stageFor } from "../electron/core/flows/nodeRunner";
import { validateRoutine } from "../electron/core/routines/contract";
import { toRoutineDraft } from "../electron/core/routines/modelRoutine";
import type { Routine, Run } from "../electron/core/types";

// Building blocks: the built-in library, retrieval, pinning, tested vs custom steps, Figma composite actions, the
// test runner, and growing the library from custom code (capture, evidence, generalize, approve, export, auto).

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-blocks-"));
  blocks.usePersonalDir(null);
});
afterEach(() => blocks.usePersonalDir(null));

const es3 = (source: string) => parse(source, { ecmaVersion: 3, allowReserved: true });

describe("the built-in library", () => {
  it("has a test, docs and a unique id and name for every block", () => {
    for (const d of BUILTIN_BLOCKS) {
      expect(d.tests.length, d.id).toBeGreaterThan(0);
      expect(d.summary && d.doc && d.signature && d.set, d.id).toBeTruthy();
      expect(d.id.startsWith({ photoshop: "ps.", indesign: "id.", figma: "figma." }[d.app]), d.id).toBe(true);
    }
    const keys = BUILTIN_BLOCKS.map((d) => `${d.id}@${d.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const app of ["photoshop", "indesign", "figma"]) {
      const calls = BUILTIN_BLOCKS.filter((d) => d.app === app && d.version === 1).map((d) => d.call);
      expect(new Set(calls).size).toBe(calls.length);
    }
  });

  it("puts every helper in the scripts' library, which is still ES3, in sets per app", () => {
    expect(() => es3(photoshopLibrary())).not.toThrow();
    expect(() => es3(indesignLibrary())).not.toThrow();
    for (const d of PHOTOSHOP_HELPERS) expect(photoshopLibrary()).toContain(`function ${d.call}(`);
    for (const d of INDESIGN_HELPERS) expect(indesignLibrary()).toContain(`DopplLib.${d.call.slice(4)} = function`);
    expect([...new Set(PHOTOSHOP_HELPERS.map((d) => d.set))].sort()).toEqual(["color", "documents", "export", "layers", "masking", "smartObjects"]);
    for (const b of FIGMA_BLOCKS) expect(() => JSON.parse(b.code) as CompositeAction).not.toThrow();
  });
});

describe("retrieval", () => {
  it("ranks blocks by the request and gives a compact index with the top ones in full", () => {
    const ranked = blocks.rank("photoshop", "Remove the white background with a layer mask and keep highlights");
    expect(ranked[0].call).toBe("maskWhiteBackground");
    expect(ranked.slice(0, 3).map((d) => d.call)).toContain("removeWhiteBackground");
    const index = blocks.indexText("photoshop", "mask the white background");
    for (const d of blocks.latest("photoshop")) expect(index).toContain(`- ${d.call} (${d.id} v${d.version})`);
    expect(index).toContain("### maskWhiteBackground");
    expect(index.split("### ").length - 1).toBe(3);
    // The whole catalog in full is longer than the index.
    const full = blocks.docs(blocks.latest("photoshop").map((d) => d.id));
    expect(index.length).toBeLessThan(full.length + 2000);
  });

  it("searches blocks and returns their docs", () => {
    expect(blocks.search("photoshop", "smart object").map((d) => d.call)).toContain("replaceSmartObject");
    expect(blocks.search("indesign", "page range").map((d) => d.call)).toContain("ctx.resolvePages");
    expect(blocks.docs(["ps.cropToBounds", "nope"])).toMatch(/### cropToBounds[\s\S]*### nope\nNo building block/);
  });
});

/** A promoted v2 of maskWhiteBackground in a personal library. */
async function withMaskV2() {
  blocks.usePersonalDir(path.join(dir, "helpers"));
  const v1 = blocks.get("ps.maskWhiteBackground", 1)!;
  await blocks.savePersonal({ ...v1, version: 2, summary: "v2 summary", code: v1.code.replace("function maskWhiteBackground(", "function maskWhiteBackground(/* v2 */") });
}

const routine = (extra: Partial<Routine> = {}): Routine => ({
  id: "r1",
  name: "Masked cut-outs",
  appId: "photoshop",
  description: "",
  kind: "script",
  steps: [
    { id: "s1", plainLanguage: "Opens each photo and keeps a hidden copy" },
    { id: "s2", plainLanguage: "Hides the white with a mask" },
    { id: "s3", plainLanguage: "Saves a PNG" },
  ],
  inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
  outputs: [{ key: "pngs", label: "PNGs", type: "fileList", required: true, extensions: ["png"] }],
  settings: [],
  iterate: { input: "photos" },
  script: [
    "// step 1",
    "var img = openDocument(ctx.item.path);",
    "var copy = img.activeLayer.duplicate();",
    "copy.visible = false;",
    "// step 2",
    "var cut = maskWhiteBackground(img.activeLayer);",
    "// step 3",
    'ctx.output("pngs", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
  ].join("\n"),
  version: 1,
  createdWithAiCalls: 2,
  appVersion: "",
  requiredFonts: [],
  runs: [],
  createdAt: "",
  updatedAt: "",
  versions: [{ version: 1, createdAt: "", aiCalls: 2, note: "Created" }],
  modifiesDocument: false,
  qcProfile: "web",
  format: 2,
  ...extra,
});

describe("pinning", () => {
  it("pins the blocks a routine uses at their newest version, and runs exactly the pinned versions", async () => {
    await withMaskV2();
    const r = routine();
    const pins = blocks.pinsFor("photoshop", r);
    expect(pins).toEqual({ "ps.openDocument": 1, "ps.maskWhiteBackground": 2, "ps.exportImage": 1 });
    // A routine saved before blocks were pinned runs every block's first version: the library it always ran.
    const legacy = stageFor(routine(), "routine", "r").blocks!.code!;
    expect(legacy.find((c) => c.id === "ps.maskWhiteBackground")).toMatchObject({ version: 1 });
    expect(photoshopLibrary(legacy)).toBe(photoshopLibrary());
    const pinned = stageFor(routine({ helpers: pins }), "routine", "r").blocks!.code!;
    expect(pinned.find((c) => c.id === "ps.maskWhiteBackground")!.code).toContain("/* v2 */");
    expect(stageFor(routine({ helpers: { "ps.maskWhiteBackground": 1 } }), "routine", "r").blocks!.code!.find((c) => c.id === "ps.maskWhiteBackground")!.version).toBe(1);
    // Newer versions of pinned blocks are offered; unpinned (legacy) routines are left alone.
    expect(blocks.updates("photoshop", { "ps.maskWhiteBackground": 1, "ps.exportImage": 1 })).toEqual([
      { id: "ps.maskWhiteBackground", call: "maskWhiteBackground", from: 1, to: 2, summary: "v2 summary" },
    ]);
    expect(blocks.updates("photoshop", undefined)).toEqual([]);
    expect(blocks.versions("ps.maskWhiteBackground")).toEqual([1, 2]);
  });
});

describe("tested and custom steps", () => {
  it("tags each step by its // step marker: building blocks only, or code written for the routine", () => {
    const tagged = tagSteps(routine(), blocks.latest("photoshop"));
    expect(tagged.steps.map((s) => [s.kind, s.blocks])).toEqual([
      ["custom", ["ps.openDocument"]],
      ["tested", ["ps.maskWhiteBackground"]],
      ["tested", ["ps.exportImage"]],
    ]);
    expect(tagged.blocks.sort()).toEqual(["ps.exportImage", "ps.maskWhiteBackground", "ps.openDocument"]);
    expect([...tagged.customCode.keys()]).toEqual([1]);
    // Without markers the whole script counts for every step.
    const plain = tagSteps(routine({ script: routine().script.replace(/\/\/ step \d\n/g, "") }), blocks.latest("photoshop"));
    expect(plain.steps.every((s) => s.kind === "custom")).toBe(true);
    // Figma action lists are always tested.
    expect(tagSteps({ steps: routine().steps, kind: "actions", actions: [] }, [], ["figma.fillTemplate"]).steps.every((s) => s.kind === "tested")).toBe(true);
  });

  it("knows building blocks, plain JavaScript and the ctx API from app automation", () => {
    const helpers = blocks.latest("photoshop");
    expect(analyzeCode('var n = parseInt("3", 10); var s = ctx.join(ctx.workDir, "a" + n).replace(/x/g, ""); trimTransparent(doc);', helpers)).toEqual({ blocks: ["ps.trimTransparent"], custom: [] });
    expect(analyzeCode('executeAction(charIDToTypeID("Mk  "), new ActionDescriptor(), DialogModes.NO);', helpers).custom).toEqual(expect.arrayContaining(["executeAction", "new ActionDescriptor"]));
    expect(analyzeCode('findLayer("A").duplicate(); doc.width.as("px");', helpers)).toEqual({ blocks: ["ps.findLayer"], custom: [".duplicate()"] });
    expect(analyzeCode("doc.selection.deselect();", helpers).custom).toEqual(["doc.selection.deselect"]);
    expect(stepBlocks("var a;\n// step 2\nb();\n// Step 3: export\nc();")).toEqual(
      new Map([
        [2, "var a;\n\nb();\n"],
        [3, "\nc();"],
      ]),
    );
    expect(analyzeCode("ctx.resolvePages(params.pages); ctx.log(1);", blocks.latest("indesign")).blocks).toEqual(["id.resolvePages"]);
  });
});

describe("Figma composite actions", () => {
  const blocksByName = Object.fromEntries(FIGMA_BLOCKS.map((d) => [d.call, JSON.parse(d.code) as CompositeAction]));

  it("expands a block into catalog actions: arguments, repeated actions, inner ids, and the block's result", () => {
    const { actions, problems, used } = expandComposites(
      [
        { action: "block", name: "fillTemplateAndExport", id: "label", output: "labels", args: { template: "Label", texts: { Name: "{{item.name}}", Price: "{{item.price}}" }, format: "PNG", fileName: "{{item.sku}}" } },
        { action: "measure", node: "$label" },
      ],
      blocksByName,
    );
    expect(problems).toEqual([]);
    expect(used).toEqual(["fillTemplateAndExport"]);
    expect(actions).toEqual([
      { action: "duplicateNode", id: "label", node: "Label" },
      { action: "setText", node: "$label.#Name", text: "{{item.name}}" },
      { action: "setText", node: "$label.#Price", text: "{{item.price}}" },
      { action: "measure", node: "$label" },
      { action: "exportNode", node: "$label", format: "PNG", fileName: "{{item.sku}}", output: "labels" },
      { action: "measure", node: "$label" },
    ]);
    // Without an id, inner ids get a prefix so two uses never clash.
    const twice = expandComposites(
      [
        { action: "block", name: "fillTemplate", args: { template: "A", images: ["x"] } },
        { action: "block", name: "fillTemplate", args: { template: "B" } },
      ],
      { fillTemplate: { params: [{ name: "template", type: "x" }, { name: "images", type: "list", optional: true }], actions: [{ action: "duplicateNode", id: "copy", node: "{{args.template}}" }, { $each: "{{args.images}}", do: { action: "setImageFill", node: "$copy.#Photo{{each.index}}", image: { file: "{{each.item}}" } } }], result: "copy" } },
    );
    expect(twice.actions.map((a) => [a.id ?? a.node, a.node])).toEqual([
      ["block1_copy", "A"],
      ["$block1_copy.#Photo1", "$block1_copy.#Photo1"],
      ["block2_copy", "B"],
    ]);
  });

  it("explains unknown blocks and missing arguments, and checks a routine that uses blocks like the plugin will run it", () => {
    expect(expandComposites([{ action: "block", name: "nope" }], blocksByName).problems[0]).toContain('no building block "nope"');
    expect(expandComposites([{ action: "block", name: "fillTemplate", args: {} }], blocksByName).problems[0]).toContain('give "template"');
    const draft = toRoutineDraft(
      {
        name: "Labels",
        app: "figma",
        inputs: [
          { key: "file", label: "File", type: "document", required: true },
          { key: "rows", label: "Rows", type: "rows", required: true, columns: ["name", "sku"] },
        ],
        iterate: { input: "rows" },
        outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
        settings: [],
        steps: ["Fills and exports a label per row"],
        actions: JSON.stringify([{ action: "block", name: "fillTemplateAndExport", output: "labels", args: { template: "Label", texts: { Name: "{{item.name}}" }, format: "PNG", fileName: "{{item.sku}}" } }]),
      },
      "figma",
      "actions",
      "",
    );
    const apps = { has: () => true, stageKind: () => "actions" as const, lintScript: () => [] };
    expect(validateRoutine(draft, apps, undefined, "figma").errors).toEqual([]);
    const wrong = { ...draft, actions: [{ action: "block", name: "fillTemplateAndExport", args: { template: "Label", format: "GIF" } }] } as never;
    expect(validateRoutine(wrong, apps, undefined, "figma").errors.map((e) => e.path).join(" ")).toContain("after expanding blocks");
  });
});

/** A Photoshop that "runs" test scripts: writes a PNG and returns data, and records the library it was given. */
function fakePhotoshop(libraries: string[], data: Record<string, unknown> = { w: 360, h: 240 }): DesignAppAdapter {
  return {
    id: "photoshop",
    name: "Adobe Photoshop",
    stageKind: "script",
    getStatus: async () => "connected",
    lintScript: (s: string) => lintPhotoshopScript(s),
    beginStage: async () => ({ state: {} }),
    endStage: async () => undefined,
    async runStageItem(_s: unknown, _input: StageItemInput, ctx: StageRunContext) {
      libraries.push(photoshopLibrary(ctx.stage.blocks?.code));
      await fs.mkdir(ctx.workDir, { recursive: true });
      const file = path.join(ctx.workDir, "out.png");
      await fs.writeFile(file, Buffer.from("89504e470d0a1a0a", "hex"));
      return { ok: true, outputs: [{ key: "f", label: "out.png", filePath: file }], values: {}, findings: [], log: [], data };
    },
  } as unknown as DesignAppAdapter;
}

describe("block tests in the apps", () => {
  it("runs each test with the block under test in the library, checks its data, and skips apps that aren't open", async () => {
    const libraries: string[] = [];
    const adapters = new AdapterRegistry([fakePhotoshop(libraries)]);
    const open = await runHelperTests([blocks.get("ps.openDocument")!], { adapters, registry: blocks, statusOf: async () => "connected", workRoot: dir });
    expect(open).toEqual([{ helper: "ps.openDocument", version: 1, test: "opens an image", passed: true, detail: "passed" }]);
    expect(libraries[0]).toBe(photoshopLibrary());
    const crop = await runHelperTests([blocks.get("ps.cropToBounds")!], { adapters, registry: blocks, statusOf: async () => "connected", workRoot: dir });
    expect(crop[0]).toMatchObject({ passed: false, detail: "w is 360, expected 160 · h is 240, expected 160" });
    const closed = await runHelperTests([blocks.get("ps.openDocument")!], { adapters, registry: blocks, statusOf: async () => "not-running", workRoot: dir });
    expect(closed[0]).toMatchObject({ passed: false, skipped: "Adobe Photoshop isn't open" });
  });
});

describe("growing the library from custom code", () => {
  const custom = [
    "// step 1",
    "var doc = openDocument(ctx.item.path);",
    "doc.resizeImage(UnitValue(params.width, \"px\"), null, null, ResampleMethod.BICUBIC);",
    "doc.flatten();",
    "// step 2",
    'ctx.output("out", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".jpg"), "jpg", 85));',
  ].join("\n");
  const resizeRoutine = (id: string, name: string, extra: Partial<Routine> = {}) =>
    routine({
      id,
      name,
      script: custom,
      steps: [
        { id: "a", plainLanguage: "Resizes each photo to the width you set" },
        { id: "b", plainLanguage: "Saves a JPG" },
      ],
      ...extra,
    });

  function service(opts: { answer?: string; tests?: HelperTestResult[]; auto?: boolean } = {}) {
    let calls = 0;
    const s = new BlockService({
      dir: path.join(dir, "helpers", "candidates"),
      registry: blocks,
      ai: {
        text: async () => {
          calls++;
          return (
            opts.answer ??
            `{"call":"resizeToWidth","set":"export","summary":"Resizes a document to a width in px, keeping proportions.","signature":{"params":[{"name":"doc","type":"Document"},{"name":"width","type":"number"}],"returns":"Document"},"sideEffects":["resizes the document"],"doc":"resizeToWidth(doc, width)\\nExample: resizeToWidth(img, 300);","tests":[{"name":"resizes","inputs":{"image":"/Users/designer/Photos/apricot.jpg"},"script":"var d = openDocument(params.image);\\nresizeToWidth(d, 300);\\nreturn { w: d.width.as(\\"px\\") };","checks":[],"expect":{"w":300}},{"name":"resizes a generated photo","inputs":{"image":"gen:photo"},"script":"var d = openDocument(params.image);\\nresizeToWidth(d, 300);\\nreturn { w: d.width.as(\\"px\\") };","checks":[],"expect":{"w":300}}]}\n` +
            "```javascript\nfunction resizeToWidth(doc, width) {\n  var d = doc || app.activeDocument;\n  d.resizeImage(UnitValue(width, \"px\"), null, null, ResampleMethod.BICUBIC);\n  return d;\n}\n```"
          );
        },
      } as never,
      lint: (_app, code) => lintPhotoshopScript(code),
      runTests: async (def) => opts.tests ?? def.tests.map((t) => ({ helper: def.id, version: def.version, test: t.name, passed: true, detail: "passed" })),
      autoPromote: () => !!opts.auto,
      aiContext: () => ({ onAiCall: () => undefined, isCancelled: () => false }),
    });
    return { s, calls: () => calls };
  }

  it("captures custom steps, merges code written twice, and scores it from runs and feedback", async () => {
    blocks.usePersonalDir(path.join(dir, "helpers"));
    const { s } = service();
    const [c] = await s.capture(resizeRoutine("r1", "Thumbnails"), { request: "Make 300px thumbnails", trialItems: 2, trialOk: 2, inputs: ["/x/a.jpg"] });
    expect(c).toMatchObject({ app: "photoshop", status: "candidate", occurrences: [{ routineId: "r1", step: "Resizes each photo to the width you set" }] });
    expect(c.code).toContain("resizeImage");
    // The same code (other names and values) in another routine: one candidate, written twice.
    const renamed = custom.replace(/doc/g, "image").replace("params.width", "params.size").replace("85", "70");
    expect(similarity(custom, renamed)).toBeGreaterThan(0.75);
    const [again] = await s.capture(resizeRoutine("r2", "Web images", { script: renamed }), { request: "Resize for the web", trialItems: 1, trialOk: 1, inputs: [] });
    expect(again.id).toBe(c.id);
    expect(again.occurrences.map((o) => o.routineId)).toEqual(["r1", "r2"]);
    expect((await s.list())).toHaveLength(1);
    // Evidence from a run of r1 (two items, one passed QC), a "Mark as OK" and a "This isn't right".
    const run = {
      outputs: [
        { id: "o1", node: "routine", itemKey: "a", itemLabel: "a.jpg", status: "done", qc: { status: "pass", checks: [] } },
        { id: "o2", node: "routine", itemKey: "b", itemLabel: "b.jpg", status: "done", qc: { status: "flagged", checks: [] } },
      ],
    } as unknown as Run;
    await s.recordRun(run, { routine: "r1" });
    await s.noteFeedback(["r1"], "ok");
    let [scored] = await s.list();
    expect(scored.evidence).toMatchObject({ successfulItems: 2, inputKeys: ["r1:a.jpg", "r1:b.jpg"], qcPassed: 1, qcChecked: 2, markedOk: 1, notRight: 0 });
    expect(scored.score).toBe(scoreOf(scored));
    expect(scored.score).toBeGreaterThan(c.score);
    await s.noteFeedback(["r2"], "notRight");
    // A refine that changes the code counts against it.
    await s.capture(resizeRoutine("r1", "Thumbnails", { version: 2, script: "// step 1\nvar d = openDocument(ctx.item.path);\nd.crop([0, 0, 10, 10]);\nd.trim(TrimType.TRANSPARENT);\n// step 2\nctx.output(\"out\", exportImage(ctx.join(ctx.workDir, \"a.jpg\"), \"jpg\"));" }), { request: "Crop instead", trialItems: 1, trialOk: 1, inputs: [] }, resizeRoutine("r1", "Thumbnails"));
    [scored] = (await s.list()).filter((x) => x.id === c.id);
    expect(scored.evidence).toMatchObject({ notRight: 1, refineTouches: 1 });
    expect(promotionDecision(scored).eligible).toBe(false);
  });

  it("generalizes a candidate into a block with one AI call, approves it into the library, and exports it without anything personal", async () => {
    blocks.usePersonalDir(path.join(dir, "helpers"));
    const { s, calls } = service();
    const [c] = await s.capture(resizeRoutine("r1", "Thumbnails"), { request: "Make thumbnails", trialItems: 2, trialOk: 2, inputs: ["/x/a.jpg"] });
    const g = await s.generalize(c.id);
    expect(calls()).toBe(1);
    expect(g.status).toBe("generalized");
    expect(g.draft!.def).toMatchObject({ id: "ps.resizeToWidth", version: 1, call: "resizeToWidth", set: "export", source: "promoted" });
    expect(g.draft!.lint).toEqual([]);
    const approved = await s.approve(c.id);
    expect(approved).toMatchObject({ status: "promoted", promoted: { id: "ps.resizeToWidth", version: 1 } });
    // Future creations see it: in the library, the index ("your block") and the scripts' library when pinned.
    expect(blocks.get("ps.resizeToWidth")).toMatchObject({ source: "promoted" });
    expect(blocks.indexText("photoshop", "resize to a width")).toContain("- resizeToWidth (ps.resizeToWidth v1, your block)");
    const pins = blocks.pinsFor("photoshop", { kind: "script", script: "resizeToWidth(img, 300);" });
    expect(pins).toEqual({ "ps.resizeToWidth": 1 });
    expect(photoshopLibrary(blocks.resolve("photoshop", pins).code)).toContain("function resizeToWidth(");
    // Export: the origin and the test on the designer's own file are left out.
    const file = path.join(dir, "exported.json");
    const res = await s.exportBuiltin(c.id, file);
    const [exported] = JSON.parse(await fs.readFile(file, "utf8")) as HelperDef[];
    expect(res.warnings).toEqual([]);
    expect(exported).toMatchObject({ id: "ps.resizeToWidth", source: "builtin" });
    expect(exported.origin).toBeUndefined();
    expect(exported.tests.map((t) => t.name)).toEqual(["resizes a generated photo"]);
  });

  it("won't approve a block that breaks the script rules or fails its tests", async () => {
    blocks.usePersonalDir(path.join(dir, "helpers"));
    const hiding = `{"call":"resizeQuietly","set":"export","summary":"x","signature":{"params":[],"returns":"x"},"sideEffects":[],"doc":"x","tests":[{"name":"t","inputs":{},"script":"resizeQuietly();","checks":[]}]}\n\`\`\`javascript\nfunction resizeQuietly() {\n  try { executeAction(1); } catch (e) {}\n}\n\`\`\``;
    const { s } = service({ answer: hiding });
    const [c] = await s.capture(resizeRoutine("r1", "T"), { request: "r", trialItems: 1, trialOk: 1, inputs: [] });
    const g = await s.generalize(c.id);
    expect(g.draft!.lint.join(" ")).toContain("empty catch");
    await expect(s.approve(c.id)).rejects.toThrow("can't be approved yet");
    const failing = service({ tests: [{ helper: "ps.resizeToWidth", version: 1, test: "t", passed: false, detail: "w is 600" }] });
    await failing.s.generalize(c.id);
    await expect(failing.s.approve(c.id)).rejects.toThrow("Its tests fail: t: w is 600");
  });

  it("promotes automatically only when the rule says so and the setting is on", async () => {
    blocks.usePersonalDir(path.join(dir, "helpers"));
    const off = service();
    await off.s.capture(resizeRoutine("r1", "A"), { request: "r", trialItems: 3, trialOk: 3, inputs: [] });
    await off.s.capture(resizeRoutine("r2", "B"), { request: "r", trialItems: 3, trialOk: 3, inputs: [] });
    let [c] = await off.s.list();
    expect(promotionDecision(c).reasons).toEqual([`0 successful items, needs ${PROMOTION_RULE.minItems}`]);
    await off.s.recordRun({ outputs: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, node: "n", itemKey: `k${i}`, status: "done" })) } as unknown as Run, { n: "r1" });
    [c] = await off.s.list();
    expect(promotionDecision(c).eligible).toBe(true);
    expect(off.calls()).toBe(0);
    expect(blocks.get("ps.resizeToWidth")).toBeUndefined();
    const on = service({ auto: true });
    await on.s.capture(resizeRoutine("r3", "C"), { request: "r", trialItems: 1, trialOk: 1, inputs: [] });
    expect(on.calls()).toBe(1);
    expect(blocks.get("ps.resizeToWidth")).toMatchObject({ source: "promoted" });
    expect((await on.s.list())[0].status).toBe("promoted");
  });

  it("captures a Figma action list as one unit, and offers a promoted block to the routine it came from", async () => {
    blocks.usePersonalDir(path.join(dir, "helpers"));
    const { s } = service();
    const actions = [
      { action: "duplicateNode", id: "card", node: "Card" },
      { action: "setText", node: "$card.#Title", text: "{{item.title}}" },
      { action: "exportNode", node: "$card", format: "PNG", output: "cards" },
    ];
    const figmaRoutine = routine({ id: "f1", appId: "figma", kind: "actions", actions: actions as never, script: "", steps: [{ id: "a", plainLanguage: "Fills a card" }, { id: "b", plainLanguage: "Exports it" }] });
    const [c] = await s.capture(figmaRoutine, { request: "Cards", trialItems: 1, trialOk: 1, inputs: [] });
    expect(c).toMatchObject({ app: "figma", occurrences: [{ step: "Fills a card / Exports it" }] });
    expect(JSON.parse(c.code)).toEqual(actions);
    // Only block uses: nothing to capture.
    expect(await s.capture(routine({ id: "f2", appId: "figma", kind: "actions", actions: [{ action: "block", name: "fillTemplate" }] as never, script: "" }), { request: "x", trialItems: 1, trialOk: 1, inputs: [] })).toEqual([]);
    // A promoted block made from r1's code is offered to r1 until it pins it.
    const [r] = await s.capture(resizeRoutine("r1", "Thumbnails"), { request: "r", trialItems: 1, trialOk: 1, inputs: [] });
    await s.generalize(r.id);
    await s.approve(r.id);
    expect(s.adoptable(resizeRoutine("r1", "Thumbnails"))).toEqual([{ id: "ps.resizeToWidth", call: "resizeToWidth", summary: "Resizes a document to a width in px, keeping proportions." }]);
    expect(s.adoptable(resizeRoutine("r1", "Thumbnails", { helpers: { "ps.resizeToWidth": 1 } }))).toEqual([]);
    expect(s.adoptable(resizeRoutine("r9", "Other"))).toEqual([]);
  });
});


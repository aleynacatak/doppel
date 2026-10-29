import { describe, expect, it } from "vitest";
import { type RoutineContract, type ValidatorApps, producedOutputs, validateRoutine } from "../electron/core/routines/contract";

const apps: ValidatorApps = {
  has: (id) => ["figma", "photoshop", "indesign"].includes(id),
  stageKind: (id) => (id === "figma" ? "actions" : "script"),
  lintScript: (_id, script) => (/=>/.test(script) ? ["arrow functions (=>) don't exist in ExtendScript"] : []),
};

function labels(): RoutineContract {
  return {
    appId: "figma",
    kind: "actions",
    script: "",
    inputs: [
      { key: "file", label: "Figma file", type: "document", required: true },
      { key: "products", label: "Products", type: "rows", required: true, columns: ["name", "ean"] },
      { key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] },
    ],
    settings: [{ key: "scale", label: "Scale", type: "number", required: false, default: 2 }],
    iterate: { input: "products" },
    outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
    actions: [
      { action: "duplicateNode", id: "label", node: "Label" },
      { action: "setText", node: "$label.#Name", text: "{{item.name}}" },
      { action: "setImageFill", node: "$label.#Photo", image: { file: "{{matched.cutouts}}" } },
      { action: "placeSvg", node: "$label.#Barcode", svg: { barcode: { type: "ean13", value: "{{item.ean}}" } } },
      { action: "exportNode", node: "$label", format: "PNG", scale: "{{settings.scale}}", fileName: "label-{{itemIndex}}", output: "labels" },
    ],
  };
}

function mockups(): RoutineContract {
  return {
    appId: "photoshop",
    kind: "script",
    inputs: [
      { key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] },
      { key: "mockup", label: "Mockup", type: "file", required: true, extensions: ["psd"] },
    ],
    settings: [],
    iterate: { input: "labels" },
    outputs: [{ key: "images", label: "Mockups", type: "fileList", required: true, extensions: ["jpg"] }],
    script: 'var doc = openDocument(params.mockup);\nreplaceSmartObject(findLayer("Label"), ctx.item.path);\nexportImage(ctx.join(ctx.workDir, ctx.item.stem + ".jpg"), "jpg", 85);',
  };
}

const codes = (r: ReturnType<typeof validateRoutine>) => r.errors.map((e) => e.code);

describe("routine contract validator", () => {
  it("accepts single-app routines whose body uses only what they declare", () => {
    expect(validateRoutine(labels(), apps, { values: ["Organic honey 500 g", "4006381333931"], columns: { products: ["name", "ean"] } }).errors).toEqual([]);
    expect(validateRoutine(mockups(), apps).errors).toEqual([]);
  });

  it("rejects placeholders that point at undeclared inputs or settings, with their location", () => {
    const r = labels();
    r.actions![1].text = "{{item.title}}";
    r.actions![0].node = "{{inputs.template}}";
    r.actions![4].scale = "{{settings.quality}}";
    r.actions![2].image = { file: "{{matched.photos}}" };
    const res = validateRoutine(r, apps);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "actions[1].text", code: "unresolved-placeholder" }),
        expect.objectContaining({ path: "actions[0].node", code: "unresolved-placeholder" }),
        expect.objectContaining({ path: "actions[4].scale", code: "unresolved-placeholder" }),
        expect.objectContaining({ path: "actions[2].image.file", code: "unresolved-placeholder" }),
      ]),
    );
    expect(res.errors.find((e) => e.path === "actions[1].text")!.message).toContain('no "title" column');
    expect(res.errors.find((e) => e.path === "actions[0].node")!.message).toContain('there is no input "template"');
  });

  it("names the replacement for older placeholders", () => {
    const r = labels();
    r.actions![1].text = "{{params.name}}";
    r.actions![2].image = { files: "{{stage.s1.outputs.files}}", name: "{{item.name}}" };
    const messages = validateRoutine(r, apps).errors.map((e) => e.message);
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining("use {{inputs.name}} for an input or {{settings.name}}"), expect.stringContaining("through one of its inputs")]));
  });

  it("allows item and matched placeholders only in routines that iterate", () => {
    const r = labels();
    delete r.iterate;
    const res = validateRoutine(r, apps);
    expect(res.errors.some((e) => e.message.includes("only exists in a routine that iterate"))).toBe(true);
    const s = mockups();
    delete s.iterate;
    expect(validateRoutine(s, apps).errors.map((e) => e.message)).toContain('ctx.item only exists in a routine that iterates (set "iterate").');
  });

  it("checks scripts use declared inputs and settings", () => {
    const s = mockups();
    s.script = s.script.replace("params.mockup", "params.template");
    expect(validateRoutine(s, apps).errors[0]).toMatchObject({ path: "script", code: "unresolved-placeholder", message: expect.stringContaining("params.template") });
  });

  it("requires every declared output to be produced, and every produced one declared", () => {
    const r = labels();
    r.outputs.push({ key: "previews", label: "Previews", type: "fileList", required: true });
    r.actions![4].output = "pngs";
    const res = validateRoutine(r, apps);
    expect(res.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('Output "labels" is never produced'), expect.stringContaining('Output "previews" is never produced'), expect.stringContaining('produces "pngs"')]),
    );
    // Photoshop: exportImage fills the first file output; other outputs need ctx.output.
    expect([...producedOutputs(mockups())]).toEqual(["images"]);
    const s = mockups();
    s.outputs.push({ key: "colors", label: "Colors", type: "rows", required: true });
    expect(validateRoutine(s, apps).errors[0].message).toBe('Output "colors" is never produced. Call ctx.output("colors", value) for each value.');
  });

  it("keeps a routine to one app", () => {
    expect(codes(validateRoutine(labels(), apps, undefined, "photoshop"))).toContain("one-app");
    const s = mockups();
    s.script += '\nvar bt = new BridgeTalk(); bt.target = "indesign";';
    expect(codes(validateRoutine(s, apps))).toContain("one-app");
    expect(codes(validateRoutine({ ...labels(), appId: "illustrator" }, apps))).toEqual(["unknown-app"]);
  });

  it("checks the contract: keys, types, iteration and documents", () => {
    const r = labels();
    r.inputs.push({ key: "scale", label: "Scale again", type: "number", required: true });
    r.inputs.push({ key: "doc2", label: "Another file", type: "document", required: true });
    r.inputs.push({ key: "bad key", label: "Bad", type: "image" as never, required: true });
    r.settings.push({ key: "folder", label: "Folder", type: "folder" as never, required: true });
    r.iterate = { input: "file" };
    const res = validateRoutine(r, apps);
    expect(codes(res)).toEqual(expect.arrayContaining(["duplicate-id", "contract", "schema"]));
    expect(res.errors.find((e) => e.path === "iterate.input")!.message).toBe('A routine iterates over a rows or fileList input; "file" is document.');
    expect(res.errors.find((e) => e.path === "settings[1].type")!.message).toContain("Files, folders and data are inputs");
  });

  it("rejects absolute paths, literal sample data, unknown actions and lint problems", () => {
    const r = labels();
    r.actions![1].text = "Organic honey 500 g";
    r.actions!.push({ action: "explode", node: "x" });
    const s = mockups();
    s.script = s.script.replace("params.mockup", '"/Users/ana/Mockup.psd"') + "\nvar f = () => 1;";
    const res = validateRoutine(r, apps, { values: ["Organic honey 500 g", "Name"], allowed: ["Label", "Name"] });
    expect(codes(res)).toEqual(expect.arrayContaining(["sample-data", "schema"]));
    expect(res.errors.filter((e) => e.code === "sample-data")).toHaveLength(1);
    expect(res.errors.find((e) => e.code === "schema")!.path).toBe("actions[5].action");
    expect(codes(validateRoutine(s, apps))).toEqual(expect.arrayContaining(["absolute-path", "lint"]));
  });
});

import { describe, expect, it } from "vitest";
import { validateRoutine, type ValidatorApps } from "../electron/core/stages/validator";
import type { ParamDef, Stage } from "../electron/core/types";

const apps: ValidatorApps = {
  has: (id) => ["figma", "photoshop", "indesign"].includes(id),
  stageKind: (id) => (id === "figma" ? "actions" : "script"),
  lintScript: (_id, script) => (/=>/.test(script) ? ["arrow functions (=>) don't exist in ExtendScript"] : []),
};

const params: ParamDef[] = [
  { key: "products", label: "Products", type: "dataFile", required: true },
  { key: "mockup", label: "Mockup", type: "file", required: true, extensions: ["psd"] },
  { key: "out", label: "Output folder", type: "folder", required: true, role: "output" },
];

function stages(): Stage[] {
  return [
    {
      id: "s1",
      name: "Labels",
      appId: "figma",
      kind: "actions",
      repeat: { over: "{{params.products.rows}}" },
      inputs: ["{{params.products}}"],
      outputs: [{ key: "files", type: "fileList" }],
      body: {
        actions: [
          { action: "duplicateNode", id: "label", node: "Label" },
          { action: "setText", node: "$label.#Name", text: "{{item.name}}" },
          { action: "placeSvg", node: "$label.#Barcode", svg: { barcode: { type: "ean13", value: "{{item.ean}}" } } },
          { action: "exportNode", node: "$label", format: "PNG", fileName: "label-{{itemIndex}}", output: "files" },
        ],
      },
    },
    {
      id: "s2",
      name: "Mockups",
      appId: "photoshop",
      kind: "script",
      document: "none",
      repeat: { over: "{{stage.s1.outputs.files}}" },
      inputs: ["{{params.mockup}}", "{{params.out}}", "{{stage.s1.outputs.files}}"],
      outputs: [{ key: "images", type: "fileList" }],
      body: 'var doc = openDocument(params.mockup);\nreplaceSmartObject(findLayer("Label"), ctx.item.path);\nexportImage(ctx.join(params.out, ctx.item.stem + ".jpg"), "jpg", 85);',
    },
  ];
}

const codes = (r: ReturnType<typeof validateRoutine>) => r.errors.map((e) => e.code);

describe("routine validator", () => {
  it("accepts a valid two-stage Figma → Photoshop routine", () => {
    const res = validateRoutine({ params, stages: stages() }, apps, { values: ["Organic honey 500 g", "4006381333931"], columns: { products: ["name", "ean"] } });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("finds placeholders that don't resolve, with their location", () => {
    const s = stages();
    (s[0].body as any).actions[1].text = "{{item.title}}";
    (s[0].body as any).actions[0].node = "{{params.template}}";
    const res = validateRoutine({ params, stages: s }, apps, { values: [], columns: { products: ["name", "ean"] } });
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "stages[0].body.actions[1].text", code: "unresolved-placeholder" }),
        expect.objectContaining({ path: "stages[0].body.actions[0].node", code: "unresolved-placeholder" }),
      ]),
    );
    expect(res.errors.find((e) => e.path.endsWith("actions[1].text"))!.message).toContain('no "title" column');
  });

  it("only lets a stage use outputs of earlier stages", () => {
    const s = stages().reverse();
    const res = validateRoutine({ params, stages: s }, apps);
    expect(codes(res)).toContain("stage-order");
  });

  it("allows item placeholders only in repeated stages", () => {
    const s = stages();
    delete s[0].repeat;
    const res = validateRoutine({ params, stages: s }, apps);
    expect(res.errors.some((e) => e.message.includes("only available in a stage that repeats"))).toBe(true);
  });

  it("rejects absolute paths and literal sample data", () => {
    const s = stages();
    (s[0].body as any).actions[1].text = "Organic honey 500 g";
    s[1].body = String(s[1].body).replace("params.mockup", '"/Users/ana/Mockup.psd"');
    const res = validateRoutine({ params, stages: s }, apps, { values: ["Organic honey 500 g", "Name"], allowed: ["Label", "Name"] });
    expect(codes(res)).toEqual(expect.arrayContaining(["sample-data", "absolute-path"]));
    // Layer names that also occur in the data aren't flagged.
    expect(res.errors.filter((e) => e.code === "sample-data")).toHaveLength(1);
  });

  it("checks action schemas, scripts, apps and ids", () => {
    const s = stages();
    (s[0].body as any).actions.push({ action: "explode", node: "x" });
    s[1].body = "var f = () => 1;";
    s.push({ ...s[1], id: "s2" }, { ...s[1], id: "s4", appId: "illustrator" });
    const res = validateRoutine({ params, stages: s }, apps);
    expect(codes(res)).toEqual(expect.arrayContaining(["schema", "lint", "duplicate-id", "unknown-app"]));
    expect(res.errors.find((e) => e.code === "schema")!.path).toBe("stages[0].body.actions[4].action");
  });

  it("requires repeat.over to be a list placeholder", () => {
    const s = stages();
    s[0].repeat = { over: "{{params.mockup}}" };
    expect(validateRoutine({ params, stages: s }, apps).errors[0]).toMatchObject({ path: "stages[0].repeat.over" });
  });
});

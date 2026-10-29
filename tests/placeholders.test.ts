import { describe, expect, it } from "vitest";
import {
  expandValue,
  fileItem,
  findPlaceholders,
  onlyPlaceholder,
  PlaceholderError,
  plain,
  resolveExpr,
  rewritePlaceholders,
} from "../electron/core/routines/placeholders";

const scope = {
  inputs: {
    data: { __value: "products.csv", name: "products.csv", rows: [{ sku: "A1", price: "4.20" }], columns: ["sku", "price"] },
    cutouts: { __value: ["/run/s1/a.png", "/run/s1/b.png"], files: [fileItem("/run/s1/a.png"), fileItem("/run/s1/b.png")], count: 2 },
  },
  settings: { columns: 3, pattern: "{sku}" },
  item: { sku: "B2", name: "Jam", qty: 2 },
  itemIndex: 1,
  matched: { cutouts: fileItem("/run/s1/b.png") },
};

describe("placeholders", () => {
  it("keeps the type of a value that is exactly one placeholder", () => {
    expect(expandValue("{{settings.columns}}", scope)).toBe(3);
    expect(expandValue("{{inputs.data.rows}}", scope)).toEqual([{ sku: "A1", price: "4.20" }]);
    expect(expandValue("{{inputs.cutouts}}", scope)).toEqual(["/run/s1/a.png", "/run/s1/b.png"]);
    expect(expandValue("{{itemIndex}}", scope)).toBe(2);
  });

  it("turns placeholders inside text into text", () => {
    expect(expandValue("{{item.qty}} × {{item.name}}", scope)).toBe("2 × Jam");
    expect(expandValue("From {{inputs.data}}", scope)).toBe("From products.csv");
    expect(expandValue("{{inputs.cutouts}}!", scope)).toBe("/run/s1/a.png, /run/s1/b.png!");
  });

  it("gives the matched partner of the current item, as a path with parts", () => {
    expect(expandValue("{{matched.cutouts}}", scope)).toBe("/run/s1/b.png");
    expect(expandValue("{{matched.cutouts.stem}}", scope)).toBe("b");
    expect(() => expandValue("{{matched.photos}}", scope)).toThrow(PlaceholderError);
  });

  it("expands nested action lists and leaves other values alone", () => {
    const body = { actions: [{ action: "setText", node: "$dup.#Title", text: "{{item.name}}" }, { action: "arrangeInGrid", nodes: "$dup", columns: "{{settings.columns}}", gap: 8 }] };
    expect(expandValue(body, scope)).toEqual({
      actions: [
        { action: "setText", node: "$dup.#Title", text: "Jam" },
        { action: "arrangeInGrid", nodes: "$dup", columns: 3, gap: 8 },
      ],
    });
  });

  it("composite inputs stand for their value", () => {
    expect(resolveExpr("inputs.data", scope)).toEqual({ found: true, value: "products.csv" });
    expect(resolveExpr("inputs.data.columns", scope)).toEqual({ found: true, value: ["sku", "price"] });
    expect(resolveExpr("inputs.cutouts.count", scope)).toEqual({ found: true, value: 2 });
  });

  it("throws for a placeholder without a value, and knows no older names", () => {
    expect(() => expandValue("{{item.color}}", scope)).toThrow(PlaceholderError);
    expect(() => expandValue("{{params.columns}}", scope)).toThrow("{{params.columns}} has no value here");
    expect(() => expandValue("{{item.name}}", { ...scope, item: undefined })).toThrow(PlaceholderError);
  });

  it("finds placeholders with their location", () => {
    expect(findPlaceholders({ actions: [{ text: "{{item.a}} {{settings.b}}" }] })).toEqual([
      { path: "actions[0].text", expr: "item.a" },
      { path: "actions[0].text", expr: "settings.b" },
    ]);
    expect(onlyPlaceholder(" {{inputs.x}}")).toBeNull();
    expect(onlyPlaceholder("{{ inputs.x }}")).toBe("inputs.x");
  });

  it("rewrites placeholders (migrating older routines)", () => {
    const out = rewritePlaceholders([{ text: "{{params.title}} – {{ stage.s1.outputs.files }}" }], (e) => e.replace("params.", "inputs.").replace("stage.s1.outputs.files", "inputs.s1Files"));
    expect(out).toEqual([{ text: "{{inputs.title}} – {{ inputs.s1Files }}" }]);
  });

  it("describes files as items", () => {
    const f = fileItem("/x/Label 01.PNG");
    expect(plain(f)).toEqual({ path: "/x/Label 01.PNG", name: "Label 01.PNG", stem: "Label 01", ext: "png" });
    expect(expandValue("{{item}}", { inputs: {}, settings: {}, item: f })).toBe("/x/Label 01.PNG");
  });
});

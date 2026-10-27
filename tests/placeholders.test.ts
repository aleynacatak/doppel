import { describe, expect, it } from "vitest";
import { expandValue, fileItem, findPlaceholders, onlyPlaceholder, PlaceholderError, plain, resolveExpr } from "../electron/core/stages/placeholders";

const scope = {
  params: {
    columns: 3,
    data: { __value: "/data/products.csv", name: "products.csv", rows: [{ sku: "A1", price: "4.20" }], columns: ["sku", "price"] },
    out: { __value: "/out", name: "out", files: [] },
  },
  item: { sku: "B2", name: "Jam", qty: 2 },
  itemIndex: 1,
  stages: { s1: { outputs: { files: ["/run/s1/a.png", "/run/s1/b.png"] } } },
};

describe("placeholders", () => {
  it("keeps the type of a value that is exactly one placeholder", () => {
    expect(expandValue("{{params.columns}}", scope)).toBe(3);
    expect(expandValue("{{params.data.rows}}", scope)).toEqual([{ sku: "A1", price: "4.20" }]);
    expect(expandValue("{{stage.s1.outputs.files}}", scope)).toHaveLength(2);
    expect(expandValue("{{itemIndex}}", scope)).toBe(2);
  });

  it("turns placeholders inside text into text", () => {
    expect(expandValue("{{item.qty}} × {{item.name}}", scope)).toBe("2 × Jam");
    expect(expandValue("Saved to {{params.out}}", scope)).toBe("Saved to /out");
    expect(expandValue("{{stage.s1.outputs.files}}!", scope)).toBe("/run/s1/a.png, /run/s1/b.png!");
  });

  it("expands nested action lists and leaves other values alone", () => {
    const body = { actions: [{ action: "setText", node: "$dup.#Title", text: "{{item.name}}" }, { action: "arrangeInGrid", nodes: "$dup", columns: "{{params.columns}}", gap: 8 }] };
    expect(expandValue(body, scope)).toEqual({
      actions: [
        { action: "setText", node: "$dup.#Title", text: "Jam" },
        { action: "arrangeInGrid", nodes: "$dup", columns: 3, gap: 8 },
      ],
    });
  });

  it("composite params stand for their path", () => {
    expect(resolveExpr("params.data", scope)).toEqual({ found: true, value: "/data/products.csv" });
    expect(resolveExpr("params.data.name", scope)).toEqual({ found: true, value: "products.csv" });
  });

  it("throws for a placeholder without a value", () => {
    expect(() => expandValue("{{item.color}}", scope)).toThrow(PlaceholderError);
    expect(() => expandValue("{{stage.s9.outputs.files}}", scope)).toThrow("{{stage.s9.outputs.files}} has no value here");
    expect(() => expandValue("{{item.name}}", { ...scope, item: undefined })).toThrow(PlaceholderError);
  });

  it("finds placeholders with their location", () => {
    expect(findPlaceholders({ actions: [{ text: "{{item.a}} {{params.b}}" }] })).toEqual([
      { path: "actions[0].text", expr: "item.a" },
      { path: "actions[0].text", expr: "params.b" },
    ]);
    expect(onlyPlaceholder(" {{params.x}}")).toBeNull();
    expect(onlyPlaceholder("{{ params.x }}")).toBe("params.x");
  });

  it("describes files as items", () => {
    const f = fileItem("/x/Label 01.PNG");
    expect(plain(f)).toEqual({ path: "/x/Label 01.PNG", name: "Label 01.PNG", stem: "Label 01", ext: "png" });
    expect(expandValue("{{item}}", { params: {}, item: f, stages: {} })).toBe("/x/Label 01.PNG");
  });
});

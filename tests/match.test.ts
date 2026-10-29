import { describe, expect, it } from "vitest";
import { pairItems, previewPairs, singular, suggestMatch } from "../electron/core/flows/match";
import type { ListItem } from "../electron/core/flows/values";

const rows: ListItem[] = [
  { key: "row-1", label: "Row 1 · JAD-001", value: { sku: "JAD-001", image: "apricot.jpg" } },
  { key: "row-2", label: "Row 2 · JAD-002", value: { sku: "JAD-002", image: "Fig Jam.JPG" } },
  { key: "row-4", label: "Row 4 · JAD-004", value: { sku: "JAD-004", image: "strawberry-vanilla.png" } },
  { key: "row-5", label: "Row 5 · JAD-005", value: { sku: "JAD-005", image: "" } },
];
const cutouts: ListItem[] = [
  { key: "row-1", label: "apricot.png", value: "/run/cut/apricot.png" },
  { key: "row-2", label: "fig jam.png", value: "/run/cut/fig jam.png" },
];

describe("match rules", () => {
  it("pairs a row with the file named in a column, ignoring the extension and case", () => {
    const pairs = pairItems({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: true }, { type: "rows", items: rows }, { type: "fileList", items: cutouts, label: "Cutouts" });
    expect(pairs.get("row-1")!.matched!.value).toBe("/run/cut/apricot.png");
    expect(pairs.get("row-2")!.matched!.value).toBe("/run/cut/fig jam.png");
    expect(pairs.get("row-4")).toEqual({ matched: null, problem: "No cutout for Row 4 · JAD-004: strawberry-vanilla.png not found." });
    expect(pairs.get("row-5")!.problem).toBe('No cutout for Row 5 · JAD-005: its "image" is empty.');
    // With the extension it has to match exactly.
    const exact = pairItems({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: false }, { type: "rows", items: rows }, { type: "fileList", items: cutouts, label: "Cutouts" });
    expect(exact.get("row-1")!.matched).toBeNull();
  });

  it("pairs files with rows the other way round too", () => {
    const pairs = pairItems({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: true }, { type: "fileList", items: cutouts }, { type: "rows", items: rows, label: "Product data" });
    expect((pairs.get("row-2")!.matched!.value as { sku: string }).sku).toBe("JAD-002");
  });

  it("pairs by the original item when both lists came from the same rows, else by position", () => {
    const byKey = pairItems({ by: "index" }, { type: "rows", items: rows }, { type: "fileList", items: cutouts, label: "Cutouts" });
    expect(byKey.get("row-2")!.matched!.label).toBe("fig jam.png");
    expect(byKey.get("row-4")!.problem).toBe("No cutout for Row 4 · JAD-004: it wasn't made, or failed earlier.");
    const files: ListItem[] = [
      { key: "file-a.png", label: "a.png", value: "/a.png" },
      { key: "file-b.png", label: "b.png", value: "/b.png" },
    ];
    const byPosition = pairItems({ by: "index" }, { type: "rows", items: rows }, { type: "fileList", items: files, label: "Photos" });
    expect(byPosition.get("row-2")!.matched!.label).toBe("b.png");
    expect(byPosition.get("row-4")!.problem).toBe("No photo for Row 4 · JAD-004: there are only 2.");
  });

  it("pairs rows with rows by equal columns", () => {
    const prices: ListItem[] = [{ key: "p-1", label: "Price 1", value: { code: "jad-002", price: "4.20" } }];
    const pairs = pairItems({ by: "columnEquals", leftColumn: "sku", rightColumn: "code" }, { type: "rows", items: rows }, { type: "rows", items: prices, label: "Prices" });
    expect(pairs.get("row-2")!.matched!.label).toBe("Price 1");
    expect(pairs.get("row-1")!.problem).toBe("No price for Row 1 · JAD-001: no row with code “JAD-001”.");
  });

  it("refuses rules that don't fit the two lists", () => {
    const pairs = pairItems({ by: "columnEquals", leftColumn: "a", rightColumn: "b" }, { type: "rows", items: rows }, { type: "fileList", items: cutouts, label: "Cutouts" });
    expect(pairs.get("row-1")!.problem).toBe("“Column = column” pairs data rows with data rows.");
  });

  it("suggests the column that holds the file names", () => {
    const rule = suggestMatch({ type: "rows", items: rows, columns: ["sku", "image"] }, { type: "fileList", items: cutouts });
    expect(rule).toEqual({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: true });
    // Without values yet, the column's name decides.
    expect(suggestMatch({ type: "rows", items: [], columns: ["title", "photo"] }, { type: "fileList", items: [] })).toMatchObject({ column: "photo" });
    expect(suggestMatch({ type: "rows", items: [], columns: ["sku", "title"] }, { type: "rows", items: [], columns: ["sku", "price"] })).toEqual({ by: "columnEquals", leftColumn: "sku", rightColumn: "sku" });
    expect(suggestMatch({ type: "fileList", items: [] }, { type: "fileList", items: [] })).toEqual({ by: "index" });
  });

  it("previews the first pairs with what's unmatched", () => {
    const preview = previewPairs({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: true }, { type: "rows", items: rows }, { type: "fileList", items: cutouts, label: "Cutouts" }, 3);
    expect(preview.pairs).toHaveLength(3);
    expect(preview).toMatchObject({ total: 4, unmatched: 2 });
    expect(preview.pairs[2]).toEqual({ item: "Row 4 · JAD-004", match: null, problem: "No cutout for Row 4 · JAD-004: strawberry-vanilla.png not found." });
    expect(singular("Product images")).toBe("product image");
  });
});

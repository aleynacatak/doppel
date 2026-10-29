import { describe, expect, it } from "vitest";
import { nameKey, pairItems, partnersByName, previewPairs, singular, suggestMatch } from "../electron/core/flows/match";
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
    expect(rule).toEqual({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: true, loose: true });
    // Without values yet, the column's name decides.
    expect(suggestMatch({ type: "rows", items: [], columns: ["title", "photo"] }, { type: "fileList", items: [] })).toMatchObject({ column: "photo" });
    expect(suggestMatch({ type: "rows", items: [], columns: ["sku", "title"] }, { type: "rows", items: [], columns: ["sku", "price"] })).toEqual({ by: "columnEquals", leftColumn: "sku", rightColumn: "sku" });
    expect(suggestMatch({ type: "fileList", items: [] }, { type: "fileList", items: [] })).toEqual({ by: "index" });
  });

  it("matches names the way people write them, and a name inside another only when one fits", () => {
    expect(nameKey("Strawberry_Vanilla")).toBe(nameKey("strawberry-vanilla"));
    expect(nameKey("Çilek Reçeli")).toBe("cilek receli");
    expect(nameKey("ISPARTA GÜLÜ")).toBe(nameKey("isparta-gulu"));
    const flavors: ListItem[] = [
      { key: "r1", label: "Row 1 · Strawberry Vanilla", value: { flavor: "Strawberry Vanilla" } },
      { key: "r2", label: "Row 2 · Mango", value: { flavor: "Mango" } },
      { key: "r3", label: "Row 3 · Vanilla", value: { flavor: "Vanilla" } },
      { key: "r4", label: "Row 4 · Fig", value: { flavor: "Fig" } },
    ];
    const images: ListItem[] = [
      { key: "f1", label: "Strawberry_Vanilla.PNG", value: "/i/Strawberry_Vanilla.PNG" },
      { key: "f2", label: "mango-label-v2.jpg", value: "/i/mango-label-v2.jpg" },
      { key: "f3", label: "VANILLA.jpeg", value: "/i/VANILLA.jpeg" },
    ];
    const pairs = pairItems({ by: "fileNameEqualsColumn", column: "flavor", ignoreExtension: true, loose: true }, { type: "rows", items: flavors }, { type: "fileList", items: images, label: "Flavor images" });
    expect([...pairs.values()].map((p) => p.matched?.label ?? p.problem)).toEqual([
      "Strawberry_Vanilla.PNG",
      "mango-label-v2.jpg",
      // "Vanilla" is the exact name of VANILLA.jpeg (Strawberry Vanilla took its own file).
      "VANILLA.jpeg",
      "No flavor image for Row 4 · Fig: Fig not found.",
    ]);
    // Without "loose", names must be the same apart from case.
    const strict = pairItems({ by: "fileNameEqualsColumn", column: "flavor", ignoreExtension: true }, { type: "rows", items: flavors }, { type: "fileList", items: images, label: "Flavor images" });
    expect(strict.get("r1")!.matched).toBeNull();
    // Two files contain "Berry": neither is picked.
    expect(partnersByName(["Berry"], [{ name: "blue berry", item: { n: 1 } }, { name: "berry mix", item: { n: 2 } }], true)).toEqual([null]);
  });

  it("matches names written as one word, in camel case, or with a version or copy suffix, only when one fits", () => {
    const rows = ["Strawberry Vanilla", "Fig & Walnut", "Apricot Ginger", "Blackberry Lavender", "Salted Caramel Pear", "Mango", "Peach"];
    const files = ["strawberryvanilla.png", "FigWalnut.jpg", "apricot_ginger_v2_final.PNG", "Blackberry-Lavender (1).jpeg", "salted-caramel-pear-label.png", "mango.png", "mango.jpg", "peach-1.png", "peach-2.png"];
    const found = partnersByName(
      rows,
      files.map((f) => ({ name: f.replace(/\.[^.]+$/, ""), item: { f } })),
      true,
    );
    expect(found.map((x) => x?.f ?? null)).toEqual([
      "strawberryvanilla.png",
      "FigWalnut.jpg",
      "apricot_ginger_v2_final.PNG",
      "Blackberry-Lavender (1).jpeg",
      "salted-caramel-pear-label.png",
      // The same name twice (a PNG and a JPG): the first.
      "mango.png",
      // Two files fit as well as each other: Doppl doesn't guess.
      null,
    ]);
    // Without "loose", only the same name.
    expect(partnersByName(["Strawberry Vanilla"], [{ name: "strawberryvanilla", item: { f: 1 } }], false)).toEqual([null]);
  });

  it("pairs files with files of a similar name, and lets items without a partner run when optional", () => {
    const photos: ListItem[] = [
      { key: "p1", label: "Jar 01.jpg", value: "/p/Jar 01.jpg" },
      { key: "p2", label: "jar-02.jpg", value: "/p/jar-02.jpg" },
    ];
    const masks: ListItem[] = [{ key: "m1", label: "jar_01_mask.png", value: "/m/jar_01_mask.png" }];
    const pairs = pairItems({ by: "sameFileName" }, { type: "fileList", items: photos }, { type: "fileList", items: masks, label: "Masks" });
    expect(pairs.get("p1")!.matched!.label).toBe("jar_01_mask.png");
    expect(pairs.get("p2")!.problem).toBe("No mask for jar-02.jpg: no file with a name like it.");
    expect(pairItems({ by: "sameFileName" }, { type: "rows", items: rows }, { type: "fileList", items: masks, label: "Masks" }).get("row-1")!.problem).toBe("“Same file name” pairs files with files.");
  });

  it("previews the first pairs with what's unmatched", () => {
    const preview = previewPairs({ by: "fileNameEqualsColumn", column: "image", ignoreExtension: true }, { type: "rows", items: rows }, { type: "fileList", items: cutouts, label: "Cutouts" }, 3);
    expect(preview.pairs).toHaveLength(3);
    expect(preview).toMatchObject({ total: 4, unmatched: 2 });
    expect(preview.pairs[2]).toEqual({ item: "Row 4 · JAD-004", match: null, problem: "No cutout for Row 4 · JAD-004: strawberry-vanilla.png not found." });
    expect(singular("Product images")).toBe("product image");
  });
});

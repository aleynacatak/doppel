import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  analyzeInputs,
  decidedRule,
  inputFacts,
  type InputSource,
  missingQuestion,
  nameFit,
  pairingQuestion,
  readInputSources,
  relate,
  sourceOf,
} from "../electron/core/inputs/inputCheck";
import { fileList } from "../electron/core/flows/values";

const rows = (id: string, column: string, values: string[], more: Record<string, string> = {}): InputSource => ({
  id,
  label: path.basename(id),
  kind: "rows",
  columns: [column, ...Object.keys(more)],
  items: values.map((v, i) => ({ key: `row-${i + 1}`, label: `Row ${i + 1} · ${v}`, value: { [column]: v, ...more } })),
});
const files = (id: string, names: string[]): InputSource => ({
  id,
  label: path.basename(id),
  kind: "files",
  items: names.map((n) => ({ key: `${id}/${n}`, label: n, value: `${id}/${n}` })),
  formats: names.reduce<Record<string, number>>((o, n) => {
    const e = n.split(".").pop()!.toLowerCase().replace("jpeg", "jpg");
    return { ...o, [e]: (o[e] ?? 0) + 1 };
  }, {}),
});

describe("input check", () => {
  it("asks how rows find their images when names don't all match, the best guess first", () => {
    const products = rows("/t/products.csv", "Flavor", ["Strawberry Vanilla", "Mango", "Blueberry", "Fig"], { Weight: "250g" });
    const images = files("/t/flavor pics", ["Strawberry_Vanilla.PNG", "mango.jpg", "BLUEBERRY.jpeg", "old-test.png"]);
    const r = relate(products, images);
    expect(r.sure).toBe(false);
    expect(r.best).toMatchObject({ id: "column:Flavor", matched: 3, missing: ["Fig"], unused: ["old-test.png"] });
    const q = pairingQuestion(r);
    expect(q.text).toBe("How should each row in products.csv find its image in flavor pics?");
    expect(q.detail).toBe("4 rows · 4 images (PNG, JPG)");
    expect(q.options.map((o) => o.label)).toEqual(["By “Flavor”", "In order: row 1 → the first image", "They aren't related"]);
    expect(q.options[0].detail).toBe("Strawberry Vanilla → Strawberry_Vanilla.PNG · Mango → mango.jpg · Blueberry → BLUEBERRY.jpeg · 3 of 4 have one");
    const m = missingQuestion(r, r.best);
    expect(m.text).toBe("1 of 4 rows has no image in flavor pics: Fig. What should Doppl do with it?");
    expect(m.options.map((o) => o.label)).toEqual(["Skip it", "Make it without the image", "Stop so I can add the missing images"]);
    expect(m.options.map((o) => o.id)).toEqual(["skip", "without", "stop"]);

    const decisions = [{ mainId: products.id, otherId: images.id, option: r.best, missing: "without" as const, confirmed: true }];
    expect(decidedRule(decisions, products.id, images.id)).toEqual({ by: "fileNameEqualsColumn", column: "Flavor", ignoreExtension: true, loose: true, optional: true });
    const facts = inputFacts(analyzeInputs([products, images]), decisions);
    expect(facts[0]).toBe("products.csv: 4 rows (columns: Flavor, Weight).");
    expect(facts[1]).toBe('flavor pics: 4 images (2 PNG, 2 JPG). Accept every one of these formats in the input\'s "extensions".');
    expect(facts[2]).toContain('Each row of products.csv pairs with its image in flavor pics by its "Flavor" value');
    expect(facts[2]).toContain("3 of 4 have one. The designer chose this.");
    expect(facts[3]).toBe("Fig has no image: make it without it (ctx.matched.<input> is missing there: leave that part out or empty, don't fail).");
    expect(facts[4]).toBe("Not used by any row (left out): old-test.png.");
  });

  it("doesn't ask when every row finds its image, or when there's one file for all", () => {
    const products = rows("/t/p.csv", "name", ["Apricot", "Fig"]);
    expect(relate(products, files("/t/img", ["apricot.png", "FIG.jpg"]))).toMatchObject({ sure: true, best: { kind: "name", matched: 2 } });
    const logo = relate(products, files("attached", ["logo.png"]));
    expect(logo).toMatchObject({ sure: true, best: { kind: "same", label: "The same image for every row: logo.png" } });
    expect(inputFacts(analyzeInputs([products, files("attached", ["logo.png"])]), [{ mainId: products.id, otherId: "attached", option: logo.best, confirmed: false }])).toContain(
      'logo.png is one file used for every row: make it a "file" input, not a list. Doppl is sure of this.',
    );
  });

  it("pairs files with files by name, and offers the order when nothing matches", () => {
    const photos = files("/t/photos", ["jar-01.jpg", "jar-02.jpg", "jar-03.jpg"]);
    expect(relate(photos, files("/t/masks", ["jar_01_mask.png", "jar_02_mask.png", "jar_03_mask.png"]))).toMatchObject({ sure: true, best: { id: "name", matched: 3 } });
    const unrelated = relate(photos, files("/t/other", ["a.png", "b.png", "c.png"]));
    expect(unrelated).toMatchObject({ sure: false, best: { id: "order", matched: 3 } });
    expect(pairingQuestion(unrelated).text).toBe("How should each image in photos find its image in other?");
  });

  it("makes the biggest data file the main input", () => {
    const a = analyzeInputs([files("/t/img", ["x.png"]), rows("/t/small.csv", "k", ["1"]), rows("/t/big.csv", "k", ["1", "2", "3"])]);
    expect(a.relations.map((r) => [r.main.label, r.other.label])).toEqual([
      ["big.csv", "img"],
      ["big.csv", "small.csv"],
    ]);
  });

  describe("reading what was attached", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-inputs-"));
    });

    it("reads data files as rows and each folder's other files as a list, and finds where a sample came from", async () => {
      await fs.writeFile(path.join(dir, "products.csv"), "Flavor,Price\nMango,4\nFig,5\n");
      await fs.mkdir(path.join(dir, "Flavor Pics"));
      for (const f of ["mango.PNG", "fig.jpeg", ".DS_Store"]) await fs.writeFile(path.join(dir, "Flavor Pics", f), "x");
      await fs.writeFile(path.join(dir, "logo.png"), "x");
      const sources = await readInputSources({ references: [path.join(dir, "products.csv"), path.join(dir, "logo.png")], folders: [path.join(dir, "Flavor Pics")] });
      expect(sources.map((s) => [s.label, s.kind, s.items.length, s.formats ?? s.columns])).toEqual([
        ["products.csv", "rows", 2, ["Flavor", "Price"]],
        ["logo.png", "files", 1, { png: 1 }],
        ["Flavor Pics", "files", 2, { jpg: 1, png: 1 }],
      ]);
      const pics = sources[2];
      expect(sourceOf(sources, fileList(pics.items.map((i) => String(i.value))) as never)).toBe(pics);
      expect(sourceOf(sources, { kind: "list", type: "rows", path: path.join(dir, "products.csv"), items: [] })).toBe(sources[0]);
      expect(nameFit({ key: "flavorImages", label: "Flavor images" }, pics)).toBe(1);
      expect(nameFit({ key: "logo", label: "Logo" }, pics)).toBe(0);
    });
  });
});

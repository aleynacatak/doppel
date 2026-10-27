import { describe, expect, it } from "vitest";
import { CancelledInFigma, type Host, Interpreter, mapIds } from "../figma-plugin/src/interpreter";
import { parseWireActions } from "../electron/shared/figmaActions";
import { FakeFigma, type FakeNode } from "./helpers/fakeFigma";

/** A page with a "Card" frame (Title, Price texts, Photo rectangle) and an auto-layout "List" with one "Row". */
function setup() {
  const figma = new FakeFigma();
  const page = figma.currentPage;
  const card = figma.node("FRAME", "Card", page, { x: 10, y: 10, width: 200, height: 120, clipsContent: true });
  const title = figma.node("TEXT", "Title", card, { x: 10, y: 10, width: 180, height: 20, characters: "Title" });
  figma.node("TEXT", "Price", card, { x: 10, y: 40, width: 80, height: 20, characters: "0.00" });
  figma.node("RECTANGLE", "Photo", card, { x: 100, y: 40, width: 80, height: 60 });
  const list = figma.node("FRAME", "List", page, { x: 300, y: 10, width: 200, height: 300, layoutMode: "VERTICAL" });
  const row = figma.node("FRAME", "Row", list, { width: 200, height: 30 });
  figma.node("TEXT", "Name", row, { width: 100, height: 20, characters: "Name" });
  figma.node("TEXT", "Qty", row, { x: 120, width: 60, height: 20, characters: "1" });
  return { figma, page, card, title, list, row };
}

function host(figma: FakeFigma, extra: Partial<Host> = {}): Host {
  return {
    figma: figma as unknown as PluginAPI,
    page: figma.currentPage as unknown as PageNode,
    createdPages: [],
    isCancelled: () => false,
    progress: () => undefined,
    ...extra,
  };
}

async function run(figma: FakeFigma, actions: unknown[], extra: Partial<Host> = {}) {
  const parsed = parseWireActions({ actions });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return new Interpreter(host(figma, extra)).runAll(parsed.actions);
}

describe("node references", () => {
  it("resolves names, paths, ids, results and descendants of results", async () => {
    const { figma, title, card } = setup();
    const i = new Interpreter(host(figma));
    expect(await i.one("Title")).toBe(title);
    expect(await i.one("Card/Title")).toBe(title);
    expect(await i.one(title.id)).toBe(title);
    expect(await i.one("page:Page 1/Card")).toBe(card);

    const res = await run(figma, [
      { action: "duplicateNode", id: "dup", node: "Card", name: "Card copy" },
      { action: "setText", node: "$dup.#Title", text: "Honey" },
      { action: "setText", node: "$dup/Price", text: "4.20" },
    ]);
    expect(res.ok).toBe(true);
    const copy = figma.currentPage.children.find((c) => c.name === "Card copy")!;
    expect(copy.findOne((n) => n.name === "Title")!.characters).toBe("Honey");
    expect(copy.findOne((n) => n.name === "Price")!.characters).toBe("4.20");
    // The original is untouched.
    expect(title.characters).toBe("Title");
  });

  it("fails with a clear message for a missing layer and stops at that action", async () => {
    const { figma } = setup();
    const res = await run(figma, [
      { action: "renameNode", node: "Card", name: "Card A" },
      { action: "setText", node: "Nope", text: "x" },
      { action: "renameNode", node: "List", name: "never" },
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ index: 1, action: "setText" });
    expect(res.error!.message).toContain('No layer named "Nope"');
    expect(figma.currentPage.children.some((c) => c.name === "never")).toBe(false);
  });

  it("rejects $refs that no earlier action named", async () => {
    const { figma } = setup();
    const res = await run(figma, [{ action: "setText", node: "$card.#Title", text: "x" }]);
    expect(res.error!.message).toContain('"$card" isn\'t the result of an earlier action');
  });

  it("maps ids to a copied page (scratch and copy runs)", async () => {
    const { figma, page, title } = setup();
    const copyPage = page.clone();
    const idMap = mapIds(page as unknown as BaseNode, copyPage as unknown as BaseNode);
    const res = await run(figma, [{ action: "setText", node: title.id, text: "On the copy" }], { page: copyPage as unknown as PageNode, idMap });
    expect(res.ok).toBe(true);
    expect(title.characters).toBe("Title");
    expect(copyPage.findOne((n) => n.name === "Title")!.characters).toBe("On the copy");
  });
});

describe("text", () => {
  it("loads every font before changing text", async () => {
    const { figma } = setup();
    await run(figma, [{ action: "setText", node: "Title", text: "New" }]);
    expect(figma.loadedFonts).toContain("Inter/Regular");
  });

  it("reports a missing font instead of failing", async () => {
    const { figma, title } = setup();
    title.hasMissingFont = true;
    const res = await run(figma, [{ action: "setText", node: "Title", text: "New" }]);
    expect(res.ok).toBe(true);
    expect(title.characters).toBe("Title");
    expect(res.findings[0]).toMatchObject({ type: "font-missing" });
  });

  it("styles matching words, and reports a missing font style", async () => {
    const { figma, title } = setup();
    title.characters = "Fresh honey, honeycomb and Honey";
    const res = await run(figma, [
      { action: "setTextStyleRanges", node: "Title", ranges: [{ match: "honey", wholeWord: true }], style: { fontStyle: "Bold", fill: "#FF0000" } },
    ]);
    expect(res.ok).toBe(true);
    const bold = title.rangeCalls.filter((c) => c.method === "fontName").map((c) => [c.start, c.end]);
    expect(bold).toEqual([
      [6, 11],
      [27, 32],
    ]);
    // A list of words from a data cell (e.g. an allergens column).
    title.rangeCalls = [];
    const res3 = await run(figma, [{ action: "setTextStyleRanges", node: "Title", ranges: [{ matchAny: "comb, Fresh ,", wholeWord: false }], style: { fontStyle: "Bold" } }]);
    expect(res3.ok).toBe(true);
    expect(title.rangeCalls.filter((c) => c.method === "fontName").map((c) => [c.start, c.end])).toEqual([
      [18, 22],
      [0, 5],
    ]);
    figma.missingFonts.add("Inter/Black");
    const res2 = await run(figma, [{ action: "setTextStyleRanges", node: "Title", ranges: [{ start: 0, end: 5 }], style: { fontStyle: "Black" } }]);
    expect(res2.findings.map((f) => f.type)).toContain("font-style-missing");
  });
});

describe("structure", () => {
  it("fills a list with repeatChild, hides the template and replaces copies on a rerun", async () => {
    const { figma, list, row } = setup();
    const actions = [
      {
        action: "repeatChild",
        id: "rows",
        container: "List",
        templateChild: "Row",
        items: [
          { name: "Honey", qty: 2 },
          { name: "Jam", qty: "1" },
        ],
        bindings: { Name: "name", Qty: "{qty} ×" },
        namePattern: "Row {name}",
      },
    ];
    const res = await run(figma, actions);
    expect(res.ok).toBe(true);
    const copies = list.children.filter((c) => c !== row);
    expect(copies.map((c) => c.name)).toEqual(["Row Honey", "Row Jam"]);
    expect(copies[1].findOne((n) => n.name === "Qty")!.characters).toBe("1 ×");
    expect(row.visible).toBe(false);
    await run(figma, actions);
    expect(list.children.filter((c) => c !== row)).toHaveLength(2);
  });

  it("reports a binding to a field the items don't have", async () => {
    const { figma } = setup();
    const res = await run(figma, [{ action: "repeatChild", container: "List", templateChild: "Row", items: [{ name: "A" }], bindings: { Name: "title" } }]);
    expect(res.error!.message).toContain('no "title" field');
  });

  it("arranges nodes in a grid", async () => {
    const { figma, page } = setup();
    const a = figma.node("FRAME", "A", page, { width: 50, height: 40 });
    const b = figma.node("FRAME", "B", page, { width: 50, height: 40 });
    const c = figma.node("FRAME", "C", page, { width: 50, height: 40 });
    await run(figma, [{ action: "arrangeInGrid", nodes: ["A", "B", "C"], columns: 2, gap: 10, origin: { x: 0, y: 0 } }]);
    expect([a.x, a.y, b.x, b.y, c.x, c.y]).toEqual([0, 0, 60, 0, 0, 50]);
  });

  it("refuses to arrange children of an auto-layout frame", async () => {
    const { figma } = setup();
    const res = await run(figma, [{ action: "arrangeInGrid", nodes: ["Row"], columns: 2, gap: 4 }]);
    expect(res.error!.message).toContain("auto layout");
  });

  it("only sets padding on auto-layout frames", async () => {
    const { figma, list } = setup();
    const ok = await run(figma, [{ action: "setProperties", node: "List", props: { paddingTop: 12, fills: "#00FF0080" } }]);
    expect(ok.ok).toBe(true);
    expect(list.paddingTop).toBe(12);
    expect((list.fills[0] as { opacity: number }).opacity).toBeCloseTo(0.5, 1);
    const bad = await run(figma, [{ action: "setProperties", node: "Card", props: { paddingTop: 4 } }]);
    expect(bad.error!.message).toContain("doesn't use auto layout");
  });
});

describe("media", () => {
  it("places an SVG inside a frame, scaled to fit and centered, replacing an earlier one", async () => {
    const { figma, card } = setup();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"></svg>';
    await run(figma, [{ action: "placeSvg", node: "Card", svg, name: "Barcode" }]);
    await run(figma, [{ action: "placeSvg", node: "Card", svg, name: "Barcode" }]);
    const placed = card.children.filter((c) => c.name === "Barcode");
    expect(placed).toHaveLength(1);
    // 50×20 scaled by min(200/50, 120/20) = 4 → 200×80, centered vertically.
    expect([placed[0].width, placed[0].height, placed[0].x, placed[0].y]).toEqual([200, 80, 0, 20]);
  });

  it("fills a shape with an image and flags upscaling", async () => {
    const { figma, card } = setup();
    const photo = card.findOne((n) => n.name === "Photo")!;
    photo.width = 600;
    const res = await run(figma, [{ action: "setImageFill", node: "Photo", image: { bytes: Buffer.from("png").toString("base64"), name: "a.png" }, scaleMode: "FILL" }]);
    expect(res.ok).toBe(true);
    expect(photo.fills[0]).toMatchObject({ type: "IMAGE", imageHash: "hash-1", scaleMode: "FILL" });
    expect(res.findings[0]).toMatchObject({ type: "upscaled-image" });
  });

  it("exports a node and adds it to the named output", async () => {
    const { figma } = setup();
    const res = await run(figma, [{ action: "exportNode", node: "Card", format: "PNG", scale: 2, fileName: "card", output: "files" }]);
    expect(res.exports).toHaveLength(1);
    expect(res.exports[0]).toMatchObject({ fileName: "card", format: "PNG", output: "files", data: "AQID" });
  });
});

describe("checks and control", () => {
  it("measures text that doesn't fit and layers outside a boundary", async () => {
    const { figma, card } = setup();
    const price = card.findOne((n) => n.name === "Price")!;
    price.characters = "A very long price label that wraps";
    const photo = card.findOne((n) => n.name === "Photo")!;
    photo.x = 160; // 160 + 80 > 200
    const res = await run(figma, [{ action: "measure", node: "Card" }]);
    const types = res.findings.map((f) => f.type);
    expect(types).toContain("text-overflow");
    expect(res.findings.find((f) => f.type === "outside-boundary")!.message).toContain('"Photo" sticks out of "Card" at the right');
  });

  it("stops when cancelled", async () => {
    const { figma } = setup();
    await expect(run(figma, [{ action: "renameNode", node: "Card", name: "x" }], { isCancelled: () => true })).rejects.toBeInstanceOf(CancelledInFigma);
  });

  it("records named results and stage outputs", async () => {
    const { figma } = setup();
    const res = await run(figma, [
      { action: "findNodes", id: "texts", query: { type: "TEXT" }, within: "Card", output: "texts" },
      { action: "inspectNode", id: "card", node: "Card", depth: 1 },
    ]);
    expect((res.results.texts as unknown[]).length).toBe(2);
    expect(res.outputs.texts).toHaveLength(2);
    expect((res.results.card as { children: unknown[] }).children).toHaveLength(3);
    expect(res.steps.map((s) => s.action)).toEqual(["findNodes", "inspectNode"]);
  });
});

// Keep FakeNode's type in use for editors that check test files.
export type { FakeNode };

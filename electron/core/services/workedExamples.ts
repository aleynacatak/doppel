// Worked examples for the app guides: small, complete routines built mainly from helpers (Photoshop), ctx helpers
// (InDesign) and catalog actions (Figma). They are checked like real proposals (tests/promptExample.test.ts), so the
// model never learns from a broken example.

export interface WorkedExample {
  title: string;
  routine: Record<string, unknown>;
}

const actions = (list: Record<string, unknown>[]) => JSON.stringify(list);

export const WORKED_EXAMPLES: Record<"photoshop" | "indesign" | "figma", WorkedExample[]> = {
  photoshop: [
    {
      title: "Transparent PNG cut-outs of product photos on white",
      routine: {
        name: "Cut out product photos",
        app: "photoshop",
        inputs: [{ key: "photos", label: "Product photos", type: "fileList", required: true, extensions: ["jpg", "png"] }],
        settings: [{ key: "tolerance", label: "White tolerance", type: "number", required: false, default: 24 }],
        iterate: { input: "photos" },
        outputs: [{ key: "cutouts", label: "Cut-outs", type: "fileList", required: true, extensions: ["png"] }],
        steps: ["Opens each photo", "Removes the white background", "Trims the empty edges and saves a PNG"],
        script: [
          "// step 1",
          "var img = openDocument(ctx.item.path);",
          "// step 2",
          "removeWhiteBackground(img, params.tolerance);",
          "// step 3",
          "trimTransparent(img);",
          'ctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
        ].join("\n"),
      },
    },
    {
      title: "Masked cut-out: a PSD that keeps an editable layer mask, plus a transparent PNG",
      routine: {
        name: "Masked product cut-outs",
        app: "photoshop",
        inputs: [{ key: "photos", label: "Product photos", type: "fileList", required: true, extensions: ["jpg", "png"] }],
        settings: [{ key: "tolerance", label: "White tolerance", type: "number", required: false, default: 24 }],
        iterate: { input: "photos" },
        outputs: [
          { key: "psds", label: "Masked PSDs", type: "fileList", required: true, extensions: ["psd"] },
          { key: "pngs", label: "Transparent PNGs", type: "fileList", required: true, extensions: ["png"] },
        ],
        steps: ["Opens each photo and keeps a hidden copy of it", "Hides the white background with a layer mask", "Crops to the product and saves a PSD and a PNG"],
        script: [
          "// step 1",
          "var img = openDocument(ctx.item.path);",
          "var photo = img.activeLayer;",
          "var original = photo.duplicate();",
          'original.name = "Original";',
          "original.visible = false;",
          "// step 2",
          "var cut = maskWhiteBackground(photo, { tolerance: params.tolerance });",
          "// step 3",
          "cropToBounds(img, cut.bounds, 4);",
          'ctx.output("psds", saveCopy(ctx.workDir, ctx.item.stem));',
          'ctx.output("pngs", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
        ].join("\n"),
      },
    },
    {
      title: "A mockup per data row: the row's label image into a Smart Object, its title into a text layer",
      routine: {
        name: "Fill mockups",
        app: "photoshop",
        inputs: [
          { key: "mockup", label: "Mockup PSD", type: "file", required: true, extensions: ["psd"] },
          { key: "products", label: "Products", type: "rows", required: true, columns: ["title", "label"] },
          { key: "labels", label: "Label images", type: "fileList", required: true, extensions: ["png", "jpg"] },
        ],
        settings: [{ key: "quality", label: "JPG quality", type: "number", required: false, default: 85 }],
        iterate: { input: "products" },
        outputs: [{ key: "mockups", label: "Mockups", type: "fileList", required: true, extensions: ["jpg"] }],
        steps: ["Opens the mockup", "Puts each product's label into the Label Smart Object and its title into the Title layer", "Saves a JPG per product"],
        script: [
          "// step 1",
          "var doc = openDocument(params.mockup);",
          "// step 2",
          'replaceSmartObject(findLayer("Label"), ctx.matched.labels.path);',
          'setTextLayer(findLayer("Title"), ctx.item.title);',
          "// step 3",
          'ctx.output("mockups", exportImage(ctx.join(ctx.workDir, ctx.safeFileName(ctx.item.title) + ".jpg"), "jpg", params.quality));',
        ].join("\n"),
      },
    },
  ],
  indesign: [
    {
      title: "Every page (or the pages picked) as a PNG",
      routine: {
        name: "Export pages as PNG",
        app: "indesign",
        inputs: [{ key: "document", label: "Document", type: "document", required: true }],
        settings: [
          { key: "pages", label: "Pages", type: "text", required: false, default: "all" },
          { key: "dpi", label: "Resolution (ppi)", type: "number", required: false, default: 150 },
        ],
        outputs: [{ key: "pngs", label: "Page PNGs", type: "fileList", required: true, extensions: ["png"] }],
        steps: ["Exports each page you pick as a PNG", "Uses the resolution you set"],
        script: [
          "// step 1",
          "var prefs = app.pngExportPreferences;",
          'var saved = ctx.savePrefs(prefs, ["exportResolution", "pngExportRange", "pageString"]);',
          "try {",
          "  prefs.exportResolution = params.dpi;",
          "  prefs.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE;",
          "  var pages = ctx.resolvePages(params.pages);",
          "  for (var i = 0; i < pages.length; i++) {",
          "    prefs.pageString = ctx.pageRangeRef(pages[i]);",
          '    var file = new File(ctx.workDir + "/" + ctx.format("{doc}_{page}", { doc: ctx.safeFileName(ctx.docName), page: ctx.pad(ctx.pageIndex(pages[i]), 2) }) + ".png");',
          "    doc.exportFile(ExportFormat.PNG_FORMAT, file, false);",
          '    ctx.output({ key: "pngs", label: file.name, filePath: file.fsName, page: pages[i].name, pageIndex: ctx.pageIndex(pages[i]), profile: "web" });',
          "  }",
          "} finally {",
          "  ctx.restorePrefs(prefs, saved);",
          "}",
        ].join("\n"),
      },
    },
    {
      title: "Replace a placeholder text everywhere and report the pages that changed",
      routine: {
        name: "Replace placeholder text",
        app: "indesign",
        inputs: [{ key: "document", label: "Document", type: "document", required: true }],
        settings: [
          { key: "find", label: "Find", type: "text", required: true, default: "{{name}}" },
          { key: "replaceWith", label: "Replace with", type: "text", required: true, default: "" },
        ],
        outputs: [],
        modifiesDocument: true,
        steps: ["Replaces the text you give everywhere in the document", "Shows each page that changed"],
        script: [
          "// step 1",
          "app.findTextPreferences = NothingEnum.NOTHING;",
          "app.changeTextPreferences = NothingEnum.NOTHING;",
          "app.findTextPreferences.findWhat = params.find;",
          "app.changeTextPreferences.changeTo = params.replaceWith;",
          "var changed = doc.changeText();",
          "app.findTextPreferences = NothingEnum.NOTHING;",
          "app.changeTextPreferences = NothingEnum.NOTHING;",
          "// step 2",
          "var seen = {};",
          "for (var i = 0; i < changed.length; i++) {",
          "  var frames = changed[i].parentTextFrames;",
          "  var page = frames.length ? frames[0].parentPage : null;",
          "  if (!page || seen[page.id]) continue;",
          "  seen[page.id] = true;",
          '  ctx.output({ key: "page-" + page.name, label: "Page " + page.name, page: page.name, pageIndex: ctx.pageIndex(page) });',
          "}",
          "return { replaced: changed.length };",
        ].join("\n"),
      },
    },
  ],
  figma: [
    {
      title: "A label per data row: fill its texts and export it named by a column",
      routine: {
        name: "Fill product labels",
        app: "figma",
        inputs: [
          { key: "file", label: "Figma file", type: "document", required: true },
          { key: "products", label: "Products", type: "rows", required: true, columns: ["sku", "name", "price"] },
        ],
        settings: [{ key: "scale", label: "Export scale", type: "number", required: false, default: 2 }],
        iterate: { input: "products" },
        outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
        steps: ["Copies the Label frame for each product", "Fills in its name and price", "Exports each label as a PNG named by its SKU"],
        modifiesDocument: true,
        actions: actions([
          { action: "duplicateNode", id: "label", node: "Label" },
          { action: "setText", node: "$label.#Name", text: "{{item.name}}" },
          { action: "setText", node: "$label.#Price", text: "{{item.price}}" },
          { action: "measure", node: "$label" },
          { action: "exportNode", node: "$label", format: "PNG", scale: "{{settings.scale}}", fileName: "{{item.sku}}", output: "labels" },
        ]),
      },
    },
    {
      title: "A card per row with the photo Doppl paired with it",
      routine: {
        name: "Fill photo cards",
        app: "figma",
        inputs: [
          { key: "file", label: "Figma file", type: "document", required: true },
          { key: "products", label: "Products", type: "rows", required: true, columns: ["title", "photo"] },
          { key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["png", "jpg"] },
        ],
        settings: [],
        iterate: { input: "products" },
        outputs: [{ key: "cards", label: "Cards", type: "fileList", required: true, extensions: ["jpg"] }],
        steps: ["Copies the Card frame for each product", "Fills in its title and its photo", "Exports each card as a JPG"],
        modifiesDocument: true,
        actions: actions([
          { action: "duplicateNode", id: "card", node: "Card" },
          { action: "setText", node: "$card.#Title", text: "{{item.title}}" },
          { action: "setImageFill", node: "$card.#Photo", image: { file: "{{matched.photos}}" }, scaleMode: "FILL" },
          { action: "exportNode", node: "$card", format: "JPG", fileName: "{{item.title}}", output: "cards" },
        ]),
      },
    },
    {
      title: "A shelf tag per row with an EAN-13 barcode, as PDF",
      routine: {
        name: "Shelf tags with barcodes",
        app: "figma",
        inputs: [
          { key: "file", label: "Figma file", type: "document", required: true },
          { key: "products", label: "Products", type: "rows", required: true, columns: ["name", "ean"] },
        ],
        settings: [],
        iterate: { input: "products" },
        outputs: [{ key: "tags", label: "Shelf tags", type: "fileList", required: true, extensions: ["pdf"] }],
        steps: ["Copies the Shelf tag frame for each product", "Fills in its name and draws its barcode", "Exports each tag as a PDF"],
        modifiesDocument: true,
        actions: actions([
          { action: "duplicateNode", id: "tag", node: "Shelf tag" },
          { action: "setText", node: "$tag.#Product", text: "{{item.name}}" },
          { action: "placeSvg", node: "$tag.#Barcode", svg: { barcode: { type: "ean13", value: "{{item.ean}}" } }, name: "EAN" },
          { action: "exportNode", node: "$tag", format: "PDF", fileName: "{{item.ean}}", output: "tags" },
        ]),
      },
    },
  ],
};

const ES3 = `ES3 checklist (scripts are checked for it): var only (no let/const), no arrow functions, no template literals
(join strings with +), no forEach/map/filter/indexOf on arrays (use for loops), no String.trim, no Object.keys;
JSON.parse and JSON.stringify work. Never hide a failing step in try { … } catch (e) {}: let it throw.`;

/** The worked examples as guide text, with the code where the routine's format puts it. */
export function workedExamplesText(app: string, separate: boolean): string {
  const list = WORKED_EXAMPLES[app as keyof typeof WORKED_EXAMPLES];
  if (!list?.length) return "";
  const parts = list.map(({ title, routine }) => {
    const { script, actions: acts, ...contract } = routine as { script?: string; actions?: string };
    const code = script ?? JSON.stringify(JSON.parse(String(acts)), null, 1);
    const lang = script !== undefined ? "javascript" : "json";
    return separate
      ? `### ${title}\n${JSON.stringify({ ...contract, [script !== undefined ? "script" : "actions"]: "@code:1" })}\n\`\`\`${lang}\n${code}\n\`\`\``
      : `### ${title}\n${JSON.stringify(routine)}`;
  });
  return `\n\nWorked examples (complete routines that work; build yours the same way, mostly from the helpers):\n\n${parts.join("\n\n")}${app === "figma" ? "" : `\n\n${ES3}`}`;
}

import type { RoutineTemplate } from "../types";

// Real, working InDesign routines (ExtendScript). Each script is the body of
// `function (doc, params, ctx) { … }`: `doc` is the document to work on, `params` the values the user
// picked on the Run screen, `ctx` Doppl's helpers (see jsx/lib.ts → makeContext).
// No absolute paths: every file and folder is a param chosen at run time.
// They're shown to the model as examples of how InDesign routines are written.

const exportPng = String.raw`// Export the chosen pages as PNG files into the output folder.
var folder = ctx.ensureFolder(params.outputFolder);
var pages = ctx.resolvePages(params.pageRange);
var prefs = app.pngExportPreferences;
var saved = ctx.savePrefs(prefs, ["exportResolution", "pngExportRange", "pageString", "exportingSpread", "pngQuality", "transparentBackground", "antiAlias"]);
try {
  prefs.exportResolution = Number(params.resolution) || 150;
  prefs.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE;
  prefs.exportingSpread = false;
  prefs.pngQuality = PNGQualityEnum.HIGH;
  prefs.transparentBackground = false;
  prefs.antiAlias = true;
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    var name = ctx.safeFileName(ctx.format(params.namingPattern || "{doc}_{page}", {
      doc: ctx.docName,
      page: page.name,
      index: ctx.pad(i + 1, 2)
    }));
    var file = new File(folder.fsName + "/" + name + ".png");
    prefs.pageString = ctx.pageRangeRef(page);
    doc.exportFile(ExportFormat.PNG_FORMAT, file, false);
    ctx.output({
      key: "page-" + ctx.pageIndex(page),
      label: "Page " + page.name,
      filePath: file.fsName,
      page: page.name,
      pageIndex: ctx.pageIndex(page),
      profile: "web"
    });
  }
} finally {
  ctx.restorePrefs(prefs, saved);
}
return { exported: pages.length };`;

const exportPdfs = String.raw`// Export the whole document twice: once for print, once for screens.
var folder = ctx.ensureFolder(params.outputFolder);
var jobs = [
  { format: "print", presetName: params.printPreset, label: "Print PDF" },
  { format: "web", presetName: params.webPreset, label: "Web PDF" }
];
var pdfPrefs = app.pdfExportPreferences;
var saved = ctx.savePrefs(pdfPrefs, ["pageRange"]);
try {
  pdfPrefs.pageRange = PageRange.ALL_PAGES;
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var preset = app.pdfExportPresets.itemByName(job.presetName);
    if (!preset.isValid) {
      throw new Error("The PDF preset \"" + job.presetName + "\" doesn't exist in this InDesign.");
    }
    var name = ctx.safeFileName(ctx.format(params.namingPattern || "{doc}_{format}", {
      doc: ctx.docName,
      format: job.format
    }));
    var file = new File(folder.fsName + "/" + name + ".pdf");
    doc.exportFile(ExportFormat.PDF_TYPE, file, false, preset);
    ctx.output({
      key: "pdf-" + job.format,
      label: job.label + " \u00b7 " + job.presetName,
      filePath: file.fsName,
      profile: job.format
    });
  }
} finally {
  ctx.restorePrefs(pdfPrefs, saved);
}
return { exported: jobs.length };`;

const preflight = String.raw`// Read-only: collect overset text, missing links, missing fonts and low-resolution images.
// Nothing in the document is changed. Findings are shown as quality checks per page.
var findings = ctx.preflight({ minPpi: Number(params.minPpi) || 300 });
var pages = ctx.resolvePages("all");
for (var i = 0; i < pages.length; i++) {
  ctx.output({
    key: "page-" + ctx.pageIndex(pages[i]),
    label: "Page " + pages[i].name,
    page: pages[i].name,
    pageIndex: ctx.pageIndex(pages[i])
  });
}
return { findings: findings };`;

const renameLayers = String.raw`// Rename every layer with a pattern. Dry run only previews the new names.
// An existing number prefix ("03_") is replaced, not doubled, so the routine can be rerun.
var layers = doc.layers.everyItem().getElements();
var pattern = params.pattern || "{index}_{name}";
var width = Math.max(2, String(layers.length).length);
var renames = [];
var seen = {};
for (var i = 0; i < layers.length; i++) {
  var current = layers[i].name;
  var next = ctx.format(pattern, {
    index: ctx.pad(i + 1, width),
    name: current.replace(/^\d+_/, ""),
    doc: ctx.docName
  });
  if (seen[next]) {
    throw new Error("Two layers would both be called \"" + next + "\". Add {index} or {name} to the pattern.");
  }
  seen[next] = true;
  renames.push({ layer: layers[i], from: current, to: next });
}
if (!params.dryRun) {
  // Two passes, so a new name never clashes with a name that is still in use.
  for (var j = 0; j < renames.length; j++) { renames[j].layer.name = "__doppl_tmp_" + j; }
  for (var k = 0; k < renames.length; k++) { renames[k].layer.name = renames[k].to; }
}
var details = [];
for (var d = 0; d < renames.length; d++) {
  details.push({ label: renames[d].from, value: renames[d].to });
}
ctx.output({
  key: "layers",
  label: params.dryRun ? "Layer names (dry run, nothing changed)" : "Renamed " + renames.length + " layers",
  details: details
});
return { renamed: params.dryRun ? 0 : renames.length };`;

const placeText = String.raw`// Experimental: place a text file into the main text frame of the starting page,
// then add pages with threaded frames until all the text fits.
var file = new File(params.textFile);
if (!file.exists) { throw new Error("The text file couldn't be found: " + file.name); }
var pages = ctx.resolvePages("all");
var start = Math.max(1, Math.round(Number(params.startPage) || 1));
if (start > pages.length) { throw new Error("The document only has " + pages.length + " pages."); }
var page = pages[start - 1];

// Main text frame: the largest text frame on the page, or a new one inside the margins.
var frames = page.textFrames.length ? page.textFrames.everyItem().getElements() : [];
var frame = null;
var bestArea = 0;
for (var i = 0; i < frames.length; i++) {
  var b = frames[i].geometricBounds;
  var area = (b[2] - b[0]) * (b[3] - b[1]);
  if (area > bestArea) { bestArea = area; frame = frames[i]; }
}
if (!frame) { frame = page.textFrames.add({ geometricBounds: ctx.marginBounds(page) }); }
frame.place(file);

// Autoflow: thread a new frame on a new page after the last one until the story fits.
var story = frame.parentStory;
var added = 0;
story.recompose();
while (story.overflows && added < 200) {
  var last = story.textContainers[story.textContainers.length - 1];
  var newPage = doc.pages.add(LocationOptions.AFTER, last.parentPage);
  var next = newPage.textFrames.add({ geometricBounds: ctx.marginBounds(newPage) });
  last.nextTextFrame = next;
  story.recompose();
  added++;
}
if (story.overflows) { throw new Error("The text still doesn't fit after adding 200 pages."); }

var lastPage = story.textContainers[story.textContainers.length - 1].parentPage;
var end = ctx.pageIndex(lastPage);
var all = ctx.resolvePages("all");
for (var p = start; p <= end; p++) {
  ctx.output({ key: "page-" + p, label: "Page " + all[p - 1].name, page: all[p - 1].name, pageIndex: p });
}
return { addedPages: added };`;

export const INDESIGN_TEMPLATES: RoutineTemplate[] = [
  {
    id: "indesign-export-png",
    appId: "indesign",
    name: "Export pages as PNG",
    description: "Exports the chosen pages as PNG images, named with your pattern.",
    keywords: ["png", "image", "images", "jpg", "jpeg", "thumbnail", "thumbnails", "screenshot", "export pages", "pictures", "social"],
    steps: [
      "Pick the pages to export from the page range",
      "Set PNG export to the chosen resolution",
      "Export each page as its own PNG file into the output folder",
      "Name each file with the naming pattern",
    ],
    params: [
      { key: "outputFolder", label: "Output folder", type: "folder", required: true },
      { key: "resolution", label: "Resolution (ppi)", type: "number", required: true, default: 150, min: 36, max: 1200 },
      { key: "pageRange", label: "Page range", type: "text", required: false, default: "all", help: "Page positions, e.g. 1-3, 5. Leave as \"all\" for every page." },
      { key: "namingPattern", label: "File naming pattern", type: "text", required: true, default: "{doc}_{page}", help: "Tokens: {doc}, {page}, {index}" },
    ],
    script: exportPng,
    modifiesDocument: false,
    qcProfile: "web",
    requiredFonts: [],
  },
  {
    id: "indesign-export-pdfs",
    appId: "indesign",
    name: "Export print and web PDFs",
    description: "Exports the whole document as a print PDF and a web PDF, each with its own preset.",
    keywords: ["pdf", "pdfs", "print", "press", "web pdf", "export", "printer", "deliver", "handoff"],
    steps: [
      "Export all pages as a PDF with the print preset",
      "Export all pages again as a PDF with the web preset",
      "Name both files with the naming pattern and save them in the output folder",
    ],
    params: [
      { key: "outputFolder", label: "Output folder", type: "folder", required: true },
      { key: "printPreset", label: "Print PDF preset", type: "select", required: true, default: "[High Quality Print]", optionsSource: "pdfExportPresets" },
      { key: "webPreset", label: "Web PDF preset", type: "select", required: true, default: "[Smallest File Size]", optionsSource: "pdfExportPresets" },
      { key: "namingPattern", label: "File naming pattern", type: "text", required: true, default: "{doc}_{format}", help: "Tokens: {doc}, {format} (print or web)" },
    ],
    script: exportPdfs,
    modifiesDocument: false,
    qcProfile: "print",
    requiredFonts: [],
  },
  {
    id: "indesign-preflight",
    appId: "indesign",
    name: "Preflight report",
    description: "Checks every page for overset text, missing or modified links, missing fonts and low-resolution images. Changes nothing.",
    keywords: ["preflight", "overset", "missing", "link", "links", "font", "fonts", "check", "resolution", "low-res", "report", "qc", "errors"],
    steps: [
      "Find text that overflows its frame",
      "Find links that are missing or were modified",
      "Find fonts that aren't installed",
      "Find images below the minimum resolution",
      "Report everything per page, without changing the document",
    ],
    params: [
      { key: "minPpi", label: "Minimum image resolution (ppi)", type: "number", required: true, default: 300, min: 36, max: 2400 },
    ],
    script: preflight,
    modifiesDocument: false,
    qcProfile: "print",
    builtInQc: true,
    requiredFonts: [],
  },
  {
    id: "indesign-rename-layers",
    appId: "indesign",
    name: "Rename layers by pattern",
    description: "Renames every layer with a numbered pattern. Use dry run to preview the names first.",
    keywords: ["layer", "layers", "rename", "naming", "organize", "tidy", "clean"],
    steps: [
      "List every layer from top to bottom",
      "Build each new name from the pattern",
      "Stop if two layers would get the same name",
      "Rename the layers, or only show the new names on a dry run",
    ],
    params: [
      { key: "pattern", label: "Naming pattern", type: "text", required: true, default: "{index}_{name}", help: "Tokens: {index}, {name}, {doc}" },
      { key: "dryRun", label: "Dry run (preview names, change nothing)", type: "boolean", required: false, default: true },
    ],
    script: renameLayers,
    modifiesDocument: true,
    qcProfile: "print",
    requiredFonts: [],
  },
  {
    id: "indesign-place-text",
    appId: "indesign",
    name: "Place text into template",
    description: "Places a text file into the main text frame of the starting page and adds pages until the text fits.",
    keywords: ["place", "text", "template", "flow", "autoflow", "lay out", "layout", "guide", "manuscript", "docx", "copy", "article"],
    steps: [
      "Find the main text frame on the starting page",
      "Place the text file into it",
      "Add pages with linked text frames until all text fits",
    ],
    params: [
      { key: "textFile", label: "Text file", type: "file", required: true, extensions: ["txt", "docx", "rtf"] },
      { key: "startPage", label: "Starting page", type: "number", required: true, default: 1, min: 1 },
    ],
    script: placeText,
    modifiesDocument: true,
    qcProfile: "print",
    experimental: true,
    requiredFonts: ["Minion Pro"],
  },
];

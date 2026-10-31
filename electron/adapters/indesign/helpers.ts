import type { HelperDef } from "../../core/blocks/types";

// InDesign building blocks: the ctx helpers (ctx.resolvePages, ctx.preflight…), defined as DopplLib functions in
// every script's library after the runtime (jsx/lib.ts). Versions are never removed; routines run the versions they pin.

const id = (def: Omit<HelperDef, "app" | "source" | "version"> & { version?: number }): HelperDef => ({ app: "indesign", source: "builtin", version: 1, ...def });

export const INDESIGN_HELPERS: HelperDef[] = [
  id({
    id: "id.pageIndex",
    set: "pages",
    call: "ctx.pageIndex",
    summary: "A page's 1-based position in the document.",
    signature: { params: [{"name": "page", "type": "Page"}], returns: "number" },
    sideEffects: [],
    doc: "ctx.pageIndex(page) -> number: 1-based position.\nExample: ctx.format(\"{doc}_{n}\", { doc: ctx.docName, n: ctx.pad(ctx.pageIndex(p), 2) })",
    tests: [{"name": "counts from 1", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.pagesPerDocument = 5;\ntry { return { n: DopplLib.pageIndex(d.pages[2]) }; } finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"n": 3}}],
    code: String.raw`DopplLib.pageIndex = function (page) {
  return page.documentOffset + 1;
};`,
  }),
  id({
    id: "id.pageRangeRef",
    set: "export",
    call: "ctx.pageRangeRef",
    summary: "A page reference for export page ranges (absolute when there are several sections).",
    signature: { params: [{"name": "page", "type": "Page"}], returns: "string" },
    sideEffects: [],
    doc: "ctx.pageRangeRef(page) -> string: page reference for export page ranges (pngExportPreferences.pageString etc.).\nExample: app.pngExportPreferences.pageString = ctx.pageRangeRef(page);",
    tests: [{"name": "names a page", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.pagesPerDocument = 5;\ntry { return { ref: DopplLib.pageRangeRef(d, d.pages[1]) }; } finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"ref": "2"}}],
    code: String.raw`/** Page reference usable in export page ranges. Absolute ("+3") when the document has several sections. */
DopplLib.pageRangeRef = function (doc, page) {
  return doc.sections.length > 1 ? "+" + DopplLib.pageIndex(page) : page.name;
};`,
  }),
  id({
    id: "id.resolvePages",
    set: "pages",
    call: "ctx.resolvePages",
    summary: "Pages from \"all\", \"\" or a range like \"1-3, 5\".",
    signature: { params: [{"name": "spec", "type": "string", "doc": "\"all\", \"\" or \"1-3, 5\""}], returns: "Page[]" },
    sideEffects: [],
    doc: "ctx.resolvePages(spec) -> Page[]: \"all\", \"\" or \"1-3, 5\" (page positions). Throws with a plain message when nothing matches.\nExample: var pages = ctx.resolvePages(params.pages);",
    tests: [{"name": "reads a range", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.pagesPerDocument = 5;\ntry { var p = DopplLib.resolvePages(d, \"4, 1-2\"); return { pages: [p[0].name, p[1].name, p[2].name] }; } finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"pages": ["1", "2", "4"]}}],
    code: String.raw`/** "all", "" or "1-3, 5" (page positions, 1-based). */
DopplLib.resolvePages = function (doc, spec) {
  var all = DopplLib.all(doc.pages);
  var s = String(spec === undefined || spec === null ? "" : spec).replace(/\s+/g, "").toLowerCase();
  if (s === "" || s === "all") { return all; }
  var parts = s.split(",");
  var picked = [];
  var seen = {};
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "") { continue; }
    var m = parts[i].match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { throw new Error("Couldn't read the page range \"" + spec + "\". Use something like 1-3, 5 or all."); }
    var a = parseInt(m[1], 10);
    var b = m[2] ? parseInt(m[2], 10) : a;
    if (b < a) { var t = a; a = b; b = t; }
    for (var n = a; n <= b; n++) {
      if (n >= 1 && n <= all.length && !seen[n]) { seen[n] = true; picked.push(all[n - 1]); }
    }
  }
  if (!picked.length) {
    throw new Error("The page range \"" + spec + "\" doesn't match any page. The document has " + all.length + " pages.");
  }
  picked.sort(function (x, y) { return x.documentOffset - y.documentOffset; });
  return picked;
};`,
  }),
  id({
    id: "id.marginBounds",
    set: "layout",
    call: "ctx.marginBounds",
    summary: "A page's live area inside its margins, as [top, left, bottom, right].",
    signature: { params: [{"name": "page", "type": "Page"}], returns: "[top, left, bottom, right]" },
    sideEffects: [],
    doc: "ctx.marginBounds(page) -> [top, left, bottom, right]: the live area (left and right pages mirrored).\nExample: frame.geometricBounds = ctx.marginBounds(page);",
    tests: [{"name": "is inside the page", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.pagesPerDocument = 5;\ntry { var b = DopplLib.marginBounds(d.pages[0]); var p = d.pages[0].bounds; return { inside: b[0] >= p[0] && b[1] >= p[1] && b[2] <= p[2] && b[3] <= p[3] }; } finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"inside": true}}],
    code: String.raw`/** Live area of a page as geometricBounds [top, left, bottom, right]. */
DopplLib.marginBounds = function (page) {
  var b = page.bounds;
  var m = page.marginPreferences;
  var left = m.left, right = m.right;
  try { if (page.side == PageSideOptions.LEFT_HAND) { left = m.right; right = m.left; } } catch (e) {}
  return [b[0] + m.top, b[1] + left, b[2] - m.bottom, b[3] - right];
};`,
  }),
  id({
    id: "id.savePrefs",
    set: "prefs",
    call: "ctx.savePrefs",
    summary: "Saves app-wide preferences before changing them.",
    signature: { params: [{"name": "prefs", "type": "Preferences", "doc": "e.g. app.pngExportPreferences"}, {"name": "keys", "type": "string[]", "doc": "property names"}], returns: "saved values" },
    sideEffects: [],
    doc: "ctx.savePrefs(prefsObject, [propertyNames]) -> saved; always restore them in finally with ctx.restorePrefs(prefsObject, saved).\nExample: var saved = ctx.savePrefs(app.pngExportPreferences, [\"exportResolution\"]); try { … } finally { ctx.restorePrefs(app.pngExportPreferences, saved); }",
    tests: [{"name": "saves and restores", "inputs": {}, "script": "var p = app.pngExportPreferences;\nvar before = p.exportResolution;\nvar saved = DopplLib.savePrefs(p, [\"exportResolution\"]);\np.exportResolution = before === 300 ? 150 : 300;\nDopplLib.restorePrefs(p, saved);\nreturn { same: p.exportResolution === before };", "checks": [], "expect": {"same": true}}],
    code: String.raw`DopplLib.savePrefs = function (prefs, keys) {
  var saved = {};
  for (var i = 0; i < keys.length; i++) {
    try { saved[keys[i]] = prefs[keys[i]]; } catch (e) {}
  }
  return saved;
};`,
  }),
  id({
    id: "id.restorePrefs",
    set: "prefs",
    call: "ctx.restorePrefs",
    summary: "Puts preferences back the way savePrefs found them.",
    signature: { params: [{"name": "prefs", "type": "Preferences"}, {"name": "saved", "type": "saved values", "doc": "from ctx.savePrefs"}], returns: "nothing" },
    sideEffects: ["changes app-wide preferences back"],
    doc: "ctx.restorePrefs(prefsObject, saved): puts back what ctx.savePrefs saved (in finally).",
    tests: [{"name": "restores a value", "inputs": {}, "script": "var p = app.pngExportPreferences;\nvar before = p.exportResolution;\nDopplLib.restorePrefs(p, { exportResolution: before });\nreturn { same: p.exportResolution === before };", "checks": [], "expect": {"same": true}}],
    code: String.raw`DopplLib.restorePrefs = function (prefs, saved) {
  for (var k in saved) {
    if (Object.prototype.hasOwnProperty.call(saved, k)) {
      try { prefs[k] = saved[k]; } catch (e) {}
    }
  }
};`,
  }),
  id({
    id: "id.open",
    set: "documents",
    call: "ctx.open",
    summary: "Opens a document for the routine (a copy when the designer has it open); close it with ctx.close.",
    signature: { params: [{"name": "path", "type": "string | File"}, {"name": "opts", "type": "{ showWindow? }", "optional": true, "doc": "hidden by default"}], returns: "Document" },
    sideEffects: ["opens a document in InDesign"],
    doc: "ctx.open(path, {showWindow?}) -> Document: opens a template or other file the routine works on, hidden unless showWindow. When the designer has the file open, it opens a copy, so their document stays untouched. Close it with ctx.close(doc).\nExample: var card = ctx.open(params.template);",
    tests: [{"name": "opens hidden and checks before closing", "inputs": {}, "script": "var d = app.documents.add();\nvar f = d.pages[0].textFrames.add({ geometricBounds: [\"10mm\", \"10mm\", \"12mm\", \"30mm\"] });\nf.contents = \"This text is far too long for its tiny frame and overflows.\";\nvar file = new File(ctx.workDir + \"/open-test.indd\");\nd.save(file);\nd.close(SaveOptions.NO);\nvar opened = ctx.open(file.fsName);\nvar hidden = opened.layoutWindows.length === 0;\nctx.close(opened);\nvar overset = false;\nfor (var i = 0; i < ctx._track.findings.length; i++) if (ctx._track.findings[i].type === \"overset\") overset = true;\nfile.remove();\nreturn { hidden: hidden, closed: !opened.isValid, overset: overset };", "checks": [], "expect": {"hidden": true, "closed": true, "overset": true}}],
    code: String.raw`/** Opens a document for the routine, hidden unless opts.showWindow. A file the designer has open opens as a copy. */
DopplLib.open = function (track, path, opts) {
  var file = path instanceof File ? path : new File(path);
  if (!file.exists) { throw new Error("The file couldn't be found: " + file.displayName); }
  var show = !!(opts && opts.showWindow);
  var isOpen = false;
  var docs = DopplLib.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    try { if (docs[i].saved && docs[i].fullName.fsName === file.fsName) { isOpen = true; } } catch (e) {}
  }
  var d = isOpen ? app.open(file, show, OpenOptions.OPEN_COPY) : app.open(file, show);
  if (d instanceof Array) { d = d[0]; }
  track.opened.push({ id: DopplLib.docId(d), doc: d, hidden: !show });
  return d;
};`,
  }),
  id({
    id: "id.close",
    set: "documents",
    call: "ctx.close",
    summary: "Checks a document the routine opened or made (overset text, fonts, links, images), then closes it without saving.",
    signature: { params: [{"name": "doc", "type": "Document", "doc": "one the routine opened (ctx.open) or made"}], returns: "nothing" },
    sideEffects: ["closes the document without saving"],
    doc: "ctx.close(doc): Doppl checks the document first (its findings become the item's quality checks), then closes it without saving. Use it for every document the routine opened or made; never for doc (Doppl closes that).\nExample: ctx.exportPdf(card, ctx.workDir + \"/card.pdf\", { preset: params.preset }); ctx.close(card);",
    tests: [{"name": "refuses the designer's documents", "inputs": {}, "script": "var mine = app.documents.add();\nvar track = DopplLib.makeTrack();\nvar refused = false;\ntry { DopplLib.close(track, mine); } catch (e) { refused = true; }\nmine.close(SaveOptions.NO);\nreturn { refused: refused };", "checks": [], "expect": {"refused": true}}],
    code: String.raw`/** Checks a document the routine opened or made, then closes it without saving. */
DopplLib.close = function (track, d) {
  if (!d || !d.isValid) { return; }
  if (track.before[DopplLib.docId(d)]) {
    throw new Error("ctx.close only closes documents the routine opened or made itself.");
  }
  try { DopplLib.checkDocument(track, d); } catch (e) {}
  d.close(SaveOptions.NO);
};`,
  }),
  id({
    id: "id.exportPdf",
    set: "export",
    call: "ctx.exportPdf",
    summary: "Exports a PDF with a preset plus marks and bleed of your own (crop marks really appear).",
    signature: {
      params: [
        {"name": "doc", "type": "Document"},
        {"name": "path", "type": "string | File", "doc": "in ctx.workDir"},
        {"name": "opts", "type": "{ preset?, cropMarks?, bleedMarks?, registrationMarks?, colorBars?, pageInformationMarks?, useDocumentBleed?, pages? }", "optional": true, "doc": "pages: an export page range such as \"1-3\" (default all)"},
      ],
      returns: "File",
    },
    sideEffects: ["writes a PDF file"],
    doc: "ctx.exportPdf(doc, path, {preset?, cropMarks?, bleedMarks?, registrationMarks?, colorBars?, pageInformationMarks?, useDocumentBleed?, pages?}) -> File: applies the preset, then your options, exports, and puts InDesign's PDF settings back. Use it instead of doc.exportFile(…, preset): with a preset there, InDesign ignores app.pdfExportPreferences, so crop marks set there never appear.\nExample: var pdf = ctx.exportPdf(doc, ctx.workDir + \"/\" + ctx.safeFileName(ctx.docName) + \".pdf\", { preset: params.preset, cropMarks: true, useDocumentBleed: true }); ctx.output({ key: \"pdf\", label: pdf.displayName, filePath: pdf.fsName });",
    tests: [{"name": "adds crop marks to a preset without them", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.documentBleedTopOffset = \"3mm\";\nd.documentPreferences.documentBleedUniformSize = true;\nvar before = app.pdfExportPreferences.cropMarks;\nvar pdf = DopplLib.exportPdf(d, ctx.workDir + \"/marks.pdf\", { preset: \"[High Quality Print]\", cropMarks: true, useDocumentBleed: true });\nd.close(SaveOptions.NO);\npdf.encoding = \"BINARY\";\npdf.open(\"r\");\nvar s = pdf.read();\npdf.close();\nfunction width(box) { var m = s.match(new RegExp(\"/\" + box + \"\\\\s*\\\\[\\\\s*([-\\\\d.]+)\\\\s+[-\\\\d.]+\\\\s+([-\\\\d.]+)\")); return m ? Number(m[2]) - Number(m[1]) : 0; }\nreturn { marks: width(\"MediaBox\") > width(\"TrimBox\") + 1, restored: app.pdfExportPreferences.cropMarks === before };", "checks": [], "expect": {"marks": true, "restored": true}}],
    code: String.raw`/**
 * Exports a PDF with a preset plus overrides. doc.exportFile with a preset ignores app.pdfExportPreferences (crop marks
 * set there are lost), so the preset's settings go into the preferences, the overrides on top, and the preferences
 * are put back afterwards.
 */
DopplLib.exportPdf = function (doc, path, opts) {
  opts = opts || {};
  var prefs = app.pdfExportPreferences;
  var skip = { name: true, parent: true, index: true, id: true, isValid: true, properties: true, eventListeners: true, events: true };
  var saved = {};
  var current = prefs.properties;
  for (var k in current) {
    if (current.hasOwnProperty(k) && !skip[k]) { saved[k] = current[k]; }
  }
  var file = path instanceof File ? path : new File(path);
  try {
    if (opts.preset) {
      var preset = app.pdfExportPresets.itemByName(String(opts.preset));
      if (!preset.isValid) { throw new Error("There's no PDF preset named \"" + opts.preset + "\" in this InDesign."); }
      var settings = preset.properties;
      // Twice: some settings (PDF/X standards, compatibility) reset others when they're set.
      for (var pass = 0; pass < 2; pass++) {
        for (var p in settings) {
          if (settings.hasOwnProperty(p) && !skip[p]) {
            try { prefs[p] = settings[p]; } catch (e) {}
          }
        }
      }
    }
    var marks = ["cropMarks", "bleedMarks", "registrationMarks", "colorBars", "pageInformationMarks"];
    for (var i = 0; i < marks.length; i++) {
      if (opts[marks[i]] !== undefined) { prefs[marks[i]] = !!opts[marks[i]]; }
    }
    if (opts.useDocumentBleed !== undefined) { prefs.useDocumentBleedWithPDF = !!opts.useDocumentBleed; }
    prefs.pageRange = opts.pages ? String(opts.pages) : PageRange.ALL_PAGES;
    doc.exportFile(ExportFormat.PDF_TYPE, file, false);
  } finally {
    for (var s in saved) {
      if (saved.hasOwnProperty(s)) {
        try { prefs[s] = saved[s]; } catch (e2) {}
      }
    }
  }
  return file;
};`,
  }),
  id({
    id: "id.fitText",
    set: "text",
    call: "ctx.fitText",
    summary: "Shrinks a frame's whole story until it fits, never below a minimum size.",
    signature: {
      params: [
        {"name": "frame", "type": "TextFrame"},
        {"name": "opts", "type": "{ minSize?, minScale?, step? }", "optional": true, "doc": "minSize in points; else minScale of the largest size (default 0.7); step in points (default 0.5)"},
      ],
      returns: "{ fits, size, from }",
    },
    sideEffects: ["changes text sizes"],
    doc: "ctx.fitText(frame, {minSize?, minScale?, step?}) -> {fits, size, from}: shrinks the frame's whole story (all of its text, relative sizes and fixed leading kept) until it fits, not below minSize (default 70% of its largest size). Text that still doesn't fit stays overset, and Doppl's checks flag it. Never shrink frame.texts yourself: the overset rest keeps its size and comes back at full size.\nExample: frame.contents = ctx.item.email; var fit = ctx.fitText(frame); if (!fit.fits) ctx.log(\"Email too long for the card\");",
    tests: [{"name": "shrinks every letter, not only the visible ones", "inputs": {}, "script": "var d = app.documents.add();\ntry {\n  var f = d.pages[0].textFrames.add({ geometricBounds: [\"10mm\", \"10mm\", \"16mm\", \"70mm\"] });\n  f.contents = \"abdurrahman.karaosmanoglu@example.com\";\n  f.parentStory.pointSize = 12;\n  var fit = DopplLib.fitText(f, { minScale: 0.5 });\n  var sizes = f.parentStory.characters.everyItem().pointSize;\n  var same = true;\n  for (var i = 1; i < sizes.length; i++) if (sizes[i] !== sizes[0]) same = false;\n  return { fits: fit.fits, same: same, smaller: fit.size < 12, aboveMin: fit.size >= 6 };\n} finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"fits": true, "same": true, "smaller": true, "aboveMin": true}}],
    code: String.raw`/**
 * Shrinks the whole story of a frame step by step until it fits, never below the minimum (default 70% of its largest
 * size). The whole story, not frame.texts: the overset rest would keep its size and flow back in at full size.
 * Relative sizes are kept, and fixed leading shrinks with the text. Returns { fits, size, from } (largest sizes).
 */
DopplLib.fitText = function (frame, opts) {
  opts = opts || {};
  var story = frame.parentStory;
  story.recompose();
  var chars = story.characters;
  var n = chars.length;
  if (n === 0) { return { fits: true, size: 0, from: 0 }; }
  var sizes = chars.everyItem().pointSize;
  var leads = chars.everyItem().leading;
  if (!(sizes instanceof Array)) { sizes = [sizes]; }
  if (!(leads instanceof Array)) { leads = [leads]; }
  var largest = 0;
  for (var i = 0; i < sizes.length; i++) { if (sizes[i] > largest) { largest = sizes[i]; } }
  var round = function (x) { return Math.round(x * 10) / 10; };
  if (!story.overflows) { return { fits: true, size: round(largest), from: round(largest) }; }
  // Runs of characters with the same size and leading, set together.
  var runs = [];
  for (var c = 0; c < n; c++) {
    var last = runs.length ? runs[runs.length - 1] : null;
    if (last && last.size === sizes[c] && last.leading === leads[c]) { last.end = c; }
    else { runs.push({ start: c, end: c, size: sizes[c], leading: leads[c] }); }
  }
  var floor = opts.minSize ? Number(opts.minSize) : largest * (opts.minScale ? Number(opts.minScale) : 0.7);
  if (floor > largest) { floor = largest; }
  var step = opts.step ? Number(opts.step) : 0.5;
  var scale = 1;
  for (var guard = 0; story.overflows && guard < 200; guard++) {
    var next = Math.max(floor / largest, scale - step / largest);
    if (next >= scale - 1e-9) { break; }
    scale = next;
    for (var r = 0; r < runs.length; r++) {
      var range = chars.itemByRange(runs[r].start, runs[r].end);
      range.pointSize = runs[r].size * scale;
      if (typeof runs[r].leading === "number" && runs[r].leading != Leading.AUTO) { range.leading = runs[r].leading * scale; }
    }
    story.recompose();
  }
  return { fits: !story.overflows, size: round(largest * scale), from: round(largest) };
};`,
  }),
  id({
    id: "id.preflight",
    set: "preflight",
    call: "ctx.preflight",
    summary: "Rule checks: overset text, missing or changed links, missing fonts, letters a font can't draw, low-resolution images.",
    signature: { params: [{"name": "opts", "type": "{ minPpi? }", "optional": true, "doc": "default 300 ppi"}], returns: "findings [{ type, message, page, pageIndex, value }]" },
    sideEffects: [],
    doc: "ctx.preflight({minPpi}) -> findings: overset text, missing links/fonts, low-res images.\nExample: var findings = ctx.preflight({ minPpi: 300 });",
    tests: [{"name": "finds overset text", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.pagesPerDocument = 5;\ntry {\n  var f = d.pages[0].textFrames.add({ geometricBounds: [\"10mm\", \"10mm\", \"12mm\", \"30mm\"] });\n  f.contents = \"This text is far too long for its tiny frame and overflows.\";\n  var findings = DopplLib.preflight(d, {});\n  var overset = false;\n  for (var i = 0; i < findings.length; i++) if (findings[i].type === \"overset\") overset = true;\n  return { overset: overset };\n} finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"overset": true}}],
    code: String.raw`/**
 * Rule-level preflight: overset text, missing/modified links, missing fonts, low-resolution images.
 * Returns [{ type, message, page, pageIndex, value }].
 */
/** Letters a font has no glyph for, from InDesign's "Missing glyph" preflight rule: [{ message, page }], once per letter and font. */
DopplLib.missingGlyphs = function (doc) {
  var out = [];
  var profile = null, proc = null;
  try {
    profile = app.preflightProfiles.add();
    profile.name = "Doppl letters " + new Date().getTime();
    var rule = profile.preflightProfileRules.add("ADBE_MissingGlyph");
    rule.flag = PreflightRuleFlag.RETURN_AS_ERROR;
    proc = app.preflightProcesses.add(doc, profile);
    proc.waitForProcess(30);
    var results = proc.aggregatedResults[2];
    var seen = {};
    var stories = DopplLib.all(doc.stories);
    for (var i = 0; i < results.length && out.length < 20; i++) {
      // [3, "LATIN SMALL LETTER S WITH CEDILLA (UID: 15f)", "1", ...]: the letter and its page.
      var m = /\(UID: ([0-9a-f]+)\)/i.exec(String(results[i][1]));
      if (results[i][0] !== 3 || !m) { continue; }
      var ch = String.fromCharCode(parseInt(m[1], 16));
      var font = "";
      for (var s = 0; s < stories.length && !font; s++) {
        try {
          var at = stories[s].contents.indexOf(ch);
          if (at >= 0) { font = DopplLib.fontName(stories[s].characters[at].appliedFont).replace(/\t/g, " "); }
        } catch (e1) {}
      }
      if (seen[ch + font]) { continue; }
      seen[ch + font] = true;
      var page = null;
      try { page = doc.pages.itemByName(String(results[i][2])); if (!page.isValid) { page = null; } } catch (e2) { page = null; }
      out.push({ message: (font || "The font") + " has no \u201C" + ch + "\u201D: it won't print right" + (page ? " on page " + page.name : ""), page: page });
    }
  } catch (e) {
  } finally {
    try { if (proc) { proc.remove(); } } catch (e3) {}
    try { if (profile) { profile.remove(); } } catch (e4) {}
  }
  return out;
};

DopplLib.preflight = function (doc, opts) {
  var minPpi = opts && opts.minPpi ? Number(opts.minPpi) : 300;
  var findings = [];
  function add(type, message, page, value) {
    var f = { type: type, message: message };
    if (page) { f.page = page.name; f.pageIndex = DopplLib.pageIndex(page); }
    if (value !== undefined) { f.value = value; }
    findings.push(f);
  }

  // Overset text: a story overflows when its last frame can't hold the rest.
  var stories = DopplLib.all(doc.stories);
  for (var i = 0; i < stories.length; i++) {
    var st = stories[i];
    try {
      if (!st.overflows) { continue; }
      var tc = st.textContainers;
      var last = tc.length ? tc[tc.length - 1] : null;
      var p = last ? DopplLib.pageOf(last) : null;
      add("overset", "Text overflows its frame" + (p ? " on page " + p.name : " on the pasteboard"), p);
    } catch (e) {}
  }

  // Links
  var links = DopplLib.all(doc.links);
  for (var j = 0; j < links.length; j++) {
    var l = links[j];
    try {
      var lp = null;
      try { lp = DopplLib.pageOf(l.parent); } catch (e3) {}
      if (!lp) { try { lp = DopplLib.pageOf(l.parent.textContainers[0]); } catch (e4) {} }
      if (l.status == LinkStatus.LINK_MISSING || l.status == LinkStatus.LINK_INACCESSIBLE) {
        add("link-missing", "Missing link: " + l.name + (lp ? " (page " + lp.name + ")" : ""), lp);
      } else if (l.status == LinkStatus.LINK_OUT_OF_DATE) {
        add("link-modified", "Modified link: " + l.name + (lp ? " (page " + lp.name + ")" : ""), lp);
      }
    } catch (e5) {}
  }

  // Fonts: find which pages use each missing font, fall back to a document-level finding.
  var missing = {};
  var missingCount = 0;
  var fonts = DopplLib.all(doc.fonts);
  for (var k = 0; k < fonts.length; k++) {
    try {
      if (fonts[k].status != FontStatus.INSTALLED) {
        missing[fonts[k].name] = { name: fonts[k].name.replace(/\t/g, " "), pages: {}, found: false };
        missingCount++;
      }
    } catch (e6) {}
  }
  if (missingCount > 0) {
    for (var s = 0; s < stories.length; s++) {
      var ranges;
      try { ranges = DopplLib.all(stories[s].textStyleRanges); } catch (e7) { continue; }
      for (var r = 0; r < ranges.length; r++) {
        try {
          var fname = DopplLib.fontName(ranges[r].appliedFont);
          if (!missing[fname]) { continue; }
          var frames = ranges[r].parentTextFrames;
          var fp = frames && frames.length ? DopplLib.pageOf(frames[0]) : null;
          if (fp && !missing[fname].pages[fp.name]) {
            missing[fname].pages[fp.name] = true;
            missing[fname].found = true;
            add("font-missing", "Missing font: " + missing[fname].name, fp);
          }
        } catch (e8) {}
      }
    }
    for (var mk in missing) {
      if (Object.prototype.hasOwnProperty.call(missing, mk) && !missing[mk].found) {
        add("font-missing", "Missing font: " + missing[mk].name, null);
      }
    }
  }

  // Letters the font can't draw ("ş" in a font without Turkish letters): InDesign's own preflight rule finds them.
  var glyphs = DopplLib.missingGlyphs(doc);
  for (var mg = 0; mg < glyphs.length; mg++) add("glyph-missing", glyphs[mg].message, glyphs[mg].page);

  // Low-resolution images
  var graphics = doc.allGraphics;
  for (var g = 0; g < graphics.length; g++) {
    try {
      var gr = graphics[g];
      if (gr.constructor.name !== "Image") { continue; }
      // A missing image's resolution comes from its proxy; the missing link is reported above.
      try {
        if (gr.itemLink.status == LinkStatus.LINK_MISSING || gr.itemLink.status == LinkStatus.LINK_INACCESSIBLE) { continue; }
      } catch (e11) {}
      var ppi = gr.effectivePpi;
      var eff = Math.round(Math.min(ppi[0], ppi[1]));
      if (eff < minPpi) {
        var gp = DopplLib.pageOf(gr);
        var gname = "";
        try { gname = gr.itemLink.name; } catch (e9) { gname = "An image"; }
        add("low-res", gname + " is " + eff + " ppi" + (gp ? " on page " + gp.name : ""), gp, eff);
      }
    } catch (e10) {}
  }

  // Object checks, in points: text frames running past the page edge, and images that cross the page
  // edge but stop before the bleed. The spine side of facing pages is skipped (spreads cross it).
  var oldUnit = app.scriptPreferences.measurementUnit;
  app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
  try {
    var dp = doc.documentPreferences;
    var tol = 0.5;
    var reported = 0;
    var objPages = DopplLib.all(doc.pages);
    for (var pi = 0; pi < objPages.length && reported < 200; pi++) {
      var pg = objPages[pi];
      var pb = pg.bounds;
      var side = pg.side;
      var leftSpine = dp.facingPages && side == PageSideOptions.RIGHT_HAND;
      var rightSpine = dp.facingPages && side == PageSideOptions.LEFT_HAND;
      var bleed = {
        top: dp.documentBleedTopOffset,
        bottom: dp.documentBleedBottomOffset,
        left: dp.facingPages && side == PageSideOptions.LEFT_HAND ? dp.documentBleedOutsideOrRightOffset : dp.documentBleedInsideOrLeftOffset,
        right: dp.facingPages && side == PageSideOptions.LEFT_HAND ? dp.documentBleedInsideOrLeftOffset : dp.documentBleedOutsideOrRightOffset
      };
      var edges = ["right", "left", "bottom", "top"];
      var items = pg.allPageItems;
      for (var ii = 0; ii < items.length && ii < 2000; ii++) {
        var it = items[ii];
        var gb;
        try { gb = it.geometricBounds; } catch (e12) { continue; }
        var over = { top: pb[0] - gb[0], left: pb[1] - gb[1], bottom: gb[2] - pb[2], right: gb[3] - pb[3] };
        var kind = it.constructor.name;
        var hasImage = false;
        try { hasImage = (kind === "Rectangle" || kind === "Polygon" || kind === "Oval") && it.allGraphics.length > 0; } catch (e13) {}
        for (var ei = 0; ei < edges.length; ei++) {
          var ed = edges[ei];
          if ((ed === "left" && leftSpine) || (ed === "right" && rightSpine) || over[ed] <= tol) { continue; }
          if (kind === "TextFrame") {
            add("off-page", "A text frame on page " + pg.name + " runs past the " + ed + " page edge", pg);
            reported++;
            break;
          }
          if (hasImage && bleed[ed] <= tol) {
            add("short-of-bleed", "An image on page " + pg.name + " runs past the " + ed + " page edge, but the document has no bleed", pg);
            reported++;
            break;
          }
          if (hasImage && over[ed] < bleed[ed] - tol) {
            add("short-of-bleed", "An image on page " + pg.name + " crosses the " + ed + " page edge but stops " + (Math.round((bleed[ed] - over[ed]) * 0.3528 * 10) / 10) + " mm before the bleed", pg);
            reported++;
            break;
          }
        }
      }
    }
  } finally {
    app.scriptPreferences.measurementUnit = oldUnit;
  }

  return findings;
};`,
  }),
];

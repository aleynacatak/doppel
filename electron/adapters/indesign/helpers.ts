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
    id: "id.preflight",
    set: "preflight",
    call: "ctx.preflight",
    summary: "Rule checks: overset text, missing or changed links, missing fonts, low-resolution images.",
    signature: { params: [{"name": "opts", "type": "{ minPpi? }", "optional": true, "doc": "default 300 ppi"}], returns: "findings [{ type, message, page, pageIndex, value }]" },
    sideEffects: [],
    doc: "ctx.preflight({minPpi}) -> findings: overset text, missing links/fonts, low-res images.\nExample: var findings = ctx.preflight({ minPpi: 300 });",
    tests: [{"name": "finds overset text", "inputs": {}, "script": "var d = app.documents.add();\nd.documentPreferences.pagesPerDocument = 5;\ntry {\n  var f = d.pages[0].textFrames.add({ geometricBounds: [10, 10, 12, 30] });\n  f.contents = \"This text is far too long for its tiny frame and overflows.\";\n  var findings = DopplLib.preflight(d, {});\n  var overset = false;\n  for (var i = 0; i < findings.length; i++) if (findings[i].type === \"overset\") overset = true;\n  return { overset: overset };\n} finally { d.close(SaveOptions.NO); }", "checks": [], "expect": {"overset": true}}],
    code: String.raw`/**
 * Rule-level preflight: overset text, missing/modified links, missing fonts, low-resolution images.
 * Returns [{ type, message, page, pageIndex, value }].
 */
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

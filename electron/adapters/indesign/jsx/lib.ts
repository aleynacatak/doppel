// Helper library prepended to every Doppel ExtendScript (ES3: no Array.map/forEach/indexOf, no String.trim).
// Routine scripts reach these through `ctx` (see wrapRoutine in scripts.ts).
export const DOPPEL_LIB = String.raw`
var DoppelLib = {};

/** Elements of an InDesign collection; empty collections can't use everyItem(). */
DoppelLib.all = function (collection) {
  return collection.length ? collection.everyItem().getElements() : [];
};

DoppelLib.docId = function (doc) {
  try { if (doc.saved) { return doc.fullName.fsName; } } catch (e) {}
  return "untitled:" + doc.name;
};

DoppelLib.findDocument = function (docId) {
  if (app.documents.length === 0) { throw new Error("No document is open in InDesign."); }
  if (!docId) { return app.activeDocument; }
  var docs = DoppelLib.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    if (DoppelLib.docId(docs[i]) === docId) { return docs[i]; }
  }
  throw new Error("The document isn't open in InDesign anymore: " + docId.replace(/^untitled:/, ""));
};

DoppelLib.baseName = function (name) {
  return String(name).replace(/\.indd$/i, "");
};

DoppelLib.pad = function (n, width) {
  var s = String(n);
  while (s.length < width) { s = "0" + s; }
  return s;
};

DoppelLib.format = function (pattern, vars) {
  return String(pattern).replace(/\{(\w+)\}/g, function (all, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all;
  });
};

DoppelLib.safeFileName = function (s) {
  return String(s).replace(/[\/\\:\*\?"<>\|]/g, "-");
};

DoppelLib.ensureFolder = function (path) {
  if (!path) { throw new Error("No output folder was chosen."); }
  var folder = new Folder(path);
  if (!folder.exists && !folder.create()) { throw new Error("Couldn't create the folder " + path); }
  return folder;
};

DoppelLib.pageIndex = function (page) {
  return page.documentOffset + 1;
};

/** Page reference usable in export page ranges. Absolute ("+3") when the document has several sections. */
DoppelLib.pageRangeRef = function (doc, page) {
  return doc.sections.length > 1 ? "+" + DoppelLib.pageIndex(page) : page.name;
};

/** "all", "" or "1-3, 5" (page positions, 1-based). */
DoppelLib.resolvePages = function (doc, spec) {
  var all = DoppelLib.all(doc.pages);
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
};

DoppelLib.pageOf = function (item) {
  try {
    var p = item.parentPage;
    if (p && p.isValid) { return p; }
  } catch (e) {}
  try {
    var q = item.parent.parentPage;
    if (q && q.isValid) { return q; }
  } catch (e2) {}
  return null;
};

/** Live area of a page as geometricBounds [top, left, bottom, right]. */
DoppelLib.marginBounds = function (page) {
  var b = page.bounds;
  var m = page.marginPreferences;
  var left = m.left, right = m.right;
  try { if (page.side == PageSideOptions.LEFT_HAND) { left = m.right; right = m.left; } } catch (e) {}
  return [b[0] + m.top, b[1] + left, b[2] - m.bottom, b[3] - right];
};

DoppelLib.savePrefs = function (prefs, keys) {
  var saved = {};
  for (var i = 0; i < keys.length; i++) {
    try { saved[keys[i]] = prefs[keys[i]]; } catch (e) {}
  }
  return saved;
};

DoppelLib.restorePrefs = function (prefs, saved) {
  for (var k in saved) {
    if (Object.prototype.hasOwnProperty.call(saved, k)) {
      try { prefs[k] = saved[k]; } catch (e) {}
    }
  }
};

DoppelLib.fontName = function (f) {
  if (typeof f === "string") { return f; }
  try { return f.name; } catch (e) { return String(f); }
};

/**
 * Rule-level preflight: overset text, missing/modified links, missing fonts, low-resolution images.
 * Returns [{ type, message, page, pageIndex, value }].
 */
DoppelLib.preflight = function (doc, opts) {
  var minPpi = opts && opts.minPpi ? Number(opts.minPpi) : 300;
  var findings = [];
  function add(type, message, page, value) {
    var f = { type: type, message: message };
    if (page) { f.page = page.name; f.pageIndex = DoppelLib.pageIndex(page); }
    if (value !== undefined) { f.value = value; }
    findings.push(f);
  }

  // Overset text: a story overflows when its last frame can't hold the rest.
  var stories = DoppelLib.all(doc.stories);
  for (var i = 0; i < stories.length; i++) {
    var st = stories[i];
    try {
      if (!st.overflows) { continue; }
      var tc = st.textContainers;
      var last = tc.length ? tc[tc.length - 1] : null;
      var p = last ? DoppelLib.pageOf(last) : null;
      add("overset", "Text overflows its frame" + (p ? " on page " + p.name : " on the pasteboard"), p);
    } catch (e) {}
  }

  // Links
  var links = DoppelLib.all(doc.links);
  for (var j = 0; j < links.length; j++) {
    var l = links[j];
    try {
      var lp = null;
      try { lp = DoppelLib.pageOf(l.parent); } catch (e3) {}
      if (!lp) { try { lp = DoppelLib.pageOf(l.parent.textContainers[0]); } catch (e4) {} }
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
  var fonts = DoppelLib.all(doc.fonts);
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
      try { ranges = DoppelLib.all(stories[s].textStyleRanges); } catch (e7) { continue; }
      for (var r = 0; r < ranges.length; r++) {
        try {
          var fname = DoppelLib.fontName(ranges[r].appliedFont);
          if (!missing[fname]) { continue; }
          var frames = ranges[r].parentTextFrames;
          var fp = frames && frames.length ? DoppelLib.pageOf(frames[0]) : null;
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
        var gp = DoppelLib.pageOf(gr);
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
    var objPages = DoppelLib.all(doc.pages);
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
};

/** The ctx object routine scripts receive. */
DoppelLib.makeContext = function (doc, input) {
  var outputs = [];
  var log = [];
  var docName = input.originalName || doc.name;
  return {
    docName: DoppelLib.baseName(docName),
    params: input.params,
    log: function (msg) { log.push(String(msg)); },
    output: function (o) { outputs.push(o); },
    resolvePages: function (spec) { return DoppelLib.resolvePages(doc, spec); },
    pageIndex: DoppelLib.pageIndex,
    pageRangeRef: function (page) { return DoppelLib.pageRangeRef(doc, page); },
    format: DoppelLib.format,
    pad: DoppelLib.pad,
    safeFileName: DoppelLib.safeFileName,
    ensureFolder: DoppelLib.ensureFolder,
    marginBounds: DoppelLib.marginBounds,
    savePrefs: DoppelLib.savePrefs,
    restorePrefs: DoppelLib.restorePrefs,
    preflight: function (opts) { return DoppelLib.preflight(doc, opts); },
    _outputs: outputs,
    _log: log
  };
};
`;

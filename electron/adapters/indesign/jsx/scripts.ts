import { routineStartMarker as ROUTINE_START } from "../../adobe/bridge";

// Every script is `function (input) { ... return data; }`; the shared Adobe bridge (adapters/adobe/bridge.ts)
// wraps it so that InDesign receives one JSON string argument and returns { ok: true, data } or { ok: false, error }.

/**
 * Wraps a routine body (the code users see under "View script") so that it:
 * - runs on the requested document with `doc`, `params` and `ctx` in scope,
 * - is one undo step in InDesign ("Doppl: <routine name>"), so a single Cmd+Z reverts it,
 * - returns rule findings from the documents the routine opened itself (checked before ctx.close closes them).
 */
export function wrapRoutine(body: string): string {
  return `function (input) {
  var doc = input.noDocument ? null : DopplLib.findDocument(input.docId);
  var ctx = DopplLib.makeContext(doc, input);
  var routine = function (doc, params, ctx) {
${ROUTINE_START}
${body}
  };
  var result = null, failure = null;
  app.doScript(function () {
    try { result = routine(doc, input.params, ctx); } catch (e) { failure = e; }
  }, ScriptLanguage.JAVASCRIPT, [], UndoModes.ENTIRE_SCRIPT, "Doppl: " + input.routineName);
  if (failure) { throw { message: String(failure.message || failure), line: failure.line }; }
  var unchecked = 0;
  try { unchecked = DopplLib.finishChecks(ctx._track); } catch (e) {}
  return {
    result: result === undefined ? null : result, outputs: ctx._outputs, log: ctx._log, values: ctx._stageOutputs,
    findings: ctx._track.findings, checked: ctx._track.checkedCount, unchecked: unchecked
  };
}`;
}

export const PROBE = String.raw`function (input) {
  return { version: app.version, documents: app.documents.length };
}`;

export const LIST_DOCUMENTS = String.raw`function (input) {
  var out = [];
  var docs = DopplLib.all(app.documents);
  var activeId = "";
  try { activeId = DopplLib.docId(app.activeDocument); } catch (e) {}
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var id = DopplLib.docId(d);
    out.push({ id: id, name: d.name, path: d.saved ? d.fullName.fsName : "", pageCount: d.pages.length, active: id === activeId });
  }
  return out;
}`;

export const INSPECT = String.raw`function (input) {
  var doc = DopplLib.findDocument(input.docId);
  var prefs = doc.documentPreferences;
  var unit = "pt";
  try {
    var u = doc.viewPreferences.horizontalMeasurementUnits;
    if (u == MeasurementUnits.MILLIMETERS) { unit = "mm"; }
    else if (u == MeasurementUnits.CENTIMETERS) { unit = "cm"; }
    else if (u == MeasurementUnits.INCHES || u == MeasurementUnits.INCHES_DECIMAL) { unit = "in"; }
    else if (u == MeasurementUnits.PIXELS) { unit = "px"; }
    else if (u == MeasurementUnits.PICAS) { unit = "pc"; }
  } catch (e) {}
  function namesOf(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      try { if (items[i].name.charAt(0) !== "[") { out.push(items[i].name); } } catch (e) {}
    }
    return out;
  }
  var links = [];
  var linkItems = DopplLib.all(doc.links);
  for (var j = 0; j < linkItems.length; j++) {
    var l = linkItems[j];
    var status = "ok";
    try {
      if (l.status == LinkStatus.LINK_MISSING) { status = "missing"; }
      else if (l.status == LinkStatus.LINK_OUT_OF_DATE) { status = "modified"; }
      else if (l.status == LinkStatus.LINK_EMBEDDED) { status = "embedded"; }
      else if (l.status == LinkStatus.LINK_INACCESSIBLE) { status = "inaccessible"; }
    } catch (e2) {}
    var lp = null;
    try { lp = DopplLib.pageOf(l.parent); } catch (e3) {}
    links.push({ name: l.name, status: status, page: lp ? lp.name : undefined });
  }
  var fonts = [];
  var fontItems = DopplLib.all(doc.fonts);
  for (var k = 0; k < fontItems.length; k++) {
    var f = fontItems[k];
    var fs = "other";
    try {
      if (f.status == FontStatus.INSTALLED) { fs = "installed"; }
      else if (f.status == FontStatus.NOT_AVAILABLE) { fs = "missing"; }
      else if (f.status == FontStatus.SUBSTITUTED) { fs = "substituted"; }
    } catch (e4) {}
    fonts.push({ name: f.name.replace(/\t/g, " "), status: fs });
  }
  return {
    id: DopplLib.docId(doc),
    name: doc.name,
    path: doc.saved ? doc.fullName.fsName : "",
    appVersion: app.version,
    pageCount: doc.pages.length,
    pageSize: { width: Math.round(prefs.pageWidth * 100) / 100, height: Math.round(prefs.pageHeight * 100) / 100, unit: unit },
    layers: namesOf(DopplLib.all(doc.layers)),
    paragraphStyles: namesOf(doc.allParagraphStyles),
    characterStyles: namesOf(doc.allCharacterStyles),
    textFrameCount: doc.textFrames.length,
    links: links,
    fonts: fonts
  };
}`;

/** Saves a copy of the document (next to the original, or in Doppl's folder) and opens it. */
export const PREPARE_COPY = String.raw`function (input) {
  var doc = DopplLib.findDocument(input.docId);
  var base = DopplLib.baseName(doc.name);
  var folder = (input.placement === "beside" && doc.saved) ? doc.filePath : DopplLib.ensureFolder(input.fallbackDir);
  var file = null;
  for (var n = 1; n < 1000; n++) {
    file = new File(folder.fsName + "/" + base + "_doppl" + (n > 1 ? "-" + n : "") + ".indd");
    if (!file.exists) { break; }
  }
  doc.saveACopy(file);
  var copy = app.open(file, input.showWindow !== false);
  return { id: DopplLib.docId(copy), name: copy.name, originalName: doc.name };
}`;

export const SAVE_DOCUMENT = String.raw`function (input) {
  var doc = DopplLib.findDocument(input.docId);
  if (doc.saved) { doc.save(); }
  return true;
}`;

export const CLOSE_DOCUMENT = String.raw`function (input) {
  var doc = DopplLib.findDocument(input.docId);
  doc.close(SaveOptions.NO);
  return true;
}`;

export const EXPORT_PAGE_PREVIEWS = String.raw`function (input) {
  var doc = DopplLib.findDocument(input.docId);
  var folder = DopplLib.ensureFolder(input.outDir);
  var prefs = app.pngExportPreferences;
  var saved = DopplLib.savePrefs(prefs, ["exportResolution", "pngExportRange", "pageString", "exportingSpread", "pngQuality", "transparentBackground", "antiAlias"]);
  var out = [];
  try {
    prefs.exportResolution = input.ppi || 72;
    prefs.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE;
    prefs.exportingSpread = false;
    prefs.pngQuality = PNGQualityEnum.MEDIUM;
    prefs.transparentBackground = false;
    prefs.antiAlias = true;
    var pages = DopplLib.all(doc.pages);
    for (var i = 0; i < input.pageIndexes.length; i++) {
      var idx = input.pageIndexes[i];
      if (idx < 1 || idx > pages.length) { continue; }
      prefs.pageString = DopplLib.pageRangeRef(doc, pages[idx - 1]);
      var file = new File(folder.fsName + "/preview-" + idx + ".png");
      doc.exportFile(ExportFormat.PNG_FORMAT, file, false);
      out.push({ pageIndex: idx, page: pages[idx - 1].name, file: file.fsName });
    }
  } finally {
    DopplLib.restorePrefs(prefs, saved);
  }
  return out;
}`;

export const RULE_CHECKS = String.raw`function (input) {
  // Only the document Doppl names: never whatever happens to be active.
  if (!input.docId) { throw new Error("No document to check."); }
  var doc = DopplLib.findDocument(input.docId);
  return DopplLib.preflight(doc, { minPpi: input.minPpi });
}`;

export const PDF_PRESETS = String.raw`function (input) {
  var out = [];
  var presets = DopplLib.all(app.pdfExportPresets);
  for (var i = 0; i < presets.length; i++) { out.push(presets[i].name); }
  return out;
}`;

export const MISSING_FONTS = String.raw`function (input) {
  var installed = {};
  var fams = app.fonts.length ? app.fonts.everyItem().fontFamily : [];
  for (var i = 0; i < fams.length; i++) { installed[String(fams[i]).toLowerCase()] = true; }
  var missing = [];
  for (var j = 0; j < input.families.length; j++) {
    if (!installed[String(input.families[j]).toLowerCase()]) { missing.push(input.families[j]); }
  }
  return missing;
}`;

export const OPEN_PAGE = String.raw`function (input) {
  var doc;
  try {
    doc = DopplLib.findDocument(input.docId);
  } catch (e) {
    // Copies of read-only runs are closed afterwards; reopen the file.
    var file = new File(input.docId);
    if (/^untitled:/.test(input.docId) || !file.exists) { throw e; }
    doc = app.open(file);
  }
  var win = doc.layoutWindows.length ? doc.layoutWindows[0] : doc.windows.add();
  try { win.bringToFront(); } catch (e) {}
  var pages = DopplLib.all(doc.pages);
  if (input.pageIndex && input.pageIndex <= pages.length) { win.activePage = pages[input.pageIndex - 1]; }
  return true;
}`;

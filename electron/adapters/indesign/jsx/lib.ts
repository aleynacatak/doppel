// Helper library prepended to every Doppl ExtendScript (ES3: no Array.map/forEach/indexOf, no String.trim).
// Routine scripts reach these through `ctx` (see wrapRoutine in scripts.ts).
export const DOPPL_LIB = String.raw`
var DopplLib = {};

/** Elements of an InDesign collection; empty collections can't use everyItem(). */
DopplLib.all = function (collection) {
  return collection.length ? collection.everyItem().getElements() : [];
};

DopplLib.docId = function (doc) {
  try { if (doc.saved) { return doc.fullName.fsName; } } catch (e) {}
  return "untitled:" + doc.name;
};

DopplLib.findDocument = function (docId) {
  if (app.documents.length === 0) { throw new Error("No document is open in InDesign."); }
  if (!docId) { return app.activeDocument; }
  var docs = DopplLib.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    if (DopplLib.docId(docs[i]) === docId) { return docs[i]; }
  }
  throw new Error("The document isn't open in InDesign anymore: " + docId.replace(/^untitled:/, ""));
};

DopplLib.baseName = function (name) {
  return String(name).replace(/\.indd$/i, "");
};

DopplLib.pad = function (n, width) {
  var s = String(n);
  while (s.length < width) { s = "0" + s; }
  return s;
};

DopplLib.format = function (pattern, vars) {
  return String(pattern).replace(/\{(\w+)\}/g, function (all, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all;
  });
};

DopplLib.safeFileName = function (s) {
  return String(s).replace(/[\/\\:\*\?"<>\|]/g, "-");
};

DopplLib.ensureFolder = function (path) {
  if (!path) { throw new Error("No output folder was chosen."); }
  var folder = new Folder(path);
  if (!folder.exists && !folder.create()) { throw new Error("Couldn't create the folder " + path); }
  return folder;
};

DopplLib.pageOf = function (item) {
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

DopplLib.fontName = function (f) {
  if (typeof f === "string") { return f; }
  try { return f.name; } catch (e) { return String(f); }
};

/**
 * What a routine opened, for the quality checks: documents open before it ran are the designer's (and the stage's),
 * the rest are the routine's. ctx.close checks a document before it closes; DopplLib.finishChecks the ones left open.
 */
DopplLib.makeTrack = function () {
  var before = {};
  var docs = DopplLib.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    try { before[DopplLib.docId(docs[i])] = true; } catch (e) {}
  }
  return { before: before, opened: [], findings: [], checked: {}, checkedCount: 0 };
};

/** Rule checks of one of the routine's documents, added to the item's findings. */
DopplLib.checkDocument = function (track, d) {
  var id = DopplLib.docId(d);
  if (track.checked[id]) { return; }
  var found = DopplLib.preflight(d, {});
  for (var i = 0; i < found.length; i++) { track.findings.push(found[i]); }
  track.checked[id] = true;
  track.checkedCount++;
};

/**
 * After the routine: checks the documents it opened or made and left open, closes the hidden ones ctx.open made,
 * and counts the ones it closed itself before they were checked.
 */
DopplLib.finishChecks = function (track) {
  var docs = DopplLib.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    try {
      if (!track.before[DopplLib.docId(docs[i])]) { DopplLib.checkDocument(track, docs[i]); }
    } catch (e) {}
  }
  var unchecked = 0;
  for (var j = 0; j < track.opened.length; j++) {
    var o = track.opened[j];
    var open = false;
    try { open = o.doc.isValid; } catch (e2) {}
    if (open && o.hidden) { try { o.doc.close(SaveOptions.NO); } catch (e3) {} }
    if (!track.checked[o.id]) { unchecked++; }
  }
  return unchecked;
};

/** The ctx object routine scripts receive. */
DopplLib.makeContext = function (doc, input) {
  var outputs = [];
  var log = [];
  var stageOutputs = {};
  var docName = input.originalName || (doc ? doc.name : "");
  var track = DopplLib.makeTrack();
  return {
    item: input.item === undefined ? null : input.item,
    itemIndex: input.itemIndex,
    matched: input.matched || {},
    workDir: input.workDir,
    stageOutput: function (key, value) {
      if (!stageOutputs[key]) { stageOutputs[key] = []; }
      stageOutputs[key].push(value);
    },
    _stageOutputs: stageOutputs,
    docName: DopplLib.baseName(docName),
    params: input.params,
    log: function (msg) { log.push(String(msg)); },
    output: function (o) { outputs.push(o); },
    resolvePages: function (spec) { return DopplLib.resolvePages(doc, spec); },
    pageIndex: DopplLib.pageIndex,
    pageRangeRef: function (page) { return DopplLib.pageRangeRef(doc, page); },
    format: DopplLib.format,
    pad: DopplLib.pad,
    safeFileName: DopplLib.safeFileName,
    ensureFolder: DopplLib.ensureFolder,
    marginBounds: DopplLib.marginBounds,
    savePrefs: DopplLib.savePrefs,
    restorePrefs: DopplLib.restorePrefs,
    preflight: function (opts) { return DopplLib.preflight(doc, opts); },
    open: function (path, opts) { return DopplLib.open(track, path, opts); },
    close: function (d) { return DopplLib.close(track, d); },
    exportPdf: function (d, path, opts) { return DopplLib.exportPdf(d, path, opts); },
    fitText: function (frame, opts) { return DopplLib.fitText(frame, opts); },
    _outputs: outputs,
    _log: log,
    _track: track
  };
};
`;

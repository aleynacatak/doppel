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

/** The ctx object routine scripts receive. */
DopplLib.makeContext = function (doc, input) {
  var outputs = [];
  var log = [];
  var stageOutputs = {};
  var docName = input.originalName || (doc ? doc.name : "");
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
    _outputs: outputs,
    _log: log
  };
};
`;

// Helper library prepended to every Doppl script for Photoshop (ExtendScript is ES3: no Array.map/forEach/indexOf,
// no String.trim). Routines call the global helpers below (openDocument, findLayer, …) and `ctx`.
//
// Safety: Doppl never saves over or closes a document the designer opened. A routine works on documents Doppl
// opened itself or on duplicates ("… (Doppl)"), exports only into folders picked for the run (or the stage's
// working folder), and Doppl closes its own documents without saving when the stage ends.
export const DOPPL_PS_LIB = String.raw`
var DopplPS = { state: null };

DopplPS.all = function (collection) {
  var out = [];
  for (var i = 0; i < collection.length; i++) { out.push(collection[i]); }
  return out;
};

DopplPS.pathOf = function (doc) {
  try { return doc.fullName.fsName; } catch (e) { return null; }
};

DopplPS.docId = function (doc) {
  var p = DopplPS.pathOf(doc);
  return p ? p : "untitled:" + doc.name;
};

DopplPS.baseName = function (name) {
  return String(name).replace(/\.[^.\/]+$/, "");
};

DopplPS.findDocument = function (docId) {
  var docs = app.documents;
  for (var i = 0; i < docs.length; i++) {
    if (DopplPS.docId(docs[i]) === docId) { return docs[i]; }
  }
  throw new Error("The document isn't open in Photoshop anymore.");
};

DopplPS.findByName = function (name) {
  var docs = app.documents;
  for (var i = 0; i < docs.length; i++) {
    if (docs[i].name === name) { return docs[i]; }
  }
  return null;
};

/** Documents Doppl opened or duplicated during this stage: { name, path }. */
DopplPS.isOwned = function (doc) {
  var owned = DopplPS.state ? DopplPS.state.owned : [];
  var p = DopplPS.pathOf(doc);
  for (var i = 0; i < owned.length; i++) {
    if (owned[i].path && p && owned[i].path === p) { return true; }
    if (!owned[i].path && !p && owned[i].name === doc.name) { return true; }
  }
  return false;
};

DopplPS.own = function (doc) {
  if (!DopplPS.isOwned(doc)) { DopplPS.state.owned.push({ name: doc.name, path: DopplPS.pathOf(doc) }); }
};

DopplPS.disown = function (doc) {
  var p = DopplPS.pathOf(doc), keep = [], owned = DopplPS.state.owned;
  for (var i = 0; i < owned.length; i++) {
    var same = (owned[i].path && p && owned[i].path === p) || (!owned[i].path && !p && owned[i].name === doc.name);
    if (!same) { keep.push(owned[i]); }
  }
  DopplPS.state.owned = keep;
};

DopplPS.isAllowed = function (fsPath) {
  var target = new File(fsPath).fsName;
  var folders = DopplPS.state ? DopplPS.state.allowed : [];
  for (var i = 0; i < folders.length; i++) {
    var f = new Folder(folders[i]).fsName.replace(/\/+$/, "");
    if (target.indexOf(f + "/") === 0) { return true; }
  }
  return false;
};

DopplPS.ensureFolder = function (folder) {
  if (!folder.exists) {
    if (folder.parent && !folder.parent.exists) { DopplPS.ensureFolder(folder.parent); }
    folder.create();
  }
};

DopplPS.uniqueFile = function (folderPath, base, ext) {
  var file = new File(folderPath + "/" + base + ext);
  var n = 2;
  while (file.exists) { file = new File(folderPath + "/" + base + "-" + n + ext); n++; }
  return file;
};

DopplPS.layersOf = function (container) {
  return DopplPS.all(container.layers);
};

DopplPS.searchLayer = function (container, name) {
  var layers = DopplPS.layersOf(container);
  for (var i = 0; i < layers.length; i++) { if (layers[i].name === name) { return layers[i]; } }
  for (var j = 0; j < layers.length; j++) {
    if (layers[j].typename === "LayerSet") {
      var found = DopplPS.searchLayer(layers[j], name);
      if (found) { return found; }
    }
  }
  return null;
};

DopplPS.activate = function (layer) {
  var doc = layer.parent;
  while (doc && doc.typename !== "Document") { doc = doc.parent; }
  if (doc) { app.activeDocument = doc; doc.activeLayer = layer; }
  return doc;
};

DopplPS.fontInstalled = function (postScriptName) {
  try { app.fonts.getByName(postScriptName); return true; } catch (e) { return false; }
};

DopplPS.finding = function (type, message) {
  DopplPS.state.findings.push({ type: type, message: message });
};

DopplPS.format = function (pattern, vars) {
  return String(pattern).replace(/\{(\w+)\}/g, function (all, key) {
    return vars && vars.hasOwnProperty(key) ? String(vars[key]) : all;
  });
};

DopplPS.safeFileName = function (s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, "-").replace(/^\s+|\s+$/g, "");
};

DopplPS.makeContext = function (input) {
  DopplPS.state = {
    owned: input.owned || [],
    allowed: input.allowedFolders || [],
    files: [],
    outputs: {},
    findings: [],
    log: [],
    reported: []
  };
  return {
    params: input.params || {},
    item: input.item === undefined ? null : input.item,
    itemIndex: input.itemIndex,
    stages: input.stages || {},
    workDir: input.workDir,
    log: function (message) { DopplPS.state.log.push(String(message)); },
    /** Adds a value to one of the stage's named outputs, e.g. ctx.output("files", path). */
    output: function (key, value) {
      if (!DopplPS.state.outputs[key]) { DopplPS.state.outputs[key] = []; }
      DopplPS.state.outputs[key].push(value);
    },
    /** Shows a document (default: the active one) as a result with a preview. */
    report: function (label, doc) {
      var d = doc || app.activeDocument;
      DopplPS.state.reported.push({ label: String(label || d.name), name: d.name });
    },
    format: DopplPS.format,
    safeFileName: DopplPS.safeFileName,
    join: function (folder, name) { return String(folder).replace(/\/+$/, "") + "/" + String(name); },
    fileName: function (path) { return decodeURI(new File(path).name); },
    baseName: function (path) { return DopplPS.baseName(decodeURI(new File(path).name)); }
  };
};

/** Opens a file. If the designer already has it open, works on a duplicate so their document stays untouched. */
function openDocument(path) {
  var file = new File(path);
  if (!file.exists) {
    DopplPS.finding("file-missing", "File not found: " + decodeURI(file.name));
    throw new Error('File not found: "' + decodeURI(file.name) + '"');
  }
  var docs = DopplPS.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    if (DopplPS.pathOf(docs[i]) === file.fsName) {
      if (DopplPS.isOwned(docs[i])) { app.activeDocument = docs[i]; return docs[i]; }
      app.activeDocument = docs[i];
      var dup = docs[i].duplicate(DopplPS.baseName(docs[i].name) + " (Doppl)");
      DopplPS.own(dup);
      return dup;
    }
  }
  var doc = app.open(file);
  DopplPS.own(doc);
  return doc;
}

/** A layer by name (searched in every group) or by path "Group/Sub/Layer". */
function findLayer(nameOrPath, container) {
  var root = container || app.activeDocument;
  var spec = String(nameOrPath);
  var layer = null;
  if (spec.indexOf("/") >= 0) {
    var parts = spec.split("/"), current = root;
    for (var i = 0; i < parts.length && current; i++) {
      var next = null, layers = DopplPS.layersOf(current);
      for (var j = 0; j < layers.length; j++) { if (layers[j].name === parts[i]) { next = layers[j]; break; } }
      current = next;
    }
    layer = current;
  } else {
    layer = DopplPS.searchLayer(root, spec);
  }
  if (!layer) { throw new Error('Layer "' + spec + '" not found in "' + (root.name || "the document") + '"'); }
  return layer;
}

/** Replaces the contents of a Smart Object layer with an image or document file. */
function replaceSmartObject(layer, path) {
  if (layer.kind !== LayerKind.SMARTOBJECT) { throw new Error('"' + layer.name + '" isn\'t a Smart Object layer'); }
  var file = new File(path);
  if (!file.exists) {
    DopplPS.finding("file-missing", "Image not found: " + decodeURI(file.name));
    throw new Error('File not found: "' + decodeURI(file.name) + '"');
  }
  var doc = DopplPS.activate(layer);
  var desc = new ActionDescriptor();
  desc.putPath(charIDToTypeID("null"), file);
  executeAction(stringIDToTypeID("placedLayerReplaceContents"), desc, DialogModes.NO);
  return doc.activeLayer;
}

/** Sets the text of a text layer and reports fonts that aren't installed. */
function setTextLayer(layer, text) {
  if (layer.kind !== LayerKind.TEXT) { throw new Error('"' + layer.name + '" isn\'t a text layer'); }
  layer.textItem.contents = String(text);
  var font = "";
  try { font = layer.textItem.font; } catch (e) {}
  if (font && !DopplPS.fontInstalled(font)) {
    DopplPS.finding("font-missing", 'Font "' + font + '" used in "' + layer.name + '" isn\'t installed');
  }
  return layer;
}

function setLayerVisible(layer, visible) {
  layer.visible = !!visible;
  return layer;
}

/** Exports the active document as PNG, JPG or TIFF (a copy; the document itself isn't saved). quality: 0–100 (JPG). */
function exportImage(path, format, quality) {
  var doc = app.activeDocument;
  var file = new File(path);
  if (!DopplPS.isAllowed(file.fsName)) {
    throw new Error("Doppl can only save into the folders picked for this run (or the stage's working folder).");
  }
  DopplPS.ensureFolder(file.parent);
  var fmt = String(format || file.name.replace(/^.*\./, "")).toLowerCase();
  var opts;
  if (fmt === "png") {
    opts = new PNGSaveOptions();
  } else if (fmt === "jpg" || fmt === "jpeg") {
    opts = new JPEGSaveOptions();
    var q = quality === undefined || quality === null ? 85 : Number(quality);
    opts.quality = Math.max(0, Math.min(12, Math.round(q / 100 * 12)));
    opts.embedColorProfile = true;
    opts.formatOptions = FormatOptions.STANDARDBASELINE;
    opts.matte = MatteType.NONE;
  } else if (fmt === "tif" || fmt === "tiff") {
    opts = new TiffSaveOptions();
  } else {
    throw new Error('exportImage supports "png", "jpg" and "tif", not "' + fmt + '"');
  }
  var source = doc, temp = null;
  var isJpg = fmt === "jpg" || fmt === "jpeg";
  var needsRgb = (fmt === "png" || isJpg) && doc.mode !== DocumentMode.RGB && doc.mode !== DocumentMode.GRAYSCALE &&
    !(isJpg && doc.mode === DocumentMode.CMYK);
  var needs8Bit = isJpg ? doc.bitsPerChannel !== BitsPerChannelType.EIGHT : doc.bitsPerChannel === BitsPerChannelType.THIRTYTWO;
  if (needsRgb || needs8Bit) {
    temp = doc.duplicate(DopplPS.baseName(doc.name) + " (Doppl export)");
    if (needs8Bit) { temp.bitsPerChannel = BitsPerChannelType.EIGHT; }
    if (needsRgb) { temp.changeMode(ChangeMode.RGB); }
    source = temp;
  }
  try {
    source.saveAs(file, opts, true, Extension.LOWERCASE);
  } finally {
    if (temp) { temp.close(SaveOptions.DONOTSAVECHANGES); app.activeDocument = doc; }
  }
  DopplPS.state.files.push(file.fsName);
  return file.fsName;
}

/** Saves a PSD copy of the active document with a "_doppl" suffix, next to its file or in a picked folder. Never overwrites. */
function saveCopy(folderPath) {
  var doc = app.activeDocument;
  var source = DopplPS.pathOf(doc);
  var folder = folderPath ? new Folder(folderPath) : (source ? new File(source).parent : null);
  if (!folder) { throw new Error("This document has never been saved; pass a folder picked for the run to saveCopy()."); }
  if (folderPath && !DopplPS.isAllowed(folder.fsName + "/x")) {
    throw new Error("Doppl can only save into the folders picked for this run.");
  }
  DopplPS.ensureFolder(folder);
  var base = DopplPS.baseName(source ? decodeURI(new File(source).name) : doc.name).replace(/ \(Doppl[^)]*\)$/, "");
  var file = DopplPS.uniqueFile(folder.fsName, base + "_doppl", ".psd");
  doc.saveAs(file, new PhotoshopSaveOptions(), true, Extension.LOWERCASE);
  DopplPS.state.files.push(file.fsName);
  return file.fsName;
}

/** Closes a document Doppl opened (default: the active one) without saving. */
function closeWithoutSaving(doc) {
  var d = doc || app.activeDocument;
  if (!DopplPS.isOwned(d)) { throw new Error("Doppl only closes documents it opened itself."); }
  DopplPS.disown(d);
  d.close(SaveOptions.DONOTSAVECHANGES);
}
`;

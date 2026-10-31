// Helper library prepended to every Doppl script for Photoshop (ExtendScript is ES3: no Array.map/forEach/indexOf,
// no String.trim). Routines call the global helpers below (openDocument, findLayer, …) and `ctx`.
//
// Safety: Doppl never saves over or closes a document the designer opened. A routine works on documents Doppl
// opened itself or on duplicates ("… (Doppl)"), exports only into the stage's working folder (the designer's files
// and folders are read-only), and Doppl closes its own documents without saving when the stage ends.
export const DOPPL_PS_RUNTIME = String.raw`
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
    matched: input.matched || {},
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
    /** A file from a list (e.g. params.cutouts) by name: exact, any case, or without extension. */
    findFile: function (list, name) {
      var want = String(name).toLowerCase(), wantStem = want.replace(/\.[^.\/]+$/, "");
      var items = list || [];
      var best = null;
      for (var i = 0; i < items.length; i++) {
        var p = typeof items[i] === "string" ? items[i] : items[i] && items[i].path;
        if (!p) { continue; }
        var n = decodeURI(new File(p).name).toLowerCase();
        if (n === want) { return p; }
        if (!best && n.replace(/\.[^.\/]+$/, "") === wantStem) { best = p; }
      }
      if (!best) { throw new Error('No file named "' + name + '" among ' + items.length + " files"); }
      return best;
    },
    baseName: function (path) { return DopplPS.baseName(decodeURI(new File(path).name)); }
  };
};

// ---- Image helpers: cut-outs and colors ----

/** "#RRGGBB" (or "#RGB") or { r, g, b } (0–255) as a Photoshop SolidColor. */
DopplPS.toSolidColor = function (color) {
  var c = new SolidColor();
  if (typeof color === "string") {
    var hex = color.replace(/^#/, "");
    if (hex.length === 3) { hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2); }
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) { throw new Error('"' + color + '" isn\'t a color like #A1B2C3'); }
    c.rgb.hexValue = hex.toUpperCase();
  } else if (color && color.r !== undefined) {
    c.rgb.red = color.r; c.rgb.green = color.g; c.rgb.blue = color.b;
  } else {
    throw new Error("A color must be like \"#A1B2C3\" or { r, g, b }.");
  }
  return c;
};

DopplPS.hex = function (r, g, b) {
  function h(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length < 2 ? "0" + s : s; }
  return ("#" + h(r) + h(g) + h(b)).toUpperCase();
};

/** The color of one pixel of the document (all visible layers). */
DopplPS.colorAt = function (doc, x, y) {
  var sampler = doc.colorSamplers.add([UnitValue(x + 0.5, "px"), UnitValue(y + 0.5, "px")]);
  try {
    var c = sampler.color.rgb;
    return { r: c.red, g: c.green, b: c.blue };
  } finally {
    sampler.remove();
  }
};

/**
 * Magic wand at a point (anti-aliased; contiguous unless contiguous === false, which selects that color everywhere);
 * add = true adds to the current selection.
 */
DopplPS.wandAt = function (x, y, tolerance, add, contiguous) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
  desc.putReference(charIDToTypeID("null"), ref);
  var point = new ActionDescriptor();
  point.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), x);
  point.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), y);
  desc.putObject(charIDToTypeID("T   "), charIDToTypeID("Pnt "), point);
  desc.putInteger(charIDToTypeID("Tlrn"), tolerance);
  desc.putBoolean(charIDToTypeID("AntA"), true);
  desc.putBoolean(charIDToTypeID("Cntg"), contiguous !== false);
  executeAction(charIDToTypeID(add ? "AddT" : "setd"), desc, DialogModes.NO);
};

/** The document a layer is in. */
DopplPS.documentOf = function (layer) {
  var p = layer.parent;
  while (p && p.typename !== "Document") { p = p.parent; }
  return p;
};

DopplPS.targetLayerRef = function () {
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
  return ref;
};

DopplPS.maskRef = function () {
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
  return ref;
};

/** True when the active layer has a layer mask. */
DopplPS.hasLayerMask = function () {
  return executeActionGet(DopplPS.targetLayerRef()).getBoolean(stringIDToTypeID("hasUserMask"));
};

/** Deletes the active layer's layer mask (without applying it). */
DopplPS.deleteLayerMask = function () {
  var desc = new ActionDescriptor();
  desc.putReference(charIDToTypeID("null"), DopplPS.maskRef());
  executeAction(charIDToTypeID("Dlt "), desc, DialogModes.NO);
};

/** Adds a layer mask to the active layer that reveals the current selection (or everything without one). */
DopplPS.addLayerMask = function (revealSelection) {
  var desc = new ActionDescriptor();
  desc.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
  desc.putReference(charIDToTypeID("At  "), DopplPS.maskRef());
  desc.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID(revealSelection ? "RvlS" : "RvlA"));
  executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);
};

DopplPS.px = function (bounds) {
  return [bounds[0].as("px"), bounds[1].as("px"), bounds[2].as("px"), bounds[3].as("px")];
};

`;

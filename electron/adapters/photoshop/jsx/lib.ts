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
    /** A file from a list (e.g. ctx.stages.s1.outputs.files) by name: exact, any case, or without extension. */
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

/**
 * Saves a PSD copy of the active document. With fileName (e.g. a SKU), it is saved as "<fileName>.psd" in folderPath
 * (a folder picked for the run); otherwise as "<name>_doppl.psd" next to its file. Never overwrites a file:
 * an existing name gets "-2", "-3"…
 */
function saveCopy(folderPath, fileName) {
  var doc = app.activeDocument;
  var source = DopplPS.pathOf(doc);
  if (fileName && !folderPath) { throw new Error("saveCopy(folder, fileName): give the folder (a folder picked for the run) as well."); }
  var folder = folderPath ? new Folder(folderPath) : (source ? new File(source).parent : null);
  if (!folder) { throw new Error("This document has never been saved; pass a folder picked for the run to saveCopy()."); }
  if (folderPath && !DopplPS.isAllowed(folder.fsName + "/x")) {
    throw new Error("Doppl can only save into the folders picked for this run.");
  }
  DopplPS.ensureFolder(folder);
  var base = fileName
    ? DopplPS.safeFileName(String(fileName).replace(/\.psd$/i, ""))
    : DopplPS.baseName(source ? decodeURI(new File(source).name) : doc.name).replace(/ \(Doppl[^)]*\)$/, "") + "_doppl";
  var file = DopplPS.uniqueFile(folder.fsName, base, ".psd");
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

/** Magic wand at a point (contiguous, anti-aliased); add = true adds to the current selection. */
DopplPS.wandAt = function (x, y, tolerance, add) {
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
  desc.putBoolean(charIDToTypeID("Cntg"), true);
  executeAction(charIDToTypeID(add ? "AddT" : "setd"), desc, DialogModes.NO);
};

/**
 * Removes a plain white (or near-white) background that touches the image's corners and makes it transparent.
 * White areas inside the subject stay, because only white connected to the corners is removed.
 * tolerance: 0–255 (default 24). Works on the active layer of the document (default: the active document).
 */
function removeWhiteBackground(doc, tolerance) {
  var d = doc || app.activeDocument;
  app.activeDocument = d;
  var tol = tolerance === undefined || tolerance === null ? 24 : Number(tolerance);
  var layer = d.activeLayer;
  if (layer.isBackgroundLayer) { layer.isBackgroundLayer = false; }
  var w = Math.round(d.width.as("px")), h = Math.round(d.height.as("px"));
  var corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  var picked = 0;
  for (var i = 0; i < corners.length; i++) {
    var c = DopplPS.colorAt(d, corners[i][0], corners[i][1]);
    if (c.r >= 255 - tol && c.g >= 255 - tol && c.b >= 255 - tol) {
      DopplPS.wandAt(corners[i][0], corners[i][1], tol, picked > 0);
      picked++;
    }
  }
  if (picked === 0) { return { removed: false }; }
  d.selection.clear();
  d.selection.deselect();
  return { removed: true };
}

/** Crops the document to its visible content (transparent edges are cut off). */
function trimTransparent(doc) {
  var d = doc || app.activeDocument;
  app.activeDocument = d;
  d.trim(TrimType.TRANSPARENT, true, true, true, true);
  return d;
}

/**
 * The dominant color of a document or image file, ignoring transparent pixels: { hex, r, g, b, share }, where
 * share is the part of the visible pixels with that color (0–1). options.ignoreWhite skips near-white pixels.
 * Reads a small copy of the image; the source isn't changed.
 */
function dominantColor(source, options) {
  var opts = options || {};
  var src = typeof source === "string" ? openDocument(source) : (source || app.activeDocument);
  app.activeDocument = src;
  // Transparent pixels are filled with this key color, so they can be told apart after flattening.
  var KEY_R = 255, KEY_G = 0, KEY_B = 254;
  var tmp = src.duplicate(DopplPS.baseName(src.name) + " (Doppl preview)", true);
  var file = new File(Folder.temp.fsName + "/doppl-color-" + new Date().getTime() + ".raw");
  try {
    if (tmp.mode !== DocumentMode.RGB) { tmp.changeMode(ChangeMode.RGB); }
    if (tmp.bitsPerChannel !== BitsPerChannelType.EIGHT) { tmp.bitsPerChannel = BitsPerChannelType.EIGHT; }
    var w = tmp.width.as("px"), h = tmp.height.as("px");
    var scale = Math.min(1, 64 / Math.max(w, h));
    if (scale < 1) {
      tmp.resizeImage(UnitValue(Math.max(1, Math.round(w * scale)), "px"), UnitValue(Math.max(1, Math.round(h * scale)), "px"), tmp.resolution, ResampleMethod.NEARESTNEIGHBOR);
    }
    var bottom = tmp.layers[tmp.layers.length - 1];
    if (!bottom.isBackgroundLayer) {
      var fill = tmp.artLayers.add();
      fill.move(bottom, ElementPlacement.PLACEAFTER);
      tmp.activeLayer = fill;
      tmp.selection.selectAll();
      tmp.selection.fill(DopplPS.toSolidColor({ r: KEY_R, g: KEY_G, b: KEY_B }));
      tmp.selection.deselect();
    }
    tmp.flatten();
    tmp.saveAs(file, new RawSaveOptions(), true, Extension.LOWERCASE);
  } finally {
    tmp.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = src;
  }
  file.encoding = "BINARY";
  file.open("r");
  var data = file.read();
  file.close();
  file.remove();

  var bins = {}, counted = 0, best = null;
  for (var i = 0; i + 2 < data.length; i += 3) {
    var r = data.charCodeAt(i), g = data.charCodeAt(i + 1), b = data.charCodeAt(i + 2);
    if (r === KEY_R && g === KEY_G && b === KEY_B) { continue; }
    if (opts.ignoreWhite && r > 235 && g > 235 && b > 235) { continue; }
    var k = (r >> 5) + "," + (g >> 5) + "," + (b >> 5);
    var bin = bins[k] || (bins[k] = { n: 0, r: 0, g: 0, b: 0 });
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    counted++;
  }
  for (var key in bins) {
    if (bins.hasOwnProperty(key) && (!best || bins[key].n > best.n)) { best = bins[key]; }
  }
  if (!best) { throw new Error("The image has no visible pixels to take a color from."); }
  var rr = best.r / best.n, gg = best.g / best.n, bb = best.b / best.n;
  return { hex: DopplPS.hex(rr, gg, bb), r: Math.round(rr), g: Math.round(gg), b: Math.round(bb), share: Math.round(best.n / counted * 100) / 100 };
}

/** Sets the color of a Solid Color fill layer. color: "#RRGGBB" or { r, g, b }. */
function setSolidColor(layer, color) {
  if (layer.kind !== LayerKind.SOLIDFILL) { throw new Error('"' + layer.name + '" isn\'t a Solid Color layer'); }
  var c = DopplPS.toSolidColor(color);
  DopplPS.activate(layer);
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(stringIDToTypeID("contentLayer"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
  desc.putReference(charIDToTypeID("null"), ref);
  var fillDesc = new ActionDescriptor();
  var rgb = new ActionDescriptor();
  rgb.putDouble(charIDToTypeID("Rd  "), c.rgb.red);
  rgb.putDouble(charIDToTypeID("Grn "), c.rgb.green);
  rgb.putDouble(charIDToTypeID("Bl  "), c.rgb.blue);
  fillDesc.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), rgb);
  desc.putObject(charIDToTypeID("T   "), stringIDToTypeID("solidColorLayer"), fillDesc);
  executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
  return layer;
}
`;

import type { HelperDef } from "../../core/blocks/types";

// Photoshop building blocks: the helper functions Doppl puts in every script's library (after the runtime in
// jsx/lib.ts). Versions are never removed: a routine runs the versions it pinned. A changed helper is a new entry
// with the next version number (and a test that shows what changed).

const ps = (def: Omit<HelperDef, "app" | "source" | "version"> & { version?: number }): HelperDef => ({ app: "photoshop", source: "builtin", version: 1, ...def });

export const PHOTOSHOP_HELPERS: HelperDef[] = [
  ps({
    id: "ps.openDocument",
    set: "documents",
    call: "openDocument",
    summary: "Opens an image or PSD (reused within the run; a duplicate if the designer has it open).",
    signature: { params: [{"name": "path", "type": "string", "doc": "Absolute path: ctx.item.path, params.<file input>"}], returns: "Document" },
    sideEffects: ["opens a document (closed without saving when the routine finishes)"],
    doc: "openDocument(path) -> Document: opens a PSD or image; reused if Doppl already opened it in this run. If the designer has it open, you get a duplicate. Documents stay open across the routine's items and are closed without saving when the routine finishes.\nExample: var img = openDocument(ctx.item.path);",
    tests: [{"name": "opens an image", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nreturn { w: d.width.as(\"px\"), h: d.height.as(\"px\") };", "checks": [], "expect": {"w": 360, "h": 240}}],
    code: String.raw`/** Opens a file. If the designer already has it open, works on a duplicate so their document stays untouched. */
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
}`,
  }),
  ps({
    id: "ps.findLayer",
    set: "layers",
    call: "findLayer",
    summary: "A layer by name anywhere in the document, or by path \"Group/Sub/Layer\".",
    signature: { params: [{"name": "nameOrPath", "type": "string"}, {"name": "container", "type": "Document|LayerSet", "optional": true, "doc": "default: the active document"}], returns: "Layer" },
    sideEffects: [],
    doc: "findLayer(nameOrPath, container?) -> layer: by name anywhere in the active document (or container), or by path \"Group/Sub/Layer\". Throws if missing.\nExample: setTextLayer(findLayer(\"Title\"), ctx.item.title);",
    tests: [{"name": "finds a layer by name", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nvar l = d.artLayers.add();\nl.name = \"Title\";\nreturn { found: findLayer(\"Title\").name };", "checks": [], "expect": {"found": "Title"}}],
    code: String.raw`/** A layer by name (searched in every group) or by path "Group/Sub/Layer". */
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
}`,
  }),
  ps({
    id: "ps.replaceSmartObject",
    set: "smartObjects",
    call: "replaceSmartObject",
    summary: "Replaces a Smart Object's contents with an image or PSD file.",
    signature: { params: [{"name": "layer", "type": "Layer", "doc": "a Smart Object layer"}, {"name": "path", "type": "string", "doc": "the new contents"}], returns: "Layer" },
    sideEffects: ["changes the layer's contents"],
    doc: "replaceSmartObject(layer, path) -> layer: replaces a Smart Object's contents with an image/PSD file.\nExample: replaceSmartObject(findLayer(\"Label\"), ctx.matched.labels.path);",
    tests: [{"name": "replaces the contents", "inputs": {"image": "gen:product-on-white", "other": "gen:red"}, "script": "var d = openDocument(params.image);\nexecuteAction(stringIDToTypeID(\"newPlacedLayer\"), undefined, DialogModes.NO);\nvar l = d.activeLayer;\nreplaceSmartObject(l, params.other);\nreturn { kind: String(l.kind) };", "checks": [], "expect": {"kind": "LayerKind.SMARTOBJECT"}}],
    code: String.raw`/** Replaces the contents of a Smart Object layer with an image or document file. */
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
}`,
  }),
  ps({
    id: "ps.setTextLayer",
    set: "layers",
    call: "setTextLayer",
    summary: "Sets a text layer's text (reports fonts that aren't installed).",
    signature: { params: [{"name": "layer", "type": "Layer", "doc": "a text layer"}, {"name": "text", "type": "string"}], returns: "Layer" },
    sideEffects: ["changes the layer's text"],
    doc: "setTextLayer(layer, text): sets a text layer's text (reports fonts that aren't installed).\nExample: setTextLayer(findLayer(\"Title\"), ctx.item.title);",
    tests: [{"name": "sets the text", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nvar t = d.artLayers.add();\nt.kind = LayerKind.TEXT;\nt.name = \"Title\";\nsetTextLayer(t, \"Hello\");\nreturn { text: t.textItem.contents };", "checks": [], "expect": {"text": "Hello"}}],
    code: String.raw`/** Sets the text of a text layer and reports fonts that aren't installed. */
function setTextLayer(layer, text) {
  if (layer.kind !== LayerKind.TEXT) { throw new Error('"' + layer.name + '" isn\'t a text layer'); }
  layer.textItem.contents = String(text);
  var font = "";
  try { font = layer.textItem.font; } catch (e) {}
  if (font && !DopplPS.fontInstalled(font)) {
    DopplPS.finding("font-missing", 'Font "' + font + '" used in "' + layer.name + '" isn\'t installed');
  }
  return layer;
}`,
  }),
  ps({
    id: "ps.setLayerVisible",
    set: "layers",
    call: "setLayerVisible",
    summary: "Shows or hides a layer.",
    signature: { params: [{"name": "layer", "type": "Layer"}, {"name": "visible", "type": "boolean"}], returns: "Layer" },
    sideEffects: ["changes the layer's visibility"],
    doc: "setLayerVisible(layer, visible)\nExample: setLayerVisible(findLayer(\"Badge\"), ctx.item.sale === \"yes\");",
    tests: [{"name": "hides a layer", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nvar l = d.artLayers.add();\nsetLayerVisible(l, false);\nreturn { visible: l.visible };", "checks": [], "expect": {"visible": false}}],
    code: String.raw`function setLayerVisible(layer, visible) {
  layer.visible = !!visible;
  return layer;
}`,
  }),
  ps({
    id: "ps.exportImage",
    set: "export",
    call: "exportImage",
    summary: "Exports the active document as PNG, JPG or TIFF into the working folder or a picked folder.",
    signature: { params: [{"name": "path", "type": "string", "doc": "inside ctx.workDir"}, {"name": "format", "type": "\"png\"|\"jpg\"|\"tif\""}, {"name": "quality", "type": "number", "optional": true, "doc": "0-100, JPG"}], returns: "string (the file path)" },
    sideEffects: ["writes a file"],
    doc: "exportImage(path, format, quality) -> path: exports the ACTIVE document as \"png\", \"jpg\" (quality 0-100) or \"tif\". The path must be inside ctx.workDir (the designer's files and folders are read-only). Use app.activeDocument = someDoc to choose what to export.\nExample: ctx.output(\"pngs\", exportImage(ctx.join(ctx.workDir, ctx.item.stem + \".png\"), \"png\"));",
    tests: [{"name": "exports a JPG", "inputs": {"image": "gen:photo"}, "script": "openDocument(params.image);\nctx.output(\"files\", exportImage(ctx.join(ctx.workDir, \"photo.jpg\"), \"jpg\", 80));", "checks": [{"type": "fileExtension", "port": "files", "is": "jpg"}, {"type": "imageSize", "port": "files", "width": 600, "height": 400}]}],
    code: String.raw`/** Exports the active document as PNG, JPG or TIFF (a copy; the document itself isn't saved). quality: 0–100 (JPG). */
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
    // Photoshop's default here is no compression: files ~6× larger for the same pixels.
    opts = new PNGSaveOptions();
    opts.compression = 6;
    opts.interlaced = false;
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
}`,
  }),
  ps({
    id: "ps.saveCopy",
    set: "export",
    call: "saveCopy",
    summary: "Saves a PSD copy of the active document (never overwrites anything).",
    signature: { params: [{"name": "folder", "type": "string", "optional": true, "doc": "ctx.workDir (the designer's folders are read-only)"}, {"name": "fileName", "type": "string", "optional": true, "doc": "without .psd"}], returns: "string (the file path)" },
    sideEffects: ["writes a file"],
    doc: "saveCopy(folder, fileName) -> path: saves a PSD copy of the active document as \"<fileName>.psd\" in a folder (e.g. saveCopy(ctx.workDir, ctx.item.sku)); saveCopy() alone saves \"<name>_doppl.psd\" next to the source. Never overwrites anything (an existing name gets \"-2\"). Only when the request asks for a saved PSD.\nExample: ctx.output(\"psds\", saveCopy(ctx.workDir, ctx.item.stem));",
    tests: [{"name": "saves a PSD", "inputs": {"image": "gen:product-on-white"}, "script": "openDocument(params.image);\nctx.output(\"files\", saveCopy(ctx.workDir, \"copy\"));", "checks": [{"type": "fileExtension", "port": "files", "is": "psd"}, {"type": "outputCount", "port": "files", "equals": 1}]}],
    code: String.raw`/**
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
}`,
  }),
  ps({
    id: "ps.closeWithoutSaving",
    set: "documents",
    call: "closeWithoutSaving",
    summary: "Closes a document Doppl opened, without saving.",
    signature: { params: [{"name": "doc", "type": "Document", "optional": true, "doc": "default: the active document"}], returns: "nothing" },
    sideEffects: ["closes a document"],
    doc: "closeWithoutSaving(doc?): closes a document Doppl opened (default: active) without saving.\nExample: closeWithoutSaving(mockup);",
    tests: [{"name": "closes the document", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nvar n = app.documents.length;\ncloseWithoutSaving(d);\nreturn { closed: app.documents.length === n - 1 };", "checks": [], "expect": {"closed": true}}],
    code: String.raw`/** Closes a document Doppl opened (default: the active one) without saving. */
function closeWithoutSaving(doc) {
  var d = doc || app.activeDocument;
  if (!DopplPS.isOwned(d)) { throw new Error("Doppl only closes documents it opened itself."); }
  DopplPS.disown(d);
  d.close(SaveOptions.DONOTSAVECHANGES);
}`,
  }),
  ps({
    id: "ps.removeWhiteBackground",
    set: "masking",
    call: "removeWhiteBackground",
    summary: "Deletes a white background that touches the corners (pixels become transparent).",
    signature: { params: [{"name": "doc", "type": "Document", "optional": true, "doc": "default: the active document"}, {"name": "tolerance", "type": "number", "optional": true, "doc": "0-255, default 24"}], returns: "{ removed }" },
    sideEffects: ["deletes background pixels"],
    doc: "removeWhiteBackground(doc?, tolerance?) -> { removed }: DELETES a plain white background that touches the image's corners (its pixels become transparent; white inside the subject stays). tolerance 0-255, default 24. Then trimTransparent(doc?).\nExample: var img = openDocument(ctx.item.path); removeWhiteBackground(img, params.tolerance); trimTransparent(img);",
    tests: [{"name": "makes the background transparent", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nremoveWhiteBackground(d);\nctx.output(\"files\", exportImage(ctx.join(ctx.workDir, \"cut.png\"), \"png\"));", "checks": [{"type": "cornerPixelsTransparent", "port": "files"}, {"type": "hasTransparency", "port": "files"}]}],
    code: String.raw`/**
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
}`,
  }),
  ps({
    id: "ps.maskWhiteBackground",
    set: "masking",
    call: "maskWhiteBackground",
    summary: "Hides a white background (also white gaps inside the subject) with an editable layer mask; keeps highlights.",
    signature: { params: [{"name": "layer", "type": "Layer", "optional": true, "doc": "default: the active layer"}, {"name": "options", "type": "{ tolerance?, enclosed?, keepHighlights?, shrink?, feather? }", "optional": true}], returns: "{ bounds: [left, top, right, bottom] }" },
    sideEffects: ["adds (or replaces) the layer's mask"],
    doc: "maskWhiteBackground(layer?, { tolerance?, enclosed?, keepHighlights?, shrink?, feather? }) -> { bounds }: hides a white background with a LAYER MASK on the layer (pixels kept, editable by hand later): the white around the subject and, unless enclosed: false, white areas inside it (gaps between items). White narrower than 2 × keepHighlights px stays visible (small highlights; default 1% of the shorter side): enclosed is already on, so for a white gap that stays, lower keepHighlights (e.g. 0) or raise tolerance; shrink px (default 1) removes a white fringe. Throws when the image's corners aren't white. Then cropToBounds(doc, result.bounds, padding?) (trimTransparent doesn't see masks).\nExample: var cut = maskWhiteBackground(img.activeLayer, { tolerance: params.tolerance }); cropToBounds(img, cut.bounds, 4);",
    tests: [{"name": "masks the white around and inside the subject", "inputs": {"image": "gen:ring-on-white"}, "script": "var d = openDocument(params.image);\nvar cut = maskWhiteBackground(d.activeLayer);\nvar masked = DopplPS.hasLayerMask();\nctx.output(\"files\", exportImage(ctx.join(ctx.workDir, \"masked.png\"), \"png\"));\nreturn { masked: masked, left: cut.bounds[0] > 0 };", "checks": [{"type": "cornerPixelsTransparent", "port": "files"}, {"type": "hasTransparency", "port": "files"}, {"type": "noOpaqueWhite", "port": "files"}], "expect": {"masked": true, "left": true}}],
    code: String.raw`/**
 * Hides a plain white (or near-white) background with a LAYER MASK on the layer (default: the active layer); its
 * pixels stay as they are, so the mask can be refined by hand. An existing mask on the layer is replaced.
 * options:
 * - tolerance 0–255 (default 24): how far from white still counts as background.
 * - enclosed (default true): also hide white areas inside the subject (gaps between items), not only the white
 *   around it.
 * - keepHighlights px (default 1% of the shorter side): enclosed white narrower than twice this stays visible, so
 *   small shiny highlights are kept.
 * - shrink px (default 1): pulls the edge in to remove a white fringe; feather px (default 0.5) softens it.
 * Returns { bounds: [left, top, right, bottom] } of what stays visible, for cropToBounds. Throws when there's no
 * white at the image's corners.
 */
function maskWhiteBackground(layer, options) {
  var opts = options || {};
  var target = layer || app.activeDocument.activeLayer;
  var d = DopplPS.documentOf(target);
  app.activeDocument = d;
  if (target.isBackgroundLayer) { target.isBackgroundLayer = false; }
  d.activeLayer = target;
  if (DopplPS.hasLayerMask()) { DopplPS.deleteLayerMask(); }
  d.selection.deselect();
  var tol = opts.tolerance === undefined || opts.tolerance === null ? 24 : Number(opts.tolerance);
  var w = Math.round(d.width.as("px")), h = Math.round(d.height.as("px"));
  var keep = opts.keepHighlights === undefined || opts.keepHighlights === null ? Math.max(2, Math.round(Math.min(w, h) * 0.01)) : Number(opts.keepHighlights);
  keep = Math.max(0, Math.min(100, Math.round(keep)));
  var shrink = opts.shrink === undefined || opts.shrink === null ? 1 : Math.max(0, Math.min(100, Number(opts.shrink)));
  var feather = opts.feather === undefined || opts.feather === null ? 0.5 : Math.max(0, Number(opts.feather));

  // The white around the subject: flood fill from each white corner.
  var corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  var white = null;
  for (var i = 0; i < corners.length; i++) {
    var c = DopplPS.colorAt(d, corners[i][0], corners[i][1]);
    if (c.r >= 255 - tol && c.g >= 255 - tol && c.b >= 255 - tol) {
      DopplPS.wandAt(corners[i][0], corners[i][1], tol, white !== null);
      if (!white) { white = corners[i]; }
    }
  }
  if (!white) { throw new Error("maskWhiteBackground: the corners of " + d.name + " aren't white, so there's no white background to hide."); }

  if (opts.enclosed !== false) {
    // Every white area in the image, minus the small ones (highlights), plus the white around the subject.
    var outer = d.channels.add();
    d.selection.store(outer);
    d.activeChannels = d.componentChannels;
    DopplPS.wandAt(white[0], white[1], tol, false, false);
    if (keep > 0) {
      d.selection.contract(UnitValue(keep, "px"));
      d.selection.expand(UnitValue(keep, "px"));
    }
    d.selection.load(outer, SelectionType.EXTEND);
    outer.remove();
    d.activeLayer = target;
  }

  // What stays visible is everything that isn't background, pulled in a little to drop the fringe.
  d.selection.invert();
  if (shrink > 0) { d.selection.contract(UnitValue(shrink, "px")); }
  if (feather > 0) { d.selection.feather(UnitValue(feather, "px")); }
  var bounds;
  try {
    bounds = DopplPS.px(d.selection.bounds);
  } catch (e) {
    throw new Error("maskWhiteBackground: everything in " + d.name + " counts as white background; lower the tolerance.");
  }
  DopplPS.addLayerMask(true);
  d.selection.deselect();
  return { bounds: bounds };
}`,
  }),
  ps({
    id: "ps.maskSubject",
    set: "masking",
    call: "maskSubject",
    summary: "Cuts out the main subject on any background (busy or colored, not only white) with Photoshop's Select Subject, as an editable layer mask.",
    signature: { params: [{"name": "layer", "type": "Layer", "optional": true, "doc": "default: the active layer"}], returns: "{ bounds: [left, top, right, bottom], kept: share of the picture that stays, 0-1 }" },
    sideEffects: ["adds (or replaces) the layer's mask", "flags the output when the cutout keeps under 10% or over 95% of the picture"],
    doc: "maskSubject(layer?) -> { bounds, kept }: cuts out the main subject on ANY background with Photoshop's Select Subject, as a LAYER MASK on the layer (pixels kept, editable by hand later). No AI calls. Use it when the backgrounds aren't plain white, or only some are; for plain white ones maskWhiteBackground is exact and also clears white gaps inside the subject. It decides what the subject is: it can't be told which object (two products stay together) and tight close-ups can go wrong, so a cutout keeping under 10% or over 95% of the picture is flagged for the designer to look at. A small product in a big frame trips that flag too, so the flag alone doesn't mean the routine is wrong. Throws when it finds no subject. Then cropToBounds(doc, result.bounds, padding?) (trimTransparent doesn't see masks).\nExample: var cut = maskSubject(img.activeLayer); cropToBounds(img, cut.bounds, 4);",
    tests: [{"name": "cuts out the subject on a gray background as a mask, with no flag", "inputs": {"image": "gen:product-on-gray"}, "script": "var d = openDocument(params.image);\nvar cut = maskSubject(d.activeLayer);\nvar masked = DopplPS.hasLayerMask();\nctx.output(\"files\", exportImage(ctx.join(ctx.workDir, \"subject.png\"), \"png\"));\nreturn { masked: masked, left: cut.bounds[0] > 0, plausible: cut.kept > 0.1 && cut.kept < 0.95, flags: DopplPS.state.findings.length };", "checks": [{"type": "cornerPixelsTransparent", "port": "files"}, {"type": "hasTransparency", "port": "files"}], "expect": {"masked": true, "left": true, "plausible": true, "flags": 0}}, {"name": "leaves a hidden copy of the photo out of the cutout", "inputs": {"image": "gen:product-on-gray"}, "script": "var d = openDocument(params.image);\nvar photo = d.activeLayer;\nif (photo.isBackgroundLayer) { photo.isBackgroundLayer = false; }\nvar original = photo.duplicate();\noriginal.name = \"Original\";\noriginal.visible = false;\nvar cut = maskSubject(photo);\nctx.output(\"files\", exportImage(ctx.join(ctx.workDir, \"subject.png\"), \"png\"));\nreturn { plausible: cut.kept > 0.1 && cut.kept < 0.95 };", "checks": [{"type": "cornerPixelsTransparent", "port": "files"}], "expect": {"plausible": true}}, {"name": "says so when a picture has no subject", "inputs": {"image": "gen:blank-white"}, "script": "var d = openDocument(params.image);\nvar said = \"\";\ntry { maskSubject(d.activeLayer); } catch (e) { said = e.message; }\nreturn { noSubject: said.indexOf(\"couldn't find a subject\") >= 0, flags: DopplPS.state.findings.length };", "checks": [], "expect": {"noSubject": true, "flags": 0}}, {"name": "flags a cutout that keeps the whole picture", "inputs": {"image": "gen:red"}, "script": "var d = openDocument(params.image);\nvar cut = maskSubject(d.activeLayer);\nreturn { kept: cut.kept, flag: DopplPS.state.findings[0].type };", "checks": [], "expect": {"kept": 1, "flag": "cutout-suspect"}}],
    code: String.raw`/**
 * Cuts out the main subject with Photoshop's Select Subject, as a LAYER MASK on the layer (default: the active layer);
 * its pixels stay as they are, so the mask can be refined by hand. An existing mask on the layer is replaced. Works on
 * any background, but Photoshop decides what the subject is, so a cutout that keeps under 10% or over 95% of the
 * picture is flagged for the designer to look at.
 * Returns { bounds: [left, top, right, bottom], kept: 0-1 }, the bounds for cropToBounds. Throws when there's no subject.
 */
function maskSubject(layer) {
  var target = layer || app.activeDocument.activeLayer;
  var d = DopplPS.documentOf(target);
  app.activeDocument = d;
  if (target.isBackgroundLayer) { target.isBackgroundLayer = false; }
  d.activeLayer = target;
  if (DopplPS.hasLayerMask()) { DopplPS.deleteLayerMask(); }
  d.selection.deselect();
  var noSubject = "Photoshop couldn't find a subject in " + d.name + ". Check the picture, or use one with a clear subject.";
  var thisLayerOnly = new ActionDescriptor();
  thisLayerOnly.putBoolean(stringIDToTypeID("sampleAllLayers"), false);
  try {
    executeAction(stringIDToTypeID("autoCutout"), thisLayerOnly, DialogModes.NO);
  } catch (e) {
    if (/not currently valid/.test(e.message)) { throw new Error(noSubject); }
    throw e;
  }
  var bounds;
  try {
    bounds = DopplPS.px(d.selection.bounds);
  } catch (e2) {
    throw new Error(noSubject);
  }

  // With a selection, a channel's histogram counts only the selected pixels.
  var levels = d.channels[0].histogram, selected = 0;
  for (var i = 0; i < levels.length; i++) { selected += levels[i]; }
  var kept = selected / (d.width.as("px") * d.height.as("px"));
  if (kept < 0.1) {
    var percent = Math.round(kept * 100);
    DopplPS.finding("cutout-suspect", "The cutout of " + d.name + " kept only " + (percent < 1 ? "under 1" : percent) + "% of the picture. Check that it found the whole subject.");
  } else if (kept > 0.95) {
    DopplPS.finding("cutout-suspect", "The cutout of " + d.name + " kept almost the whole picture. Check that it found a subject.");
  }
  DopplPS.addLayerMask(true);
  d.selection.deselect();
  return { bounds: bounds, kept: Math.round(kept * 1000) / 1000 };
}`,
  }),
  ps({
    id: "ps.cropToBounds",
    set: "masking",
    call: "cropToBounds",
    summary: "Crops the document to pixel bounds (e.g. maskWhiteBackground's), with padding.",
    signature: { params: [{"name": "doc", "type": "Document", "optional": true, "doc": "default: the active document"}, {"name": "bounds", "type": "[left, top, right, bottom]", "doc": "px"}, {"name": "padding", "type": "number", "optional": true, "doc": "px around the bounds"}], returns: "Document" },
    sideEffects: ["crops the document"],
    doc: "cropToBounds(doc, [left, top, right, bottom], padding?): crops the document to those pixel bounds.\nExample: cropToBounds(img, cut.bounds, 4);",
    tests: [{"name": "crops to the bounds", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\ncropToBounds(d, [100, 40, 260, 200], 0);\nreturn { w: d.width.as(\"px\"), h: d.height.as(\"px\") };", "checks": [], "expect": {"w": 160, "h": 160}}],
    code: String.raw`/**
 * Crops the document to bounds [left, top, right, bottom] in px (e.g. the bounds maskWhiteBackground returns),
 * with padding px around them. Use it instead of trimTransparent when the background is hidden by a mask.
 */
function cropToBounds(doc, bounds, padding) {
  var d = doc || app.activeDocument;
  app.activeDocument = d;
  var p = padding ? Number(padding) : 0;
  var w = d.width.as("px"), h = d.height.as("px");
  d.crop([Math.max(0, bounds[0] - p), Math.max(0, bounds[1] - p), Math.min(w, bounds[2] + p), Math.min(h, bounds[3] + p)]);
  return d;
}`,
  }),
  ps({
    id: "ps.trimTransparent",
    set: "masking",
    call: "trimTransparent",
    summary: "Crops to the visible content (cuts off transparent edges).",
    signature: { params: [{"name": "doc", "type": "Document", "optional": true, "doc": "default: the active document"}], returns: "Document" },
    sideEffects: ["crops the document"],
    doc: "trimTransparent(doc?): crops to the visible content (cuts off transparent edges).\nExample: removeWhiteBackground(img); trimTransparent(img);",
    tests: [{"name": "trims the transparent edges", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nremoveWhiteBackground(d);\ntrimTransparent(d);\nctx.output(\"files\", exportImage(ctx.join(ctx.workDir, \"trimmed.png\"), \"png\"));", "checks": [{"type": "imageSize", "port": "files", "maxWidth": 170, "maxHeight": 170}]}],
    code: String.raw`/** Crops the document to its visible content (transparent edges are cut off). */
function trimTransparent(doc) {
  var d = doc || app.activeDocument;
  app.activeDocument = d;
  d.trim(TrimType.TRANSPARENT, true, true, true, true);
  return d;
}`,
  }),
  ps({
    id: "ps.dominantColor",
    set: "color",
    call: "dominantColor",
    summary: "The most common color of a document or image, ignoring transparent (and optionally near-white) pixels.",
    signature: { params: [{"name": "source", "type": "Document|string", "doc": "a document or an image path"}, {"name": "options", "type": "{ ignoreWhite? }", "optional": true}], returns: "{ hex, r, g, b, share }" },
    sideEffects: [],
    doc: "dominantColor(docOrPath, { ignoreWhite? }) -> { hex: \"#RRGGBB\", r, g, b, share }: the most common color, ignoring transparent pixels (and near-white ones with ignoreWhite). The source isn't changed.\nExample: var c = dominantColor(ctx.item.path, { ignoreWhite: true }); setSolidColor(findLayer(\"Background\"), c.hex);",
    tests: [{"name": "finds the color of a solid image", "inputs": {"image": "gen:red"}, "script": "var c = dominantColor(params.image);\nreturn { hex: c.hex, share: c.share };", "checks": [], "expect": {"hex": "#E02020", "share": 1}}],
    code: String.raw`/**
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
}`,
  }),
  ps({
    id: "ps.setSolidColor",
    set: "color",
    call: "setSolidColor",
    summary: "Sets the color of a Solid Color fill layer.",
    signature: { params: [{"name": "layer", "type": "Layer", "doc": "a Solid Color fill layer"}, {"name": "color", "type": "\"#RRGGBB\"|{ r, g, b }"}], returns: "Layer" },
    sideEffects: ["changes the layer's color"],
    doc: "setSolidColor(layer, \"#RRGGBB\" or { r, g, b }): sets the color of a Solid Color fill layer.\nExample: setSolidColor(findLayer(\"Background\"), dominantColor(ctx.item.path).hex);",
    tests: [{"name": "sets the fill color", "inputs": {"image": "gen:product-on-white"}, "script": "var d = openDocument(params.image);\nvar mk = new ActionDescriptor();\nvar ref = new ActionReference();\nref.putClass(stringIDToTypeID(\"contentLayer\"));\nmk.putReference(charIDToTypeID(\"null\"), ref);\nvar layerDesc = new ActionDescriptor();\nvar fill = new ActionDescriptor();\nvar rgb = new ActionDescriptor();\nrgb.putDouble(charIDToTypeID(\"Rd  \"), 0);\nrgb.putDouble(charIDToTypeID(\"Grn \"), 0);\nrgb.putDouble(charIDToTypeID(\"Bl  \"), 0);\nfill.putObject(charIDToTypeID(\"Clr \"), charIDToTypeID(\"RGBC\"), rgb);\nlayerDesc.putObject(charIDToTypeID(\"Type\"), stringIDToTypeID(\"solidColorLayer\"), fill);\nmk.putObject(charIDToTypeID(\"Usng\"), stringIDToTypeID(\"contentLayer\"), layerDesc);\nexecuteAction(charIDToTypeID(\"Mk  \"), mk, DialogModes.NO);\nsetSolidColor(d.activeLayer, \"#3366CC\");\nd.flatten();\nvar c = DopplPS.colorAt(d, 5, 5);\nreturn { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };", "checks": [], "expect": {"r": 51, "g": 102, "b": 204}}],
    code: String.raw`/** Sets the color of a Solid Color fill layer. color: "#RRGGBB" or { r, g, b }. */
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
}`,
  }),
];

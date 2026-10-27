import { routineStartMarker as ROUTINE_START } from "../../adobe/bridge";

// Photoshop scripts: each is `function (input) { … return data; }`, run through the shared Adobe bridge with the
// helper library (jsx/lib.ts) in front. Ruler units are pixels while a script runs (see photoshop/bridge.ts).

/** Doppl's own documents (working copies, duplicates, previews) aren't listed as the designer's documents. */
const OWN_DOC = String.raw`/ \(Doppl( working copy| preview| export)?\)$/`;

export const PROBE = String.raw`function (input) {
  return { version: app.version, documents: app.documents.length };
}`;

export const LIST_DOCUMENTS = String.raw`function (input) {
  var activeName = null;
  try { activeName = app.activeDocument.name; } catch (e) {}
  var out = [];
  var docs = DopplPS.all(app.documents);
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (${OWN_DOC}.test(DopplPS.baseName(d.name)) || ${OWN_DOC}.test(d.name)) { continue; }
    out.push({ id: DopplPS.docId(d), name: d.name, path: DopplPS.pathOf(d) || "", active: d.name === activeName });
  }
  return out;
}`;

/** Layer tree with kinds, Smart Object flag, visibility and bounds; document size, resolution and color mode. */
export const INSPECT = String.raw`function (input) {
  var doc = DopplPS.findDocument(input.docId);
  var count = 0, max = input.maxLayers || 400;
  function px(v) { return Math.round(v.as("px")); }
  function boundsOf(layer) {
    try { var b = layer.bounds; return [px(b[0]), px(b[1]), px(b[2]), px(b[3])]; } catch (e) { return null; }
  }
  function kindOf(layer) {
    if (layer.typename === "LayerSet") { return "group"; }
    try { return String(layer.kind).replace("LayerKind.", "").toLowerCase(); } catch (e) { return "unknown"; }
  }
  function walk(container, depth) {
    var list = [];
    var layers = DopplPS.all(container.layers);
    for (var i = 0; i < layers.length && count < max; i++) {
      var l = layers[i];
      count++;
      var node = { name: l.name, kind: kindOf(l), visible: l.visible, bounds: boundsOf(l) };
      if (node.kind === "smartobject") { node.smartObject = true; }
      if (node.kind === "text") {
        try { node.text = String(l.textItem.contents).slice(0, 200); node.font = l.textItem.font; } catch (e) {}
      }
      if (l.typename === "LayerSet" && depth < 8) { node.children = walk(l, depth + 1); }
      list.push(node);
    }
    return list;
  }
  var layers = walk(doc, 0);
  return {
    id: DopplPS.docId(doc),
    name: doc.name,
    path: DopplPS.pathOf(doc) || "",
    appVersion: app.version,
    width: px(doc.width),
    height: px(doc.height),
    resolution: doc.resolution,
    mode: String(doc.mode).replace("DocumentMode.", ""),
    bitsPerChannel: String(doc.bitsPerChannel).replace("BitsPerChannelType.", ""),
    layers: layers,
    layerCount: count,
    truncated: count >= max
  };
}`;

/** Duplicates the picked document into a working copy the stage's items share. */
export const BEGIN_STAGE = String.raw`function (input) {
  DopplPS.makeContext(input);
  var workingName = null;
  if (input.docId) {
    var src = DopplPS.findDocument(input.docId);
    app.activeDocument = src;
    var dup = src.duplicate(DopplPS.baseName(src.name) + " (Doppl working copy)");
    DopplPS.own(dup);
    workingName = dup.name;
  }
  return { owned: DopplPS.state.owned, workingName: workingName };
}`;

/**
 * One item of a stage. The routine body runs as `function (doc, params, ctx)` with `doc` = the working copy (or null),
 * ctx.item / ctx.stages / ctx.output / ctx.log, and the global helpers. Errors come back as data, so documents the
 * routine opened before failing are still closed at the end of the stage.
 */
export function wrapItem(body: string): string {
  return `function (input) {
  var ctx = DopplPS.makeContext(input);
  var doc = null;
  if (input.workingName) {
    doc = DopplPS.findByName(input.workingName);
    if (!doc) { throw new Error("Doppl's working copy was closed during the run."); }
    app.activeDocument = doc;
  }
  var routine = function (doc, params, ctx) {
${ROUTINE_START}
${body}
  };
  var result = null, failure = null;
  try { result = routine(doc, input.params || {}, ctx); } catch (e) { failure = e; }
  var reported = [];
  for (var i = 0; i < DopplPS.state.reported.length; i++) { reported.push(DopplPS.state.reported[i]); }
  return {
    error: failure ? String(failure.message || failure) : null,
    line: failure && failure.line ? failure.line : null,
    result: result === undefined ? null : result,
    files: DopplPS.state.files,
    outputs: DopplPS.state.outputs,
    findings: DopplPS.state.findings,
    log: DopplPS.state.log,
    owned: DopplPS.state.owned,
    reported: reported,
    activeName: (function () { try { return app.activeDocument.name; } catch (e) { return null; } })()
  };
}`;
}

/** Closes every document Doppl opened or duplicated during the stage, without saving. */
export const END_STAGE = String.raw`function (input) {
  DopplPS.makeContext(input);
  var owned = DopplPS.state.owned.slice(0), closed = 0;
  var docs = DopplPS.all(app.documents);
  for (var i = 0; i < owned.length; i++) {
    for (var j = 0; j < docs.length; j++) {
      var p = DopplPS.pathOf(docs[j]);
      var same = (owned[i].path && p && owned[i].path === p) || (!owned[i].path && !p && owned[i].name === docs[j].name);
      if (same) {
        try { docs[j].close(SaveOptions.DONOTSAVECHANGES); closed++; } catch (e) {}
        break;
      }
    }
  }
  return { closed: closed };
}`;

/** A small PNG of a document's current state (flattened duplicate, never saved over anything). */
export const RENDER_PREVIEW = String.raw`function (input) {
  var doc = input.name ? DopplPS.findByName(input.name) : DopplPS.findDocument(input.docId);
  if (!doc) { throw new Error("The document isn't open in Photoshop anymore."); }
  var previous = null;
  try { previous = app.activeDocument; } catch (e) {}
  app.activeDocument = doc;
  var dup = doc.duplicate(DopplPS.baseName(doc.name) + " (Doppl preview)", true);
  var file = new File(input.file);
  try {
    if (dup.mode !== DocumentMode.RGB && dup.mode !== DocumentMode.GRAYSCALE) { dup.changeMode(ChangeMode.RGB); }
    if (dup.bitsPerChannel !== BitsPerChannelType.EIGHT) { dup.bitsPerChannel = BitsPerChannelType.EIGHT; }
    var w = dup.width.as("px"), h = dup.height.as("px");
    if (w > input.width) {
      dup.resizeImage(UnitValue(input.width, "px"), UnitValue(Math.max(1, Math.round(h * input.width / w)), "px"), dup.resolution, ResampleMethod.BICUBIC);
    }
    DopplPS.ensureFolder(file.parent);
    dup.saveAs(file, new PNGSaveOptions(), true, Extension.LOWERCASE);
  } finally {
    dup.close(SaveOptions.DONOTSAVECHANGES);
    if (previous) { try { app.activeDocument = previous; } catch (e2) {} }
  }
  return { file: file.fsName };
}`;

export const MISSING_FONTS = String.raw`function (input) {
  var have = {};
  for (var i = 0; i < app.fonts.length; i++) { have[String(app.fonts[i].family).toLowerCase()] = true; }
  var missing = [];
  for (var j = 0; j < input.families.length; j++) {
    if (!have[String(input.families[j]).toLowerCase()]) { missing.push(input.families[j]); }
  }
  return missing;
}`;

/** Layer names for "layers" / "smartObjects" param options. */
export const LAYER_NAMES = String.raw`function (input) {
  var doc = DopplPS.findDocument(input.docId);
  var names = [];
  function walk(container) {
    var layers = DopplPS.all(container.layers);
    for (var i = 0; i < layers.length && names.length < 300; i++) {
      var l = layers[i];
      if (l.typename === "LayerSet") { if (!input.smartOnly) { names.push(l.name); } walk(l); continue; }
      if (!input.smartOnly || l.kind === LayerKind.SMARTOBJECT) { names.push(l.name); }
    }
  }
  walk(doc);
  return names;
}`;

export const FOCUS_DOCUMENT = String.raw`function (input) {
  app.activeDocument = DopplPS.findDocument(input.docId);
  return true;
}`;

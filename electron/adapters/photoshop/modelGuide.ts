// What the model needs to write a Photoshop routine. The helper catalog is generated from the building blocks in
// "full" mode (as before); in "index" mode a ranked index of the blocks replaces it (core/blocks/registry).

export const PHOTOSHOP_GUIDE_INTRO = `Photoshop routines are ExtendScript (ES3, like InDesign): var only, no arrow functions, no let/const, no
template literals, no Array.forEach/map/filter/indexOf, no String.trim, no Object.keys, no JSON beyond JSON.parse/stringify.

The script is the BODY of function (doc, params, ctx) { ... }:
- doc: a working copy of the document the designer picked (routines with a document input), already active; null
  otherwise. The designer's own document is never touched.
- params: every input and setting by key. File and folder inputs are absolute paths, fileList inputs arrays of
  paths, rows inputs { rows, columns, name, path }.
- ctx.item: the current item when the routine iterates (a data row object, or for files { path, name, stem, ext }).
- ctx.itemIndex (0-based); ctx.matched.<input>: the item of a second list input that pairs with ctx.item (a file
  { path, name, stem, ext } or a row); ctx.workDir (this routine's working folder; write output files here).
- ctx.output(key, value): adds a value to one of the routine's declared outputs, e.g. ctx.output("cutouts", path).
  Files written with exportImage go to the first file output automatically if you don't call ctx.output.
- ctx.report(label, doc?): show a document (default: active) as a result with a preview.
- ctx.log(message), ctx.format("{name}_v1", { name: "a" }), ctx.safeFileName(s), ctx.join(folder, name),
  ctx.fileName(path), ctx.baseName(path) (file name without extension).
- ctx.findFile(list, name) -> path: a file from a list (e.g. params.photos) by name, with or without extension,
  e.g. ctx.findFile(params.photos, ctx.item.image). Throws when there's no such file. (In a routine that iterates,
  ctx.matched.photos.path is simpler: Doppl already paired them.)

`;

/** The helpers as the guide listed them before building blocks (full mode). */
export const PHOTOSHOP_HELPER_CATALOG = `Helper functions (use these; don't call app.open, doc.save, doc.saveAs or doc.close yourself):
- openDocument(path) -> Document: opens a PSD/image; reused if Doppl already opened it in this run. If the
  designer has it open, you get a duplicate. Documents stay open across the routine's items and are closed without
  saving when the routine finishes.
- findLayer(nameOrPath, container?) -> layer: by name anywhere in the active document (or container), or by
  path "Group/Sub/Layer". Throws if missing.
- replaceSmartObject(layer, path) -> layer: replaces a Smart Object's contents with an image/PSD file.
- setTextLayer(layer, text): sets a text layer's text (reports fonts that aren't installed).
- setLayerVisible(layer, visible)
- exportImage(path, format, quality) -> path: exports the ACTIVE document as "png", "jpg" (quality 0-100) or "tif".
  The path must be inside ctx.workDir or a folder input. Use app.activeDocument = someDoc to choose what to export.
- saveCopy(folder, fileName) -> path: saves a PSD copy of the active document as "<fileName>.psd" in a folder
  (e.g. saveCopy(ctx.workDir, ctx.item.sku)); saveCopy() alone saves "<name>_doppl.psd" next to the source.
  Never overwrites anything (an existing name gets "-2"). Only when the request asks for a saved PSD.
- closeWithoutSaving(doc?): closes a document Doppl opened (default: active) without saving.
- removeWhiteBackground(doc?, tolerance?) -> { removed }: DELETES a plain white background that touches the image's
  corners (its pixels become transparent; white inside the subject stays). tolerance 0-255, default 24. Then
  trimTransparent(doc?).
- maskWhiteBackground(layer?, { tolerance?, enclosed?, keepHighlights?, shrink?, feather? }) -> { bounds }: hides a
  white background with a LAYER MASK on the layer (pixels kept, editable by hand later): the white around the
  subject and, unless enclosed: false, white areas inside it (gaps between items). White narrower than
  2 × keepHighlights px stays visible (small highlights; default 1% of the shorter side); shrink px (default 1)
  removes a white fringe. Throws when the image's corners aren't white. Use it whenever the request asks for a mask
  or for removing white inside the subject. Then cropToBounds(doc, result.bounds, padding?) (trimTransparent
  doesn't see masks).
- cropToBounds(doc, [left, top, right, bottom], padding?): crops the document to those pixel bounds.
- trimTransparent(doc?): crops to the visible content (cuts off transparent edges).
- dominantColor(docOrPath, { ignoreWhite? }) -> { hex: "#RRGGBB", r, g, b, share }: the most common color,
  ignoring transparent pixels (and near-white ones with ignoreWhite). The source isn't changed.
- setSolidColor(layer, "#RRGGBB" or { r, g, b }): sets the color of a Solid Color fill layer.
Example (cut out a product photo): var img = openDocument(ctx.item.path); removeWhiteBackground(img);
  trimTransparent(img); exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png");
Example (masked cut-out: a PSD that keeps the mask, plus a transparent PNG):
  var img = openDocument(ctx.item.path); var photo = img.activeLayer;
  var cut = maskWhiteBackground(photo, { tolerance: params.tolerance });
  cropToBounds(img, cut.bounds, 4);
  ctx.output("psds", saveCopy(ctx.workDir, ctx.item.stem));
  ctx.output("pngs", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));
  To also keep the untouched photo, before masking: var original = photo.duplicate(); original.name = "Original";
  original.visible = false; (hidden layers aren't in the PNG).

`;

export const PHOTOSHOP_GUIDE_RULES = `Helper functions are Doppl's building blocks: don't call app.open, doc.save, doc.saveAs or doc.close yourself.
Prefer these helpers to raw executeAction code. Never wrap a step in try { ... } catch (e) {}: when it fails, the
routine still "succeeds" with a wrong result and nobody sees why. Let it throw, so Doppl can show the error and fix it.

`;

export const PHOTOSHOP_GUIDE_OUTRO = `Units are pixels while the script runs. Throw new Error("plain message") when something required is missing.
Return a small JSON-able summary or nothing.`;

export const PHOTOSHOP_MODEL_GUIDE = `${PHOTOSHOP_GUIDE_INTRO}${PHOTOSHOP_HELPER_CATALOG}${PHOTOSHOP_GUIDE_RULES.slice(PHOTOSHOP_GUIDE_RULES.indexOf("\n") + 1)}${PHOTOSHOP_GUIDE_OUTRO}`;

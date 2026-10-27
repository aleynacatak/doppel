export const PHOTOSHOP_MODEL_GUIDE = `Photoshop stages are ExtendScript (ES3, like InDesign): var only, no arrow functions, no let/const, no
template literals, no Array.forEach/map/filter/indexOf, no String.trim, no Object.keys, no JSON beyond JSON.parse/stringify.

The script is the BODY of function (doc, params, ctx) { ... }:
- doc: a working copy of the document the designer picked (stages with document "open"), already active; null for
  stages with document "none". The designer's own document is never touched.
- params: the routine's params (file and folder params are absolute paths picked at run time).
- ctx.item: the current item when the stage repeats (a data row object, or for files { path, name, stem, ext }).
- ctx.itemIndex (0-based), ctx.stages.<stageId>.outputs.<key> (arrays from earlier stages), ctx.workDir (this
  stage's working folder; put files that later stages need here).
- ctx.output(key, value): adds a value to one of the stage's declared outputs, e.g. ctx.output("files", path).
  Files written with exportImage go to the stage's first fileList output automatically if you don't call ctx.output.
- ctx.report(label, doc?): show a document (default: active) as a result with a preview.
- ctx.log(message), ctx.format("{name}_v1", { name: "a" }), ctx.safeFileName(s), ctx.join(folder, name),
  ctx.fileName(path), ctx.baseName(path) (file name without extension).

Helper functions (use these; don't call app.open, doc.save, doc.saveAs or doc.close yourself):
- openDocument(path) -> Document: opens a PSD/image; reused if Doppl already opened it in this stage. If the
  designer has it open, you get a duplicate. Documents stay open across the stage's items and are closed without
  saving when the stage ends.
- findLayer(nameOrPath, container?) -> layer: by name anywhere in the active document (or container), or by
  path "Group/Sub/Layer". Throws if missing.
- replaceSmartObject(layer, path) -> layer: replaces a Smart Object's contents with an image/PSD file.
- setTextLayer(layer, text): sets a text layer's text (reports fonts that aren't installed).
- setLayerVisible(layer, visible)
- exportImage(path, format, quality) -> path: exports the ACTIVE document as "png", "jpg" (quality 0-100) or "tif".
  The path must be inside a folder param or ctx.workDir. Use app.activeDocument = someDoc to choose what to export.
- saveCopy(folder?) -> path: saves a PSD copy named "<name>_doppl.psd" next to the source (or in a folder param).
  Only when the request explicitly asks for a saved PSD.
- closeWithoutSaving(doc?): closes a document Doppl opened (default: active) without saving.

Units are pixels while the script runs. Throw new Error("plain message") when something required is missing.
Return a small JSON-able summary or nothing.`;

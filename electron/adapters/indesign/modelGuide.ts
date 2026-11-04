// What the model needs to know to write an InDesign routine Doppl can run.
export const INDESIGN_MODEL_GUIDE = `InDesign routines are ExtendScript (ECMAScript 3). The script you write is the BODY of
function (doc, params, ctx) { ... } and runs inside InDesign. Doppl wraps it so the whole routine is one undo step.

Language limits (ES3): no let/const, arrow functions, template literals, classes or destructuring; no Array.prototype
forEach/map/filter/indexOf, no String.prototype.trim, no Object.keys, no Array.isArray. Use plain for loops and var.
Never use reserved words as names: long, int, short, char, byte, float, double, boolean, class, enum, package, etc.
JSON.stringify/JSON.parse are available.

In scope:
- doc: the InDesign Document to work on (a copy of the designer's file when they run "on a copy").
- params: the values the designer picked, keyed by your param keys. folder/file params are absolute paths (strings).
- app: the InDesign Application (DOM as documented by Adobe).
- ctx helpers:
  ctx.docName                          original document name without .indd (use it for {doc} in file names)
  ctx.ensureFolder(path) -> Folder     creates the folder if needed
  ctx.resolvePages(spec) -> Page[]     "all", "" or "1-3, 5" (page positions)
  ctx.pageIndex(page) -> number        1-based position
  ctx.pageRangeRef(page) -> string     page reference for export page ranges (pngExportPreferences.pageString etc.)
  ctx.format(pattern, vars) -> string  replaces {name} tokens, e.g. ctx.format("{doc}_{page}", {doc: ctx.docName, page: p.name})
  ctx.pad(n, width), ctx.safeFileName(s)
  ctx.marginBounds(page) -> [top, left, bottom, right] live area
  ctx.savePrefs(prefsObject, [propertyNames]) -> saved; ctx.restorePrefs(prefsObject, saved)  (always restore app-wide prefs in finally)
  ctx.preflight({minPpi}) -> findings     overset text, missing links/fonts, low-res images
  ctx.open(path, {showWindow?}) -> Document   opens a file the routine works on (a template…), hidden by default.
                                       Doppl shows you a template's text once it has the file: write for that text.
                                       A template usually holds plain sample text ("Name Surname"), not {{marks}}.
                                       A value you can't place is an Error: a result never keeps the sample text
  ctx.close(d)                         checks d (overset text, fonts, links, images), then closes it without saving;
                                       every document the routine opens or makes closes this way (never doc)
  ctx.exportPdf(d, path, {preset?, cropMarks?, bleedMarks?, registrationMarks?, useDocumentBleed?, pages?}) -> File
                                       the only way to export a PDF: the preset, then your marks and bleed on top
  ctx.fitText(frame, {minSize?}) -> {fits, size, from}   shrinks the frame's whole story until it fits, not below
                                       minSize (default 70% of its size); use it whenever text from data may not fit
  ctx.log(message)
  ctx.output({ key, label, filePath?, page?, pageIndex?, profile?: "print"|"web", details?: [{label, value}] })
      Call once per thing produced: each exported file (filePath = file.fsName) or each changed page (page/pageIndex).
      Doppl previews and quality-checks every output.
- Return a small object summarizing what happened (e.g. { exported: 4 }).

Never: saving over or writing into the designer's files and folders (doc.save(), SaveOptions.YES, exporting into a
folder param): they are read-only, and every file the routine makes goes into ctx.workDir (Doppl copies it to the
folder the designer picks); absolute paths or user names in the script (every location is a param); deleting files or
folders (.remove());
running other programs or scripts (.execute(), app.doScript, system calls, $.evalFile, eval, #include); network access
(Socket); quitting InDesign; showing dialogs or alerts; app.open and d.close (use ctx.open and ctx.close);
doc.exportFile for PDFs (use ctx.exportPdf); shrinking frame.texts in a loop (use ctx.fitText).`;

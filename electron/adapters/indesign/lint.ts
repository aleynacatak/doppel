import { lintExtendScript as lintAdobe } from "../adobe/lint";

// The designer's files and folders are read-only: a routine never saves over a document (Doppl saves its own copy)
// and writes its files into ctx.workDir. Documents it opens go through ctx.open and ctx.close, so Doppl can check them.
const INDESIGN_RULES: [RegExp, string][] = [
  [/\.save\s*\(\s*\)/, "doc.save() saves over the designer's file; export into ctx.workDir instead (Doppl saves the copy it works on)"],
  [/\bSaveOptions\.(YES|ASK)\b/, "close documents with ctx.close(d): it never saves, and Doppl never saves over the designer's files"],
  [/\bapp\.open\s*\(/, "open documents with ctx.open(path), not app.open: Doppl checks what the routine opens before ctx.close(d) closes it"],
  [/\.close\s*\(\s*SaveOptions\.NO\s*\)/, "close documents with ctx.close(d), not d.close(SaveOptions.NO): it checks them first (overset text, fonts, links, images)"],
  [
    // A loop that shrinks text while it overflows.
    /\b(while|for)\s*\([^)]*\.overflows[\s\S]{0,400}?\.pointSize\s*=|\bdo\s*\{[^}]*\.pointSize\s*=[^}]*\}\s*while\s*\([^)]*\.overflows/,
    "shrink text that doesn't fit with ctx.fitText(frame, { minSize }): changing frame.texts leaves the overset rest at full size",
  ],
  [
    /\.exportFile\s*\(\s*ExportFormat\.PDF_TYPE\b/,
    "export PDFs with ctx.exportPdf(doc, path, { preset, cropMarks, … }): with a preset in exportFile, InDesign ignores app.pdfExportPreferences (marks, bleed)",
  ],
];

/** Checks an InDesign routine body (`function (doc, params, ctx)`) before it runs. */
export function lintExtendScript(script: string): string[] {
  return lintAdobe(script, { appName: "InDesign", signature: "doc, params, ctx", extra: INDESIGN_RULES });
}

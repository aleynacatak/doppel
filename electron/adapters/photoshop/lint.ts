import { lintExtendScript } from "../adobe/lint";

// Photoshop stages save only through the helpers (exportImage, saveCopy) so files land in picked folders and the
// designer's own PSD is never overwritten; documents are closed only with closeWithoutSaving.
const PHOTOSHOP_RULES: [RegExp, string][] = [
  [/\.saveAs\s*\(|\.save\s*\(\s*\)|exportDocument\s*\(/, "save only with exportImage() or saveCopy(), never doc.save/saveAs/exportDocument"],
  [/\.close\s*\(/, "close documents only with closeWithoutSaving(doc)"],
  [/\.(write|writeln)\s*\(/, "writing files directly isn't allowed; use exportImage() or saveCopy()"],
  [/\bapp\.open\s*\(/, "open files with openDocument(path), not app.open"],
];

/** Checks a Photoshop routine body (`function (doc, params, ctx)`) before it runs. */
export function lintPhotoshopScript(script: string): string[] {
  return lintExtendScript(script, { appName: "Photoshop", signature: "doc, params, ctx", extra: PHOTOSHOP_RULES });
}

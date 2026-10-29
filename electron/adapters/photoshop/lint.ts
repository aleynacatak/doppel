import { lintExtendScript } from "../adobe/lint";

// Photoshop stages save only through the helpers (exportImage, saveCopy) so files land in picked folders and the
// designer's own PSD is never overwritten; documents are closed only with closeWithoutSaving.
const PHOTOSHOP_RULES: [RegExp, string][] = [
  [/\.saveAs\s*\(|\.save\s*\(\s*\)|exportDocument\s*\(/, "save only with exportImage() or saveCopy(), never doc.save/saveAs/exportDocument"],
  [/\.close\s*\(/, "close documents only with closeWithoutSaving(doc)"],
  [/\.(write|writeln)\s*\(/, "writing files directly isn't allowed; use exportImage() or saveCopy()"],
  [/\bapp\.open\s*\(/, "open files with openDocument(path), not app.open"],
];

// Photoshop commands (executeAction, selections, masks) wrapped in an empty catch: when one fails, the routine still
// "succeeds" with a wrong result (a mask that hides nothing, a background still there) and nobody learns why.
const RISKY = /executeAction|\.selection\.|applyDefringe|\.crop\s*\(|\.trim\s*\(/;

/** The bodies of try blocks whose catch is empty. */
export function hiddenFailures(script: string): string[] {
  const bodies: string[] = [];
  for (const m of script.matchAll(/\}\s*catch\s*\(\s*[\w$]+\s*\)\s*\{\s*\}/g)) {
    // Walk back from the try block's closing brace to its opening one.
    let depth = 0;
    let i = m.index!;
    for (; i >= 0; i--) {
      if (script[i] === "}") depth++;
      else if (script[i] === "{" && --depth === 0) break;
    }
    if (i < 0 || !/\btry\s*$/.test(script.slice(Math.max(0, i - 8), i))) continue;
    bodies.push(script.slice(i + 1, m.index!));
  }
  return bodies;
}

/** Checks a Photoshop routine body (`function (doc, params, ctx)`) before it runs. */
export function lintPhotoshopScript(script: string): string[] {
  const issues = lintExtendScript(script, { appName: "Photoshop", signature: "doc, params, ctx", extra: PHOTOSHOP_RULES });
  const hidden = hiddenFailures(script).filter((body) => RISKY.test(body)).length;
  if (hidden) {
    issues.push(
      `${hidden === 1 ? "A Photoshop step is" : `${hidden} Photoshop steps are`} wrapped in an empty catch (try { … } catch (e) {}): ` +
        "if it fails, the routine still succeeds with a wrong result. Let it throw, or use a helper such as maskWhiteBackground.",
    );
  }
  return issues;
}

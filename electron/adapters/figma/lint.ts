import vm from "node:vm";

// Checks a Figma routine before the plugin runs it. Figma's sandbox already blocks network and file
// access; this catches syntax errors and calls that would break the plugin or the designer's file.
const FORBIDDEN: [RegExp, string][] = [
  [/figma\.closePlugin\b/, "figma.closePlugin would stop the Doppel plugin"],
  [/figma\.showUI\b|figma\.ui\b|__html__/, "the routine can't open its own window"],
  [/\beval\s*\(|new\s+Function\b/, "eval and new Function aren't allowed"],
  [/setCurrentPageAsync|figma\.currentPage\s*=/, "routines work on doppel.page and mustn't switch pages"],
  [/\bgetNodeById\s*\(/, "use figma.getNodeByIdAsync (this file loads pages on demand)"],
];

export function lintFigmaScript(script: string): string[] {
  const issues: string[] = [];
  try {
    new vm.Script(`(async (figma, params, doppel) => {\n${script}\n})`, { filename: "routine.js" });
  } catch (err) {
    issues.push(`Syntax error: ${(err as Error).message}`);
  }
  for (const [re, message] of FORBIDDEN) if (re.test(script)) issues.push(message);
  return issues;
}

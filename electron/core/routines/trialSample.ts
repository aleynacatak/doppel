import type { ExportSample, FigmaActionStep } from "../types";

/** What an export action has that a look at the node doesn't take. */
const EXPORT_ONLY = ["format", "scale", "fileName", "folder", "output"];

/**
 * Exports are the slow part of a Figma trial, and a routine that exports 24 frames proves as much with a few. Of each
 * kind of export (same output, format and scale), a trial makes the first and the last, so a list that goes section by
 * section is tried at both ends. The others become a quick look at the node: a frame that isn't there still fails the
 * trial, and later actions can still use "$id". The routine itself keeps every export.
 */
export function sampleExports(actions: FigmaActionStep[]): { actions: FigmaActionStep[]; sample?: ExportSample } {
  const kinds = new Map<string, number[]>();
  actions.forEach((a, i) => {
    if (a.action !== "exportNode") return;
    const kind = JSON.stringify([a.output, a.format, a.scale]);
    kinds.set(kind, [...(kinds.get(kind) ?? []), i]);
  });
  const lists = [...kinds.values()];
  const skipped = new Set(lists.flatMap((list) => list.slice(1, -1)));
  if (!skipped.size) return { actions };
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  return {
    actions: actions.map((a, i) => (skipped.has(i) ? lookOnly(a) : a)),
    sample: { tried: total - skipped.size, total },
  };
}

function lookOnly(action: FigmaActionStep): FigmaActionStep {
  const look: FigmaActionStep = { ...action, action: "inspectNode", depth: 0 };
  for (const key of EXPORT_ONLY) delete look[key];
  return look;
}

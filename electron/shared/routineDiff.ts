import type { AppId, PortDef, SettingDef } from "../core/types";
import { compatible, describeSpec, inputSpec, outputSpec, typeTag } from "./ports";

// What changes between two versions of a routine, for the Refine review and flow updates: its plain-language
// steps, and its contract. A contract change is compatible when flows that use the routine keep working (a new
// optional input, a new output, a new setting with a default), and breaking when a flow's connections may stop
// fitting (a removed or renamed port, a changed type, a new required input, iterating differently).

export interface StepChange {
  kind: "same" | "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

/** Steps added, changed and removed, in order (a removed step next to an added one counts as changed). */
export function diffSteps(before: string[], after: string[]): StepChange[] {
  const n = before.length;
  const m = after.length;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // Longest common subsequence table.
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = same(before[i], after[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const raw: StepChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(before[i], after[j])) raw.push({ kind: "same", before: before[i++], after: after[j++] });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) raw.push({ kind: "removed", before: before[i++] });
    else raw.push({ kind: "added", after: after[j++] });
  }
  while (i < n) raw.push({ kind: "removed", before: before[i++] });
  while (j < m) raw.push({ kind: "added", after: after[j++] });
  // A step removed right before one added in its place reads as changed.
  const out: StepChange[] = [];
  for (const c of raw) {
    const last = out[out.length - 1];
    if (c.kind === "added" && last?.kind === "removed") out[out.length - 1] = { kind: "changed", before: last.before, after: c.after };
    else out.push(c);
  }
  return out;
}

/** The parts of a routine that flows rely on. */
export interface ContractShape {
  appId: AppId;
  inputs: PortDef[];
  outputs: PortDef[];
  settings: SettingDef[];
  iterate?: { input: string };
}

export interface ContractChange {
  breaking: boolean;
  /** Which part: an input, output or setting key, or "iterate". */
  key: string;
  message: string;
}

const what = (spec: Parameters<typeof describeSpec>[0]) => describeSpec(spec);

/** Every contract change between two versions, each compatible or breaking. */
export function contractChanges(before: ContractShape, after: ContractShape): ContractChange[] {
  const changes: ContractChange[] = [];
  const add = (breaking: boolean, key: string, message: string) => changes.push({ breaking, key, message });

  if (before.appId !== after.appId) add(true, "app", `It now works in ${after.appId} instead of ${before.appId}.`);
  if ((before.iterate?.input ?? "") !== (after.iterate?.input ?? "")) {
    const label = (key: string | undefined) => after.inputs.find((p) => p.key === key)?.label ?? before.inputs.find((p) => p.key === key)?.label ?? key;
    add(
      true,
      "iterate",
      after.iterate
        ? `It now runs once per item of “${label(after.iterate.input)}”${before.iterate ? ` (was “${label(before.iterate.input)}”)` : " (it ran once before)"}; its outputs change shape.`
        : `It no longer runs once per item of “${label(before.iterate!.input)}”; its outputs change shape.`,
    );
  }

  for (const old of before.inputs) {
    const now = after.inputs.find((p) => p.key === old.key);
    if (!now) {
      add(true, old.key, `Input “${old.label}” was removed${after.inputs.some((p) => p.label === old.label) ? " (its key changed)" : ""}.`);
      continue;
    }
    const oldSpec = inputSpec(old, before.appId);
    const newSpec = inputSpec(now, after.appId);
    if (!compatible(oldSpec, newSpec).ok) add(true, old.key, `Input “${now.label}” now takes ${what(newSpec)} (it took ${what(oldSpec)}).`);
    else if (typeTag(oldSpec) !== typeTag(newSpec)) add(false, old.key, `Input “${now.label}” now also takes ${what(newSpec)}.`);
    if (!old.required && now.required) add(true, old.key, `Input “${now.label}” is now required.`);
    if (old.required && !now.required) add(false, old.key, `Input “${now.label}” is now optional.`);
    if (old.label !== now.label) add(false, old.key, `Input “${old.label}” is now called “${now.label}”.`);
  }
  for (const now of after.inputs) {
    if (before.inputs.some((p) => p.key === now.key)) continue;
    if (now.required && now.type !== "document") add(true, now.key, `New required input “${now.label}”.`);
    else add(false, now.key, now.type === "document" ? `It now works on a document open in the app (“${now.label}”).` : `New optional input “${now.label}”.`);
  }

  for (const old of before.outputs) {
    const now = after.outputs.find((p) => p.key === old.key);
    if (!now) {
      add(true, old.key, `Output “${old.label}” was removed${after.outputs.some((p) => p.label === old.label) ? " (its key changed)" : ""}.`);
      continue;
    }
    const oldSpec = outputSpec(old, !!before.iterate, before.appId);
    const newSpec = outputSpec(now, !!after.iterate, after.appId);
    if (!compatible(newSpec, oldSpec).ok) add(true, old.key, `Output “${now.label}” now gives ${what(newSpec)} (it gave ${what(oldSpec)}).`);
    else if (typeTag(oldSpec) !== typeTag(newSpec)) add(false, old.key, `Output “${now.label}” now gives ${what(newSpec)}.`);
    if (old.label !== now.label) add(false, old.key, `Output “${old.label}” is now called “${now.label}”.`);
  }
  for (const now of after.outputs) {
    if (!before.outputs.some((p) => p.key === now.key)) add(false, now.key, `New output “${now.label}”.`);
  }

  for (const old of before.settings) {
    const now = after.settings.find((s) => s.key === old.key);
    if (!now) add(false, old.key, `Setting “${old.label}” was removed; flows that set it just ignore it.`);
    else if (old.type !== now.type) add(false, old.key, `Setting “${now.label}” is now ${now.type} (it was ${old.type}).`);
    else if (JSON.stringify(old.default) !== JSON.stringify(now.default)) add(false, old.key, `Setting “${now.label}” has a new default.`);
  }
  for (const now of after.settings) {
    if (before.settings.some((s) => s.key === now.key)) continue;
    const hasDefault = now.default !== undefined && now.default !== null && now.default !== "";
    if (now.required && !hasDefault) add(true, now.key, `New setting “${now.label}” has no default, so flows must set it.`);
    else add(false, now.key, `New setting “${now.label}”${hasDefault ? " with a default" : ""}.`);
  }
  return changes;
}

export const isBreaking = (changes: ContractChange[]) => changes.some((c) => c.breaking);

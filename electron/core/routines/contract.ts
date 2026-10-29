import { validateAuthoringActions } from "../../shared/figmaActions";
import { expandComposites } from "../blocks/composites";
import { blocks } from "../blocks/registry";
import type { HelperPins } from "../blocks/types";
import { PORT_TYPES, isListType, normalizeExtensions } from "../../shared/ports";
import { findPortabilityIssues } from "../services/portability";
import type { AppId, FigmaActionStep, PortDef, SettingDef, StageKind, ValidationError, ValidationResult } from "../types";
import { findPlaceholders } from "./placeholders";

// A routine can only be saved when this passes: it runs in one app, declares typed inputs, outputs and settings,
// uses only what it declares, and produces every output it promises. Errors are structured (where, what kind,
// a plain message) and use the routine's fields as the model writes them, so they can go back to the model.

export interface ValidatorApps {
  has(appId: AppId): boolean;
  stageKind(appId: AppId): StageKind;
  lintScript(appId: AppId, script: string): string[];
}

export interface ValidationSamples {
  /** Cell values of the sample data rows and names of sample files used while creating. */
  values: string[];
  /** Column names of the sample data per rows input. */
  columns?: Record<string, string[]>;
  /** Column names of each sample data file (mapped to inputs by the caller). */
  dataColumns?: string[][];
  /** Text that may legitimately appear in a routine (layer names, keys, column names). */
  allowed?: string[];
}

/** The parts of a routine the validator looks at. */
export interface RoutineContract {
  appId: AppId;
  kind: StageKind;
  script: string;
  actions?: FigmaActionStep[];
  /** Building block versions (none: a draft, checked against the newest blocks). */
  helpers?: HelperPins;
  inputs: PortDef[];
  outputs: PortDef[];
  settings: SettingDef[];
  iterate?: { input: string };
}

export const SETTING_TYPES = ["text", "number", "boolean", "select", "formatList"] as const;

const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const FILE_FIELDS = ["path", "name", "stem", "ext"];
const PARTS: Partial<Record<PortDef["type"], string[]>> = {
  file: FILE_FIELDS,
  folder: ["path", "name", "files"],
  fileList: ["files", "count"],
  rows: ["rows", "columns", "name", "count"],
};

const APP_NAMES: Record<string, string> = { indesign: "InDesign", figma: "Figma", photoshop: "Photoshop" };
const appName = (id: AppId) => APP_NAMES[id] ?? id;

function strings(value: unknown, at: string, out: { path: string; text: string }[]) {
  if (typeof value === "string") out.push({ path: at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Sample values worth looking for: long enough to be data, not structure. */
function significantSamples(samples: ValidationSamples, r: RoutineContract): string[] {
  const allowed = new Set(
    [
      ...(samples.allowed ?? []),
      ...r.inputs.map((p) => p.key),
      ...r.settings.map((s) => s.key),
      ...r.outputs.map((o) => o.key),
      ...Object.values(samples.columns ?? {}).flat(),
      ...(samples.dataColumns ?? []).flat(),
    ].map((s) => s.toLowerCase()),
  );
  return [...new Set(samples.values.map((v) => v.trim()))].filter(
    (v) => v.length >= 4 && !allowed.has(v.toLowerCase()) && !(/^\d+$/.test(v) && v.length < 6) && !/^(true|false|null|yes|no)$/i.test(v),
  );
}

/** The output a file export fills when it doesn't name one: the routine's first file output. */
export const firstFileOutput = (outputs: PortDef[]) => outputs.find((o) => o.type === "fileList" || o.type === "file");

/** Output keys the body fills: named in actions or scripts, or the first file output when the body exports files. */
export function producedOutputs(r: Pick<RoutineContract, "kind" | "script" | "actions" | "outputs">): Set<string> {
  const produced = new Set<string>();
  const first = firstFileOutput(r.outputs);
  if (r.kind === "actions") {
    for (const a of r.actions ?? []) if (typeof a.output === "string") produced.add(a.output);
    if (first && (r.actions ?? []).some((a) => a.action === "exportNode" && typeof a.output !== "string")) produced.add(first.key);
  } else {
    for (const m of r.script.matchAll(/\bctx\.(?:output|stageOutput)\(\s*["']([A-Za-z_]\w*)["']/g)) produced.add(m[1]);
    if (first && /\b(exportImage|saveCopy|exportFile)\s*\(|\bctx\.output\(\s*\{/.test(r.script)) produced.add(first.key);
  }
  return produced;
}

export function validateRoutine(r: RoutineContract, apps: ValidatorApps, samples?: ValidationSamples, expectedApp?: AppId): ValidationResult {
  const errors: ValidationError[] = [];
  const add = (path: string, code: ValidationError["code"], message: string) => errors.push({ path, code, message });

  if (expectedApp && r.appId !== expectedApp) {
    add("app", "one-app", `This routine runs in ${appName(expectedApp)}, not ${appName(r.appId) || "another app"}. A routine works in one app; work in another app is another routine of the flow.`);
  }
  if (!apps.has(r.appId)) {
    add("app", "unknown-app", `Doppl can't run routines in "${r.appId}".`);
    return { ok: false, errors };
  }
  const kind = apps.stageKind(r.appId);
  if (r.kind !== kind) add("kind", "schema", `${appName(r.appId)} routines are "${kind}" routines, not "${r.kind}".`);

  // The contract.
  const names = new Set<string>();
  for (const [i, p] of r.inputs.entries()) {
    if (!ID.test(p.key ?? "")) add(`inputs[${i}].key`, "schema", `Input key "${p.key}" must start with a letter and use only letters, digits and _.`);
    else if (names.has(p.key)) add(`inputs[${i}].key`, "duplicate-id", `Two inputs or settings are called "${p.key}".`);
    names.add(p.key);
    if (!PORT_TYPES.includes(p.type)) add(`inputs[${i}].type`, "schema", `Input type "${p.type}" isn't one of ${PORT_TYPES.join(", ")}.`);
  }
  if (r.inputs.filter((p) => p.type === "document").length > 1) {
    add("inputs", "contract", "A routine works on at most one document (one input of type document).");
  }
  for (const [i, s] of r.settings.entries()) {
    if (!ID.test(s.key ?? "")) add(`settings[${i}].key`, "schema", `Setting key "${s.key}" must start with a letter and use only letters, digits and _.`);
    else if (names.has(s.key)) add(`settings[${i}].key`, "duplicate-id", `Two inputs or settings are called "${s.key}".`);
    names.add(s.key);
    if (!SETTING_TYPES.includes(s.type)) add(`settings[${i}].type`, "schema", `Setting type "${s.type}" isn't one of ${SETTING_TYPES.join(", ")}. Files, folders and data are inputs.`);
    if (s.type === "select" && !s.options?.length && !s.optionsSource) add(`settings[${i}].options`, "schema", `Setting "${s.key}" is a select without options.`);
    if (s.type === "formatList" && !s.options?.length) add(`settings[${i}].options`, "schema", `Setting "${s.key}" is a formatList without options.`);
  }
  const outKeys = new Set<string>();
  for (const [i, o] of r.outputs.entries()) {
    if (!ID.test(o.key ?? "")) add(`outputs[${i}].key`, "schema", `Output key "${o.key}" must start with a letter and use only letters, digits and _.`);
    else if (outKeys.has(o.key)) add(`outputs[${i}].key`, "duplicate-id", `Two outputs are called "${o.key}".`);
    outKeys.add(o.key);
    if (!PORT_TYPES.includes(o.type)) add(`outputs[${i}].type`, "schema", `Output type "${o.type}" isn't one of ${PORT_TYPES.join(", ")}.`);
  }

  // Iteration.
  const iterPort = r.iterate ? r.inputs.find((p) => p.key === r.iterate!.input) : undefined;
  if (r.iterate) {
    if (!iterPort) add("iterate.input", "contract", `iterate.input "${r.iterate.input}" isn't one of the inputs.`);
    else if (!isListType(iterPort.type)) add("iterate.input", "contract", `A routine iterates over a rows or fileList input; "${iterPort.key}" is ${iterPort.type}.`);
  }
  const iterates = !!iterPort && isListType(iterPort.type);
  const columnsOf = (p: PortDef) => (p.columns?.length ? p.columns : (samples?.columns?.[p.key] ?? []));
  const joinable = (key: string) => {
    const p = r.inputs.find((x) => x.key === key);
    return p && isListType(p.type) && p.key !== iterPort?.key ? p : undefined;
  };

  const checkExpr = (expr: string): string | null => {
    const parts = expr.split(".");
    switch (parts[0]) {
      case "inputs": {
        const port = r.inputs.find((p) => p.key === parts[1]);
        if (!port) return `{{${expr}}}: there is no input "${parts[1] ?? ""}" (inputs: ${r.inputs.map((p) => p.key).join(", ") || "none"})`;
        if (parts.length === 2) return null;
        const allowed = PARTS[port.type] ?? [];
        if (allowed.includes(parts[2]) || (port.type === "fileList" && /^\d+$/.test(parts[2]))) return null;
        return `{{${expr}}}: a ${port.type} input has ${allowed.length ? allowed.map((a) => `.${a}`).join(", ") : "no parts"}`;
      }
      case "settings":
        if (!r.settings.some((s) => s.key === parts[1])) return `{{${expr}}}: there is no setting "${parts[1] ?? ""}" (settings: ${r.settings.map((s) => s.key).join(", ") || "none"})`;
        return parts.length === 2 ? null : `{{${expr}}}: a setting has no parts`;
      case "item": {
        if (!iterates) return `{{${expr}}} only exists in a routine that iterates (set "iterate")`;
        if (parts.length === 1) return null;
        if (iterPort!.type === "fileList" && !FILE_FIELDS.includes(parts[1])) return `{{${expr}}}: file items have ${FILE_FIELDS.join(", ")}`;
        const cols = iterPort!.type === "rows" ? columnsOf(iterPort!) : [];
        if (cols.length && !cols.includes(parts[1])) return `{{${expr}}}: the rows have no "${parts[1]}" column (columns: ${cols.join(", ")})`;
        return null;
      }
      case "itemIndex":
        return iterates && parts.length === 1 ? null : `{{${expr}}} only exists in a routine that iterates`;
      case "matched": {
        if (!iterates) return `{{${expr}}} only exists in a routine that iterates`;
        const port = joinable(parts[1] ?? "");
        if (!port) return `{{${expr}}}: "${parts[1] ?? ""}" isn't a second list input (rows or fileList, other than the one the routine iterates over)`;
        if (parts.length === 2) return null;
        if (port.type === "fileList" && !FILE_FIELDS.includes(parts[2])) return `{{${expr}}}: a matched file has ${FILE_FIELDS.join(", ")}`;
        const cols = port.type === "rows" ? columnsOf(port) : [];
        if (cols.length && !cols.includes(parts[2])) return `{{${expr}}}: "${port.key}" rows have no "${parts[2]}" column`;
        return null;
      }
      case "params":
        return `{{${expr}}}: use {{inputs.${parts[1] ?? "<key>"}}} for an input or {{settings.${parts[1] ?? "<key>"}}} for a setting`;
      case "stage":
        return `{{${expr}}}: a routine gets another routine's results through one of its inputs, e.g. {{inputs.<key>}}`;
      default:
        return `{{${expr}}} isn't a placeholder Doppl knows (use inputs, settings, item, itemIndex or matched)`;
    }
  };

  // The body.
  if (r.kind === "actions") {
    const actions = r.actions ?? [];
    if (actions.length === 0) add("actions", "schema", "A Figma routine needs an action list.");
    else {
      // Building blocks expand into catalog actions first; the expanded list is what runs.
      const expanded = expandComposites(actions as Record<string, unknown>[], blocks.composites(r.helpers, !r.helpers));
      for (const problem of expanded.problems) add("actions", "schema", problem);
      const res = validateAuthoringActions({ actions: expanded.actions });
      if (!res.ok) for (const issue of res.issues.slice(0, 20)) add(expanded.used.length ? `${issue.path} (after expanding blocks)` : issue.path, "schema", issue.message);
    }
    for (const ph of findPlaceholders(actions, "actions")) {
      const problem = checkExpr(ph.expr);
      if (problem) add(ph.path, "unresolved-placeholder", problem);
    }
    for (const s of strings(actions, "actions", [])) {
      const issue = findPortabilityIssues(s.text.replace(/\{\{[^}]*\}\}/g, ""))[0];
      if (issue) add(s.path, "absolute-path", `${issue.message}: "${s.text}". Use a file or folder input instead.`);
    }
  } else if (!r.script.trim()) {
    add("script", "schema", "A script routine needs a script.");
  } else {
    for (const msg of apps.lintScript(r.appId, r.script)) add("script", "lint", msg);
    for (const issue of findPortabilityIssues(r.script)) {
      add(`script (line ${issue.line})`, "absolute-path", `${issue.message}: ${issue.text}. Use a file or folder input instead.`);
    }
    for (const m of new Set([...r.script.matchAll(/\bparams\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))) {
      if (!names.has(m)) add("script", "unresolved-placeholder", `params.${m} isn't one of the routine's inputs or settings (${[...names].join(", ") || "none"}).`);
    }
    for (const m of new Set([...r.script.matchAll(/\bctx\.matched\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))) {
      if (!iterates || !joinable(m)) add("script", "unresolved-placeholder", `ctx.matched.${m}: "${m}" isn't a second list input of a routine that iterates.`);
    }
    if (!iterates && /\bctx\.item\b/.test(r.script)) add("script", "contract", 'ctx.item only exists in a routine that iterates (set "iterate").');
    if (/\bctx\.stages\b/.test(r.script)) add("script", "contract", "ctx.stages is gone: a routine gets other routines' results through its inputs (params.<key>).");
    if (/\bBridgeTalk\b/.test(r.script)) add("script", "one-app", `A routine works in one app (${appName(r.appId)}); BridgeTalk would reach into another one. Make that another routine of the flow.`);
  }

  // Every declared output is produced.
  const produced = producedOutputs(r);
  for (const [i, o] of r.outputs.entries()) {
    if (produced.has(o.key)) continue;
    const how =
      r.kind === "actions"
        ? `Add "output": "${o.key}" to the action that makes it${firstFileOutput(r.outputs)?.key === o.key ? " (or export files with exportNode)" : ""}.`
        : r.appId === "indesign"
          ? `Call ctx.stageOutput("${o.key}", value) for each value.`
          : `Call ctx.output("${o.key}", value) for each value.`;
    add(`outputs[${i}]`, "contract", `Output "${o.key}" is never produced. ${how}`);
  }
  for (const key of produced) {
    if (!outKeys.has(key)) add("outputs", "contract", `The routine produces "${key}", but it isn't one of its outputs. Declare it in "outputs".`);
  }

  // Literal data copied from the samples.
  const sampleValues = samples ? significantSamples(samples, r) : [];
  if (sampleValues.length) {
    const texts =
      r.kind === "actions"
        ? strings(r.actions ?? [], "actions", []).map((s) => ({ ...s, text: s.text.replace(/\{\{[^}]*\}\}/g, " ") }))
        : [...r.script.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)].map((m) => ({ path: "script", text: m[1] ?? m[2] ?? "" }));
    for (const value of sampleValues) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(value)}($|[^\\p{L}\\p{N}])`, "u");
      const hit = texts.find((t) => re.test(t.text));
      if (hit) add(hit.path, "sample-data", `"${value}" is copied from the sample data. Use a placeholder such as {{item.<column>}} so every item gets its own value.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Cleans a port the model or a file wrote: known type, normalized extensions, columns as strings. */
export function cleanPort(raw: Record<string, any>): PortDef | null {
  const key = String(raw?.key ?? "").trim();
  const type = raw?.type as PortDef["type"];
  if (!key || !PORT_TYPES.includes(type)) return null;
  const extensions = normalizeExtensions(raw.extensions);
  const columns = Array.isArray(raw.columns) ? raw.columns.filter((c: unknown): c is string => typeof c === "string" && !!c.trim()).map((c: string) => c.trim()) : [];
  return {
    key,
    label: String(raw.label || key).slice(0, 80),
    type,
    required: raw.required !== false,
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim().slice(0, 200) } : {}),
    ...((type === "file" || type === "fileList") && extensions.length ? { extensions } : {}),
    ...(type === "rows" && columns.length ? { columns } : {}),
  };
}

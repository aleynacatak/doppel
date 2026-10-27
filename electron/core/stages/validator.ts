import { validateAuthoringActions } from "../../shared/figmaActions";
import { findPortabilityIssues } from "../services/portability";
import type { AppId, ParamDef, Stage, ValidationError, ValidationResult } from "../types";
import { findPlaceholders, onlyPlaceholder } from "./placeholders";

// A routine can only be saved when this passes. Errors are structured (where, what kind, a plain message), so the
// creation flow can send them back to the model to fix.

export interface ValidatorApps {
  has(appId: AppId): boolean;
  stageKind(appId: AppId): "actions" | "script";
  lintScript(appId: AppId, script: string): string[];
}

export interface ValidationSamples {
  /** Cell values of the sample data rows and names of sample files used while creating. */
  values: string[];
  /** Column names of the sample data per dataFile param. */
  columns?: Record<string, string[]>;
  /** Column names of each sample data file (mapped to params by the caller). */
  dataColumns?: string[][];
  /** Text that may legitimately appear in a routine (layer names, param keys, column names). */
  allowed?: string[];
}

const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const FILE_FIELDS = ["path", "name", "stem", "ext"];

type ItemSource = { kind: "rows"; param: string } | { kind: "files" } | { kind: "values" } | null;

/** What a stage repeats over, if it is a valid list placeholder. */
function itemSource(expr: string, params: ParamDef[], earlier: Stage[]): ItemSource | "invalid" {
  const parts = expr.split(".");
  if (parts[0] === "params" && parts.length === 3) {
    const def = params.find((p) => p.key === parts[1]);
    if (def?.type === "dataFile" && parts[2] === "rows") return { kind: "rows", param: def.key };
    if (def?.type === "folder" && parts[2] === "files") return { kind: "files" };
    return "invalid";
  }
  if (parts[0] === "stage" && parts.length === 4 && parts[2] === "outputs") {
    const stage = earlier.find((s) => s.id === parts[1]);
    const output = stage?.outputs.find((o) => o.key === parts[3]);
    if (!output) return "invalid";
    return output.type === "fileList" || output.type === "file" ? { kind: "files" } : { kind: "values" };
  }
  return "invalid";
}

function checkExpr(expr: string, params: ParamDef[], earlier: Stage[], source: ItemSource, columns: Record<string, string[]>): string | null {
  const parts = expr.split(".");
  switch (parts[0]) {
    case "params": {
      const def = params.find((p) => p.key === parts[1]);
      if (!def) return `{{${expr}}}: there is no param "${parts[1] ?? ""}"`;
      if (parts.length === 2) return null;
      const allowed = def.type === "dataFile" ? ["rows", "columns", "name"] : def.type === "folder" ? ["files", "name"] : [];
      if (parts.length === 3 && allowed.includes(parts[2])) return null;
      return `{{${expr}}}: a ${def.type} param has ${allowed.length ? allowed.map((a) => `.${a}`).join(", ") : "no parts"}`;
    }
    case "item": {
      if (!source) return `{{${expr}}} is only available in a stage that repeats`;
      if (parts.length === 1) return null;
      if (source.kind === "files" && !FILE_FIELDS.includes(parts[1])) return `{{${expr}}}: file items have ${FILE_FIELDS.join(", ")}`;
      if (source.kind === "rows") {
        const cols = columns[source.param];
        if (cols?.length && !cols.includes(parts[1])) return `{{${expr}}}: the data has no "${parts[1]}" column (columns: ${cols.join(", ")})`;
      }
      return null;
    }
    case "itemIndex":
      return source && parts.length === 1 ? null : `{{${expr}}} is only available in a stage that repeats`;
    case "stage": {
      const stage = earlier.find((s) => s.id === parts[1]);
      if (!stage) return `{{${expr}}}: "${parts[1] ?? ""}" isn't an earlier stage`;
      if (parts[2] !== "outputs" || !parts[3]) return `{{${expr}}}: use {{stage.${parts[1]}.outputs.<key>}}`;
      if (!stage.outputs.some((o) => o.key === parts[3])) return `{{${expr}}}: stage "${stage.id}" has no output "${parts[3]}"`;
      return null;
    }
    default:
      return `{{${expr}}} isn't a placeholder Doppl knows (use params, item, itemIndex or stage)`;
  }
}

function strings(value: unknown, at: string, out: { path: string; text: string }[]) {
  if (typeof value === "string") out.push({ path: at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Sample values worth looking for: long enough to be data, not structure. */
function significantSamples(samples: ValidationSamples, params: ParamDef[]): string[] {
  const allowed = new Set(
    [...(samples.allowed ?? []), ...params.map((p) => p.key), ...Object.values(samples.columns ?? {}).flat(), ...(samples.dataColumns ?? []).flat()].map((s) => s.toLowerCase()),
  );
  return [...new Set(samples.values.map((v) => v.trim()))].filter(
    (v) => v.length >= 4 && !allowed.has(v.toLowerCase()) && !(/^\d+$/.test(v) && v.length < 6) && !/^(true|false|null|yes|no)$/i.test(v),
  );
}

export function validateRoutine(routine: { params: ParamDef[]; stages: Stage[] }, apps: ValidatorApps, samples?: ValidationSamples): ValidationResult {
  const errors: ValidationError[] = [];
  const add = (path: string, code: ValidationError["code"], message: string) => errors.push({ path, code, message });
  const { params, stages } = routine;
  const columns: Record<string, string[]> = { ...(samples?.columns ?? {}) };
  for (const p of params) if (p.type === "dataFile" && p.columns?.length && !columns[p.key]) columns[p.key] = p.columns;
  const sampleValues = samples ? significantSamples(samples, params) : [];

  if (!Array.isArray(stages) || stages.length === 0) add("stages", "schema", "A routine needs at least one stage.");
  const keys = new Set<string>();
  for (const [i, p] of params.entries()) {
    if (keys.has(p.key)) add(`params[${i}].key`, "duplicate-id", `Two params are called "${p.key}".`);
    keys.add(p.key);
  }

  const seen = new Set<string>();
  for (const [i, stage] of (stages ?? []).entries()) {
    const at = `stages[${i}]`;
    const earlier = stages.slice(0, i);
    if (!ID.test(stage.id ?? "")) add(`${at}.id`, "schema", `Stage id "${stage.id}" must start with a letter and use only letters, digits and _.`);
    if (seen.has(stage.id)) add(`${at}.id`, "duplicate-id", `Two stages have the id "${stage.id}".`);
    seen.add(stage.id);
    if (!apps.has(stage.appId)) {
      add(`${at}.appId`, "unknown-app", `Doppl can't run stages in "${stage.appId}".`);
      continue;
    }
    const kind = apps.stageKind(stage.appId);
    if (stage.kind !== kind) add(`${at}.kind`, "schema", `Stages in ${stage.appId} are "${kind}" stages, not "${stage.kind}".`);
    if (stage.document !== undefined && stage.document !== "open" && stage.document !== "none") add(`${at}.document`, "schema", 'document must be "open" or "none".');
    const outKeys = new Set<string>();
    for (const [j, o] of (stage.outputs ?? []).entries()) {
      if (!ID.test(o.key ?? "")) add(`${at}.outputs[${j}].key`, "schema", `Output key "${o.key}" must be an identifier.`);
      if (outKeys.has(o.key)) add(`${at}.outputs[${j}].key`, "duplicate-id", `Two outputs are called "${o.key}".`);
      outKeys.add(o.key);
      if (!["fileList", "file", "nodeList", "data"].includes(o.type)) add(`${at}.outputs[${j}].type`, "schema", `Output type "${o.type}" isn't fileList, file, nodeList or data.`);
    }

    // What the stage repeats over.
    let source: ItemSource = null;
    if (stage.repeat) {
      const expr = onlyPlaceholder(stage.repeat.over);
      const found = expr ? itemSource(expr, params, earlier) : "invalid";
      if (found === "invalid") {
        add(
          `${at}.repeat.over`,
          expr?.startsWith("stage.") && !earlier.some((s) => s.id === expr.split(".")[1]) ? "stage-order" : "unresolved-placeholder",
          `repeat.over must be one placeholder for a list: {{params.<dataFile>.rows}}, {{params.<folder>.files}} or {{stage.<earlier stage>.outputs.<key>}}; got "${stage.repeat.over}".`,
        );
      } else source = found;
    }

    // Placeholders in the body (action lists) and in the declared inputs.
    const placeholders = [
      ...(stage.kind === "actions" ? findPlaceholders(stage.body, "body") : []),
      ...findPlaceholders(stage.inputs ?? [], "inputs"),
    ];
    for (const ph of placeholders) {
      const problem = checkExpr(ph.expr, params, earlier, source, columns);
      if (problem) {
        const code = ph.expr.startsWith("stage.") && stages.some((s, k) => s.id === ph.expr.split(".")[1] && k >= i) ? "stage-order" : "unresolved-placeholder";
        add(`${at}.${ph.path}`, code, problem);
      }
    }

    // The body itself.
    if (stage.kind === "actions") {
      const res = validateAuthoringActions(stage.body);
      if (!res.ok) for (const issue of res.issues.slice(0, 20)) add(`${at}.body.${issue.path}`, "schema", issue.message);
      for (const s of strings(stage.body, `${at}.body`, [])) {
        const issue = findPortabilityIssues(s.text.replace(/\{\{[^}]*\}\}/g, ""))[0];
        if (issue) add(s.path, "absolute-path", `${issue.message}: "${s.text}". Use a file or folder param instead.`);
      }
    } else if (typeof stage.body !== "string" || !stage.body.trim()) {
      add(`${at}.body`, "schema", "A script stage needs a script.");
    } else {
      for (const msg of apps.lintScript(stage.appId, stage.body)) add(`${at}.body`, "lint", msg);
      for (const issue of findPortabilityIssues(stage.body)) {
        add(`${at}.body (line ${issue.line})`, "absolute-path", `${issue.message}: ${issue.text}. Use a file or folder param instead.`);
      }
    }

    // Literal data copied from the samples.
    if (sampleValues.length) {
      const texts =
        stage.kind === "actions"
          ? strings(stage.body, `${at}.body`, []).map((s) => ({ ...s, text: s.text.replace(/\{\{[^}]*\}\}/g, " ") }))
          : [...String(stage.body).matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)].map((m) => ({ path: `${at}.body`, text: m[1] ?? m[2] ?? "" }));
      for (const value of sampleValues) {
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(value)}($|[^\\p{L}\\p{N}])`, "u");
        const hit = texts.find((t) => re.test(t.text));
        if (hit) {
          add(hit.path, "sample-data", `"${value}" is copied from the sample data. Use a placeholder such as {{item.<column>}} so every row gets its own value.`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

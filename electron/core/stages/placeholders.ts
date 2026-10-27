// Placeholders tie a routine's stages together: {{params.<key>}}, {{item.<field>}}, {{itemIndex}} and
// {{stage.<stageId>.outputs.<key>}}. The core expands them per item right before a stage runs.

const ANY = /\{\{\s*([A-Za-z_$][\w$.]*)\s*\}\}/g;
const ONLY = /^\{\{\s*([A-Za-z_$][\w$.]*)\s*\}\}$/;

/** Values that stand for a path but also have parts, e.g. a data file: {{params.data}} is the path, {{params.data.rows}} its rows. */
export interface Composite {
  __value: unknown;
  [part: string]: unknown;
}

export interface PlaceholderScope {
  params: Record<string, unknown>;
  item?: unknown;
  /** 0-based; {{itemIndex}} is 1-based. */
  itemIndex?: number;
  stages: Record<string, { outputs: Record<string, unknown[]> }>;
}

export class PlaceholderError extends Error {
  constructor(readonly expr: string) {
    super(`{{${expr}}} has no value here`);
    this.name = "PlaceholderError";
  }
}

const isComposite = (v: unknown): v is Composite => !!v && typeof v === "object" && !Array.isArray(v) && "__value" in v;

/** Every placeholder in a JSON-like value, with where it is ("actions[2].text"). */
export function findPlaceholders(value: unknown, at = ""): { path: string; expr: string }[] {
  const out: { path: string; expr: string }[] = [];
  if (typeof value === "string") {
    for (const m of value.matchAll(ANY)) out.push({ path: at, expr: m[1] });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findPlaceholders(v, `${at}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) out.push(...findPlaceholders(v, at ? `${at}.${k}` : k));
  }
  return out;
}

/** The expression of a value that is exactly one placeholder ("{{params.data.rows}}" → "params.data.rows"). */
export function onlyPlaceholder(value: unknown): string | null {
  return typeof value === "string" ? (value.match(ONLY)?.[1] ?? null) : null;
}

/** Looks an expression up in the scope. */
export function resolveExpr(expr: string, scope: PlaceholderScope): { found: boolean; value: unknown } {
  const parts = expr.split(".");
  let cur: unknown;
  let rest: string[];
  switch (parts[0]) {
    case "params":
      cur = scope.params;
      rest = parts.slice(1);
      break;
    case "item":
      if (scope.item === undefined) return { found: false, value: undefined };
      cur = scope.item;
      rest = parts.slice(1);
      break;
    case "itemIndex":
      return parts.length === 1 && scope.itemIndex !== undefined ? { found: true, value: scope.itemIndex + 1 } : { found: false, value: undefined };
    case "stage":
      cur = scope.stages;
      rest = parts.slice(1);
      break;
    default:
      return { found: false, value: undefined };
  }
  for (const part of rest) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, part)) cur = (cur as Record<string, unknown>)[part];
    else return { found: false, value: undefined };
  }
  if (isComposite(cur)) cur = cur.__value;
  return cur === undefined ? { found: false, value: undefined } : { found: true, value: cur };
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(asText).join(", ");
  if (isComposite(v)) return asText(v.__value);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Replaces placeholders in a JSON-like value. A string that is exactly one placeholder becomes the raw value
 * (numbers stay numbers, lists stay lists); placeholders inside longer text become text.
 * Throws PlaceholderError for a placeholder with no value.
 */
export function expandValue<T>(value: T, scope: PlaceholderScope): T {
  if (typeof value === "string") {
    const only = onlyPlaceholder(value);
    if (only) {
      const r = resolveExpr(only, scope);
      if (!r.found) throw new PlaceholderError(only);
      return structuredClone(r.value) as T;
    }
    return value.replace(ANY, (_all, expr: string) => {
      const r = resolveExpr(expr, scope);
      if (!r.found) throw new PlaceholderError(expr);
      return asText(r.value);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandValue(v, scope)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandValue(v, scope);
    return out as T;
  }
  return value;
}

/** A file as a stage item: {{item}} is its path; {{item.name}}, {{item.stem}}, {{item.ext}}, {{item.path}}. */
export function fileItem(filePath: string): Composite {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  return {
    __value: filePath,
    path: filePath,
    name,
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}

/** Plain JSON for scripts and the plugin: composites become their value plus their parts. */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== "__value") out[k] = plain(v);
    return out;
  }
  return value;
}

import type { CompositeAction } from "./types";

// Figma building blocks are composite actions: { "action": "block", "name": "fillTemplate", "args": {…}, "id"?,
// "output"? } expands into catalog actions before the routine is checked and before the plugin sees it. Inside a
// block's template, {{args.<param>}} is an argument (a value that is exactly one placeholder keeps its type; a field
// whose argument wasn't given is left out), { "$each": "{{args.<object or list>}}", "do": action } repeats an action
// with {{each.key}} / {{each.value}} (objects) or {{each.item}} / {{each.index}} (lists), and inner ids are prefixed
// with the block's id so two uses never clash ("$<block id>" is the block's result).

const ONLY = /^\{\{\s*([\w.]+)\s*\}\}$/;
const ANY = /\{\{\s*([\w.]+)\s*\}\}/g;
const MISSING = Symbol("missing");

type Vars = Record<string, unknown>;

function lookup(path: string, vars: Vars): unknown {
  if (!(path in vars) && !path.startsWith("args.") && !path.startsWith("each.")) return undefined;
  return path in vars ? vars[path] : MISSING;
}

/** Substitutes block placeholders; other placeholders ({{item.x}}…) stay for Doppl's own resolution later. */
function substitute(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") {
    const only = ONLY.exec(value);
    if (only && (only[1].startsWith("args.") || only[1].startsWith("each."))) return lookup(only[1], vars);
    return value.replace(ANY, (all, path: string) => {
      if (!path.startsWith("args.") && !path.startsWith("each.")) return all;
      const v = lookup(path, vars);
      return v === MISSING || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars)).filter((v) => v !== MISSING);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = substitute(v, vars);
      if (s !== MISSING) out[k] = s;
    }
    return out;
  }
  return value;
}

/** Prefixes inner ids and the "$id" references to them. */
function renameIds(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (all, id: string) => (names.has(id) ? `$${names.get(id)}` : all));
  }
  if (Array.isArray(value)) return value.map((v) => renameIds(v, names));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "id" && typeof v === "string" ? (names.get(v) ?? v) : renameIds(v, names)]));
  return value;
}

export interface Expanded {
  actions: Record<string, unknown>[];
  /** Plain-language problems with block uses (unknown block, missing argument). */
  problems: string[];
  /** Block names the list uses. */
  used: string[];
}

/** An action list with every block use replaced by its catalog actions. */
export function expandComposites(actions: Record<string, unknown>[], composites: Record<string, CompositeAction>): Expanded {
  const out: Record<string, unknown>[] = [];
  const problems: string[] = [];
  const used = new Set<string>();
  for (const [i, action] of actions.entries()) {
    if (action.action !== "block") {
      out.push(action);
      continue;
    }
    const name = String(action.name ?? "");
    const def = composites[name];
    if (!def) {
      problems.push(`actions[${i}]: there's no building block "${name}" (blocks: ${Object.keys(composites).join(", ") || "none"}).`);
      continue;
    }
    used.add(name);
    const args = (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>;
    const missing = def.params.filter((p) => !p.optional && args[p.name] === undefined).map((p) => p.name);
    if (missing.length) {
      problems.push(`actions[${i}] (block ${name}): give ${missing.map((m) => `"${m}"`).join(", ")} in "args".`);
      continue;
    }
    const vars: Vars = Object.fromEntries(Object.entries({ ...args, ...(action.output !== undefined ? { output: action.output } : {}) }).map(([k, v]) => [`args.${k}`, v]));
    // Inner ids: "copy" → "<block id>_copy"; the block's result takes the block's own id.
    const prefix = typeof action.id === "string" ? action.id : `block${i + 1}`;
    const names = new Map<string, string>();
    const collect = (a: Record<string, unknown>) => typeof a.id === "string" && names.set(a.id, def.result === a.id && typeof action.id === "string" ? action.id : `${prefix}_${a.id}`);
    for (const a of def.actions) collect((a.$each ? a.do : a) as Record<string, unknown>);
    for (const template of def.actions) {
      if (template.$each !== undefined) {
        const list = substitute(template.$each, vars);
        if (list === MISSING || list === undefined || list === null) continue;
        const entries: Vars[] = Array.isArray(list)
          ? list.map((item, n) => ({ "each.item": item, "each.index": n + 1 }))
          : typeof list === "object"
            ? Object.entries(list as Record<string, unknown>).map(([key, value]) => ({ "each.key": key, "each.value": value }))
            : [];
        for (const e of entries) out.push(renameIds(substitute(template.do, { ...vars, ...e }), names) as Record<string, unknown>);
      } else {
        out.push(renameIds(substitute(template, vars), names) as Record<string, unknown>);
      }
    }
  }
  return { actions: out, problems, used: [...used] };
}

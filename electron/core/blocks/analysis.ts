import type { RoutineStep } from "../types";
import type { HelperDef } from "./types";

// What a routine's code is made of: calls to building blocks (tested), and code written for this routine (custom).
// Scripts mark where each step's code starts with a "// step <n>" line; without markers, the whole script counts as
// one block for every step. Figma action lists are always tested (catalog actions and composite blocks).

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "with", "do", "else", "try", "throw", "delete", "in", "instanceof", "void", "var"]);
/** Plain JavaScript, not app automation: never makes code custom. */
const NEUTRAL_GLOBALS = new Set([
  "parseInt",
  "parseFloat",
  "Number",
  "String",
  "Boolean",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "Array",
  "Object",
  "JSON",
  "UnitValue",
]);
const NEUTRAL_METHODS = new Set([
  "push",
  "join",
  "split",
  "replace",
  "slice",
  "substring",
  "substr",
  "toLowerCase",
  "toUpperCase",
  "indexOf",
  "lastIndexOf",
  "charAt",
  "charCodeAt",
  "match",
  "test",
  "exec",
  "toFixed",
  "toString",
  "concat",
  "sort",
  "reverse",
  "pop",
  "shift",
  "unshift",
  "splice",
  "as",
  "getTime",
  "hasOwnProperty",
]);

export interface CodeUse {
  /** Building block ids the code calls. */
  blocks: string[];
  /** What makes it custom: app calls and property changes that aren't building blocks. */
  custom: string[];
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const stripStrings = (code: string) => code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

/** Which blocks a piece of ExtendScript calls, and which calls make it custom. */
export function analyzeCode(code: string, helpers: HelperDef[]): CodeUse {
  const text = stripStrings(stripComments(code));
  const local = new Set([...text.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const byCall = new Map(helpers.map((h) => [h.call, h.id]));
  const blocks = new Set<string>();
  const custom = new Set<string>();
  // A call chain that starts with a name (methods on a call's result are checked below).
  for (const m of text.matchAll(/(?<![.\w$]\s*)(new\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const path = m[2].replace(/\s+/g, "");
    const parts = path.split(".");
    const root = parts[0];
    const last = parts[parts.length - 1];
    if (KEYWORDS.has(root) && parts.length === 1) continue;
    const id = byCall.get(path);
    if (id) {
      blocks.add(id);
      continue;
    }
    if (root === "ctx" || root === "params" || local.has(path) || NEUTRAL_GLOBALS.has(root) || (parts.length > 1 && NEUTRAL_METHODS.has(last))) continue;
    if (m[1] && NEUTRAL_GLOBALS.has(path)) continue;
    custom.add(m[1] ? `new ${path}` : path);
  }
  // Calls on a result, like findLayer("X").duplicate(): the method after ")".
  for (const m of text.matchAll(/\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) if (!NEUTRAL_METHODS.has(m[1])) custom.add(`.${m[1]}()`);
  // Changing app objects directly: doc.selection = …, layer.visible = false.
  for (const m of text.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)\s*=(?!=)/g)) {
    if (m[1] === "ctx" || m[1] === "params") continue;
    custom.add(`${m[1]}${m[2]} =`);
  }
  return { blocks: [...blocks], custom: [...custom] };
}

const MARKER = /^\s*\/\/\s*step\s*(\d+)\b.*$/gim;

/** The code of each step (by its "// step <n>" marker, 1-based), or null when the script has no markers. */
export function stepBlocks(code: string): Map<number, string> | null {
  const marks = [...code.matchAll(MARKER)];
  if (!marks.length) return null;
  const out = new Map<number, string>();
  const preamble = code.slice(0, marks[0].index!);
  for (const [i, m] of marks.entries()) {
    const end = i + 1 < marks.length ? marks[i + 1].index! : code.length;
    const n = Number(m[1]);
    const body = code.slice(m.index! + m[0].length, end);
    out.set(n, `${out.get(n) ?? (i === 0 ? preamble : "")}${body}`);
  }
  return out;
}

export interface TaggedSteps {
  steps: RoutineStep[];
  /** Distinct building blocks the routine uses. */
  blocks: string[];
  /** Custom code per step number (1-based), for building block candidates. */
  customCode: Map<number, string>;
}

/** Each step tagged "tested" (building blocks only) or "custom" (code written for this routine). */
export function tagSteps(routine: { steps: RoutineStep[]; kind: "script" | "actions"; script?: string; actions?: unknown }, helpers: HelperDef[], compositesUsed: string[] = []): TaggedSteps {
  if (routine.kind === "actions") {
    return { steps: routine.steps.map((s) => ({ ...s, kind: "tested", blocks: compositesUsed })), blocks: compositesUsed, customCode: new Map() };
  }
  const code = routine.script ?? "";
  const all = analyzeCode(code, helpers);
  const blocks = stepBlocks(code);
  const customCode = new Map<number, string>();
  const steps = routine.steps.map((s, i): RoutineStep => {
    const own = blocks ? blocks.get(i + 1) : code;
    if (own === undefined) return { ...s, kind: undefined, blocks: undefined };
    const use = blocks ? analyzeCode(own, helpers) : all;
    if (use.custom.length) customCode.set(i + 1, own.trim());
    return { ...s, kind: use.custom.length ? "custom" : "tested", blocks: use.blocks };
  });
  return { steps, blocks: all.blocks, customCode };
}

// ---------- Code similarity (building block candidates) ----------

/**
 * Tokens of code with what differs between two routines that do the same thing taken out: comments, string and
 * number values, and local names (renamed in order of appearance).
 */
export function codeTokens(code: string): string[] {
  const text = stripComments(code);
  const tokens = text.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|[^\s\w]/g) ?? [];
  const declared = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) if (tokens[i] === "var" || tokens[i] === "function") declared.add(tokens[i + 1]);
  const names = new Map<string, string>();
  return tokens.map((t) => {
    if (/^["']/.test(t)) return "S";
    if (/^\d/.test(t)) return "N";
    if (declared.has(t)) {
      if (!names.has(t)) names.set(t, `v${names.size}`);
      return names.get(t)!;
    }
    return t;
  });
}

/** How alike two pieces of code are (0–1): overlap of their 3-token shingles. */
export function similarity(a: string, b: string): number {
  const shingles = (code: string) => {
    const t = codeTokens(code);
    const out = new Set<string>();
    for (let i = 0; i + 2 < t.length; i++) out.add(`${t[i]} ${t[i + 1]} ${t[i + 2]}`);
    if (t.length > 0 && t.length < 3) out.add(t.join(" "));
    return out;
  };
  const sa = shingles(a);
  const sb = shingles(b);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / (sa.size + sb.size - shared);
}

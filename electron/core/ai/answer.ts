// Reading answers that carry code outside the JSON: a JSON object (metadata, with "@code:1"-style references) and
// fenced code blocks (```javascript for scripts, ```json for Figma action lists). The blocks come after the JSON in
// the same answer, or in a separate plain-text answer. A model that still writes the code inside the JSON is fine:
// the code is unescaped and used as it is.

export interface CodeBlock {
  lang: string;
  code: string;
}

export interface SplitAnswer {
  /** The first JSON object in the answer, if any. */
  json: Record<string, any> | null;
  blocks: CodeBlock[];
}

const FENCE = /```([\w+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/** The first balanced {...} in text outside code fences, parsed. */
function firstJsonObject(text: string): Record<string, any> | null {
  const outside = text.replace(FENCE, (m) => " ".repeat(m.length));
  for (let start = outside.indexOf("{"); start >= 0; start = outside.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < outside.length; i++) {
      const ch = outside[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          // Not JSON after all: try the next brace.
        }
        break;
      }
    }
  }
  return null;
}

/** Splits an answer into its JSON object and its fenced code blocks. */
export function splitAnswer(text: string): SplitAnswer {
  const blocks = [...text.matchAll(FENCE)].map((m) => ({ lang: m[1].toLowerCase(), code: m[2] }));
  // A JSON answer inside a ```json fence (and nothing else) is the JSON itself, not a code block.
  const json = firstJsonObject(text) ?? (blocks.length === 1 && blocks[0].lang === "json" ? tryObject(blocks[0].code) : null);
  return { json, blocks: json && blocks.length === 1 && tryObject(blocks[0].code) ? [] : blocks };
}

function tryObject(text: string): Record<string, any> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const REF = /^@code:(\d+)$/;

/** "@code:2" → 2. */
export const codeRef = (v: unknown): number | null => (typeof v === "string" && REF.test(v.trim()) ? Number(REF.exec(v.trim())![1]) : null);

/** The code of a plain-text code answer: its (first) fenced block of the language, else the whole answer. */
export function codeOf(text: string, lang: "javascript" | "json"): string {
  const blocks = splitAnswer(text).blocks;
  const fits = (b: CodeBlock) => (lang === "json" ? b.lang === "json" : ["javascript", "js", "jsx", "extendscript", ""].includes(b.lang));
  const block = blocks.find(fits) ?? blocks[0];
  return (block ? block.code : text).trim();
}

/**
 * The routine's code fields ("script", "actions", "body") with references resolved against the blocks. Code written
 * inline stays as it is (a JSON-escaped string has already been unescaped by JSON.parse).
 * Returns the problem when a reference points nowhere.
 */
export function resolveCodeRefs(routine: Record<string, any>, blocks: CodeBlock[]): { routine: Record<string, any>; missing: number[] } {
  const out = { ...routine };
  const missing: number[] = [];
  for (const field of ["script", "actions", "body"]) {
    const n = codeRef(out[field]);
    if (n === null) continue;
    const block = blocks[n - 1];
    if (!block) missing.push(n);
    else out[field === "body" ? (routine.app === "figma" || block.lang === "json" ? "actions" : "script") : field] = block.code.trim();
    if (field === "body") delete out.body;
  }
  return { routine: out, missing };
}

/** True when the routine still needs its code (a reference, or no code at all). */
export function needsCode(routine: Record<string, any> | undefined, kind: "script" | "actions"): boolean {
  if (!routine || typeof routine !== "object") return false;
  const v = routine[kind] ?? routine.body;
  return v === undefined || v === null || (typeof v === "string" && (!v.trim() || codeRef(v) !== null));
}

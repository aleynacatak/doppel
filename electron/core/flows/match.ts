import type { MatchPreview, MatchRule } from "../types";
import type { ListItem } from "./values";

// Joins: when a routine iterates over one list and gets a second list, each item needs its partner from the
// second list (a data row and its cutout image). The edge's match rule says how they pair. Items without a
// partner fail one by one with a plain reason; the rest run.

export type ListType = "fileList" | "rows";

export interface Pairing {
  matched: ListItem | null;
  problem?: string;
}

const fold = (s: unknown) => String(s ?? "").normalize("NFC").trim().toLowerCase();
const baseName = (p: string) => p.split("/").pop() ?? p;
const stem = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};
const fileName = (item: ListItem) => baseName(String(item.value));
const cell = (item: ListItem, column: string) => {
  const row = item.value as Record<string, unknown> | null;
  return row && typeof row === "object" ? row[column] : undefined;
};

/** "Cutouts" → "cutout", "Product images" → "product image": for "No cutout for Row 4". */
export function singular(label: string): string {
  const l = label.trim().toLowerCase();
  if (/ies$/.test(l)) return l.replace(/ies$/, "y");
  if (/[^s]s$/.test(l) && l.length > 3) return l.slice(0, -1);
  return l;
}

/** Whether the rule fits the two lists (e.g. "file name = column" needs rows on one side and files on the other). */
export function ruleProblem(rule: MatchRule, iterType: ListType, joinType: ListType): string | null {
  if (rule.by === "fileNameEqualsColumn" && iterType === joinType) return "“File name = column” pairs data rows with files.";
  if (rule.by === "fileNameEqualsColumn" && !rule.column) return "Pick the column that holds the file names.";
  if (rule.by === "columnEquals" && (iterType !== "rows" || joinType !== "rows")) return "“Column = column” pairs data rows with data rows.";
  if (rule.by === "columnEquals" && (!rule.leftColumn || !rule.rightColumn)) return "Pick a column on each side.";
  return null;
}

/** Pairs every iterated item with one item of the joined list. */
export function pairItems(
  rule: MatchRule,
  iter: { type: ListType; items: ListItem[] },
  joined: { type: ListType; items: ListItem[]; label: string },
): Map<string, Pairing> {
  const out = new Map<string, Pairing>();
  const what = singular(joined.label);
  const bad = ruleProblem(rule, iter.type, joined.type);
  if (bad) {
    for (const item of iter.items) out.set(item.key, { matched: null, problem: bad });
    return out;
  }
  switch (rule.by) {
    case "index": {
      // Items that came from the same original item (the same data row) pair by that; otherwise by position.
      const byKey = iter.items.some((i) => joined.items.some((j) => j.key === i.key || j.key.startsWith(`${i.key}-`)));
      iter.items.forEach((item, i) => {
        const matched = byKey ? (joined.items.find((j) => j.key === item.key) ?? joined.items.find((j) => j.key.startsWith(`${item.key}-`))) : joined.items[i];
        out.set(item.key, matched ? { matched } : { matched: null, problem: `No ${what} for ${item.label}: ${byKey ? "it wasn't made, or failed earlier" : `there are only ${joined.items.length}`}.` });
      });
      return out;
    }
    case "fileNameEqualsColumn": {
      const same = (a: string, b: string) => (rule.ignoreExtension ? fold(stem(a)) === fold(stem(b)) : fold(a) === fold(b));
      for (const item of iter.items) {
        if (iter.type === "rows") {
          const wanted = String(cell(item, rule.column) ?? "").trim();
          if (!wanted) {
            out.set(item.key, { matched: null, problem: `No ${what} for ${item.label}: its "${rule.column}" is empty.` });
            continue;
          }
          const matched = joined.items.find((j) => same(fileName(j), baseName(wanted)));
          out.set(item.key, matched ? { matched } : { matched: null, problem: `No ${what} for ${item.label}: ${baseName(wanted)} not found.` });
        } else {
          const name = fileName(item);
          const matched = joined.items.find((j) => same(name, baseName(String(cell(j, rule.column) ?? ""))));
          out.set(item.key, matched ? { matched } : { matched: null, problem: `No ${what} for ${item.label}: no row has "${name}" in "${rule.column}".` });
        }
      }
      return out;
    }
    case "columnEquals": {
      for (const item of iter.items) {
        const wanted = fold(cell(item, rule.leftColumn));
        const matched = wanted ? joined.items.find((j) => fold(cell(j, rule.rightColumn)) === wanted) : undefined;
        out.set(
          item.key,
          matched ? { matched } : { matched: null, problem: `No ${what} for ${item.label}: no row with ${rule.rightColumn} “${String(cell(item, rule.leftColumn) ?? "")}”.` },
        );
      }
      return out;
    }
  }
}

const FILE_COLUMN = /(file|image|img|photo|picture|pic|cutout|asset|png|jpe?g|psd|svg|visual)/i;
const KEY_COLUMN = /^(id|sku|code|ean|key|ref|slug|name)$/i;

/**
 * A default rule for a join. Rows and files: the column whose values look most like the file names
 * ("file name = column"). Rows and rows: a column both sides share. Otherwise by position.
 */
export function suggestMatch(
  iter: { type: ListType; items: ListItem[]; columns?: string[] },
  joined: { type: ListType; items: ListItem[]; columns?: string[] },
): MatchRule {
  if (iter.type !== joined.type) {
    const rows = iter.type === "rows" ? iter : joined;
    const files = iter.type === "rows" ? joined : iter;
    const names = new Set(files.items.map((f) => fold(stem(fileName(f)))));
    const columns = rows.columns?.length ? rows.columns : Object.keys((rows.items[0]?.value as Record<string, unknown>) ?? {});
    let best: { column: string; score: number } | null = null;
    for (const column of columns) {
      const values = rows.items.map((r) => String(cell(r, column) ?? "").trim()).filter(Boolean);
      const hits = values.filter((v) => names.has(fold(stem(baseName(v))))).length;
      const looksLikeFiles = values.filter((v) => /\.[a-z0-9]{2,5}$/i.test(v)).length;
      const score = hits * 10 + looksLikeFiles * 2 + (FILE_COLUMN.test(column) ? 3 : 0);
      if (score > 0 && (!best || score > best.score)) best = { column, score };
    }
    if (best) return { by: "fileNameEqualsColumn", column: best.column, ignoreExtension: true };
    return { by: "index" };
  }
  if (iter.type === "rows") {
    const left = iter.columns?.length ? iter.columns : Object.keys((iter.items[0]?.value as Record<string, unknown>) ?? {});
    const right = new Set(joined.columns?.length ? joined.columns : Object.keys((joined.items[0]?.value as Record<string, unknown>) ?? {}));
    const shared = left.filter((c) => right.has(c));
    const column = shared.find((c) => KEY_COLUMN.test(c)) ?? shared[0];
    if (column) return { by: "columnEquals", leftColumn: column, rightColumn: column };
  }
  return { by: "index" };
}

/** The first pairs a rule makes, for the edge inspector. */
export function previewPairs(
  rule: MatchRule,
  iter: { type: ListType; items: ListItem[] },
  joined: { type: ListType; items: ListItem[]; label: string },
  limit = 5,
): MatchPreview {
  const pairs = pairItems(rule, iter, joined);
  const list = iter.items.map((item) => {
    const p = pairs.get(item.key)!;
    return { item: item.label, match: p.matched ? p.matched.label : null, problem: p.problem };
  });
  return { pairs: list.slice(0, limit), total: list.length, unmatched: list.filter((p) => !p.match).length };
}

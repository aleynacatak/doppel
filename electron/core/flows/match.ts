import { compactKey, coreKey, nameKey } from "../../shared/names";
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
export const stem = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

export { nameKey } from "../../shared/names";

const tokens = (key: string) => new Set(key.split(" ").filter(Boolean));
const within = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((t) => b.has(t));

/**
 * Each wanted name's partner among the candidates, from the surest way to the loosest: the same name; (loose) the
 * same name written as one word ("strawberryvanilla"); the same name without noise ("mango_v2_final", "Mango (1)");
 * the only candidate whose words contain the name's words or are contained in them; the only one whose one-word
 * form contains the other's. A candidate another name already took at a surer level isn't taken again. Null: none,
 * or more than one, fits.
 */
export function partnersByName<T extends object>(wanted: string[], candidates: { name: string; item: T }[], loose: boolean): (T | null)[] {
  const keys = candidates.map((c) => ({ key: nameKey(c.name), compact: compactKey(c.name), core: coreKey(c.name), item: c.item }));
  // The same name: the first such candidate, even if another name has it too (two rows of the same product, or
  // mango.png next to mango.jpg).
  const found: (T | null)[] = wanted.map((w) => (nameKey(w) ? (keys.find((c) => c.key === nameKey(w))?.item ?? null) : null));
  const taken = new Set(found.filter((x): x is T => x !== null));
  const levels: ((w: string, c: (typeof keys)[number]) => boolean)[] = [];
  if (loose) {
    levels.push(
      (w, c) => !!compactKey(w) && c.compact === compactKey(w),
      (w, c) => !!coreKey(w) && c.core === coreKey(w),
      (w, c) => {
        const t = tokens(nameKey(w));
        return within(t, tokens(c.key)) || within(tokens(c.key), t);
      },
      (w, c) => {
        const a = compactKey(w);
        return a.length >= 4 && c.compact.length >= 4 && (c.compact.includes(a) || a.includes(c.compact));
      },
    );
  }
  for (const fits of levels) {
    const picks = wanted.map((w, i) => {
      if (found[i] !== null) return null;
      const all = keys.filter((c) => !taken.has(c.item) && fits(w, c));
      return all.length === 1 ? all[0].item : null;
    });
    // Two names that both want the same candidate at this level: neither gets it.
    picks.forEach((p, i) => {
      if (p !== null && picks.filter((q) => q === p).length === 1) found[i] = p;
    });
    for (const p of found) if (p !== null) taken.add(p);
  }
  return found;
}
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
  if (rule.by === "sameFileName" && (iterType !== "fileList" || joinType !== "fileList")) return "“Same file name” pairs files with files.";
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
      const name = (v: string) => (rule.ignoreExtension ? stem(baseName(v)) : baseName(v));
      const exactly = (a: string, b: string) => (rule.ignoreExtension ? fold(stem(a)) === fold(stem(b)) : fold(a) === fold(b));
      if (iter.type === "rows") {
        const wanted = iter.items.map((item) => String(cell(item, rule.column) ?? "").trim());
        const found = rule.loose
          ? partnersByName(wanted.map(name), joined.items.map((j) => ({ name: name(fileName(j)), item: j })), true)
          : wanted.map((w) => joined.items.find((j) => exactly(fileName(j), baseName(w))) ?? null);
        iter.items.forEach((item, i) => {
          if (!wanted[i]) out.set(item.key, { matched: null, problem: `No ${what} for ${item.label}: its "${rule.column}" is empty.` });
          else out.set(item.key, found[i] ? { matched: found[i] } : { matched: null, problem: `No ${what} for ${item.label}: ${baseName(wanted[i])} not found.` });
        });
      } else {
        const rowsWithName = joined.items.map((j) => ({ name: name(String(cell(j, rule.column) ?? "")), item: j })).filter((r) => r.name);
        const found = rule.loose
          ? partnersByName(iter.items.map((item) => name(fileName(item))), rowsWithName, true)
          : iter.items.map((item) => joined.items.find((j) => exactly(fileName(item), baseName(String(cell(j, rule.column) ?? "")))) ?? null);
        iter.items.forEach((item, i) =>
          out.set(item.key, found[i] ? { matched: found[i] } : { matched: null, problem: `No ${what} for ${item.label}: no row has "${fileName(item)}" in "${rule.column}".` }),
        );
      }
      return out;
    }
    case "sameFileName": {
      const found = partnersByName(
        iter.items.map((item) => stem(fileName(item))),
        joined.items.map((j) => ({ name: stem(fileName(j)), item: j })),
        true,
      );
      iter.items.forEach((item, i) => out.set(item.key, found[i] ? { matched: found[i] } : { matched: null, problem: `No ${what} for ${item.label}: no file with a name like it.` }));
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
    const candidates = files.items.map((f) => ({ name: stem(fileName(f)), item: f }));
    const columns = rows.columns?.length ? rows.columns : Object.keys((rows.items[0]?.value as Record<string, unknown>) ?? {});
    let best: { column: string; score: number } | null = null;
    for (const column of columns) {
      const values = rows.items.map((r) => String(cell(r, column) ?? "").trim()).filter(Boolean);
      const hits = partnersByName(values.map((v) => stem(baseName(v))), candidates, true).filter(Boolean).length;
      const looksLikeFiles = values.filter((v) => /\.[a-z0-9]{2,5}$/i.test(v)).length;
      const score = hits * 10 + looksLikeFiles * 2 + (FILE_COLUMN.test(column) ? 3 : 0);
      if (score > 0 && (!best || score > best.score)) best = { column, score };
    }
    if (best) return { by: "fileNameEqualsColumn", column: best.column, ignoreExtension: true, loose: true };
    return { by: "index" };
  }
  if (iter.type === "fileList") {
    const found = partnersByName(
      iter.items.map((i) => stem(fileName(i))),
      joined.items.map((j) => ({ name: stem(fileName(j)), item: j })),
      true,
    );
    if (found.some(Boolean)) return { by: "sameFileName" };
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

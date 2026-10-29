import path from "node:path";
import { extensionOf } from "../../shared/ports";
import { listFolderFiles } from "../helpers/dataFiles";
import { nameKey, pairItems, stem } from "../flows/match";
import { fileList, type ListItem, resolveInput } from "../flows/values";
import type { MatchRule, PortDef } from "../types";

// The input check: before the AI starts, Doppl looks at what the designer attached (data files, folders, files),
// how the inputs relate (which image belongs to which row), what's missing and which formats are mixed. What's
// clear becomes facts for the AI; what isn't becomes a few plain questions with Doppl's best guess first. No AI.

export interface InputSource {
  /** The data file's or folder's path; "attached" for files attached one by one. */
  id: string;
  label: string;
  kind: "rows" | "files";
  items: ListItem[];
  columns?: string[];
  /** Files: how many of each format (jpeg counts as jpg). */
  formats?: Record<string, number>;
}

/** One way to pair the main input with another one. */
export interface PairingOption {
  id: string;
  /** null: "the same file for every item" or "not related" (no pairing). */
  rule: MatchRule | null;
  kind: "name" | "order" | "same" | "none";
  label: string;
  /** Items of the main input that find a partner, and the ones that don't. */
  matched: number;
  missing: string[];
  /** Items of the other input that no item uses. */
  unused: string[];
  examples: { from: string; to: string }[];
}

export interface Relation {
  main: InputSource;
  other: InputSource;
  options: PairingOption[];
  /** Doppl's best guess (the first option). */
  best: PairingOption;
  /** Clear enough not to ask: every item finds its partner by name, or the other input is one file. */
  sure: boolean;
}

export interface InputAnalysis {
  sources: InputSource[];
  relations: Relation[];
  /** Values that should be unique but aren't: in an ID-like column (SKU, code, barcode), or the column items pair by. */
  duplicates: Duplicate[];
}

export interface Duplicate {
  source: string;
  column: string;
  value: string;
  /** The rows that share it ("Row 2", "Row 5"). */
  rows: string[];
}

/** Columns that name one item each: an ID, SKU, code or barcode. */
const ID_COLUMN = /^(id|sku|code|kod|ean|barcode|barkod|gtin|upc|key|ref|slug)$|(^|[^a-z])(sku|barcode|barkod|ean|gtin)([^a-z]|$)/i;

/** Rows of a data file that share a value in a column (compared the way people mean names: "Mango" is "MANGO "). */
export function duplicatesIn(source: InputSource, column: string): Duplicate[] {
  const byKey = new Map<string, { value: string; rows: string[] }>();
  for (const item of source.items) {
    const value = String((item.value as Record<string, unknown> | null)?.[column] ?? "").trim();
    if (!value) continue;
    const entry = byKey.get(nameKey(value)) ?? { value, rows: [] };
    entry.rows.push(item.label.replace(/ · .*$/, ""));
    byKey.set(nameKey(value), entry);
  }
  return [...byKey.values()].filter((e) => e.rows.length > 1).map((e) => ({ source: source.label, column, value: e.value, rows: e.rows }));
}

/** What was decided for a relation: by the designer, or Doppl's sure guess. */
export interface InputDecision {
  mainId: string;
  otherId: string;
  option: PairingOption;
  /** Items without a partner: skipped (they fail with the reason), made without it, or the designer stopped. */
  missing?: "skip" | "without";
  confirmed: boolean;
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "tif", "tiff", "psd", "webp", "gif", "bmp", "heic", "svg"];
const extOf = (file: string) => extensionOf(file);
/** Data files Doppl reads as rows (a .txt is more often notes than a table). */
const DATA_EXTENSIONS = ["csv", "tsv", "json", "xlsx"];
const isData = (file: string) => DATA_EXTENSIONS.includes(extOf(file));

/** How many files of each format, the most common first. */
function formatsOf(files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) out[extOf(f) || "no extension"] = (out[extOf(f) || "no extension"] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const rowsPort = (key: string): PortDef => ({ key, label: key, type: "rows", required: true });

/** Data files (attached or in folders) become rows; each folder's other files, and the files attached one by one, become file lists. */
export async function readInputSources(task: { references: string[]; folders?: string[] }): Promise<InputSource[]> {
  const sources: InputSource[] = [];
  const addRows = async (file: string) => {
    const { value } = await resolveInput(rowsPort("rows"), file).catch(() => ({ value: null }));
    if (value?.kind === "list") sources.push({ id: file, label: path.basename(file), kind: "rows", items: value.items, columns: value.columns ?? [] });
  };
  const addFiles = (id: string, label: string, files: string[]) => {
    if (!files.length) return;
    const list = fileList(files, (f) => f);
    if (list.kind === "list") sources.push({ id, label, kind: "files", items: list.items, formats: formatsOf(files) });
  };
  for (const ref of task.references) if (isData(ref)) await addRows(ref);
  addFiles(
    "attached",
    task.references.filter((r) => !isData(r)).length === 1 ? path.basename(task.references.find((r) => !isData(r))!) : "the attached files",
    task.references.filter((r) => !isData(r)),
  );
  for (const folder of task.folders ?? []) {
    const files = await listFolderFiles(folder).catch(() => []);
    for (const f of files.filter((x) => isData(x.path))) await addRows(f.path);
    addFiles(folder, path.basename(folder), files.filter((x) => !isData(x.path)).map((x) => x.path));
  }
  return sources;
}

/** "images" when every file is an image, "PDFs", or "files". */
export function nounOf(source: InputSource, one = false): string {
  if (source.kind === "rows") return one ? "row" : "rows";
  const exts = Object.keys(source.formats ?? {});
  if (exts.length && exts.every((e) => IMAGE_EXTENSIONS.includes(e))) return one ? "image" : "images";
  if (exts.length === 1 && exts[0] === "pdf") return one ? "PDF" : "PDFs";
  return one ? "file" : "files";
}

const shortList = (labels: string[], n = 3) => (labels.length > n ? `${labels.slice(0, n).join(", ")} and ${labels.length - n} more` : labels.join(", "));
/** "Row 3 · Fig" → "Fig": what a person calls the item. */
const itemName = (label: string) => label.replace(/^Row \d+ · /, "");

function option(main: InputSource, other: InputSource, id: string, kind: PairingOption["kind"], rule: MatchRule | null, label: string): PairingOption {
  if (kind === "none") return { id, rule, kind, label, matched: 0, missing: [], unused: [], examples: [] };
  if (kind === "same") {
    const only = other.items[0];
    return { id, rule, kind, label, matched: main.items.length, missing: [], unused: [], examples: main.items.slice(0, 2).map((i) => ({ from: itemName(i.label), to: only.label })) };
  }
  const pairs = pairItems(rule!, { type: main.kind === "rows" ? "rows" : "fileList", items: main.items }, { type: other.kind === "rows" ? "rows" : "fileList", items: other.items, label: other.label });
  const used = new Set<string>();
  const missing: string[] = [];
  const examples: PairingOption["examples"] = [];
  for (const item of main.items) {
    const p = pairs.get(item.key);
    if (p?.matched) {
      used.add(p.matched.key);
      if (examples.length < 3) examples.push({ from: itemName(item.label), to: itemName(p.matched.label) });
    } else missing.push(itemName(item.label));
  }
  return { id, rule, kind, label, matched: main.items.length - missing.length, missing, unused: other.items.filter((i) => !used.has(i.key)).map((i) => itemName(i.label)), examples };
}

/** The ways the main input could pair with another one, the best first. */
export function relate(main: InputSource, other: InputSource): Relation {
  const named: PairingOption[] = [];
  if (main.kind === "rows" && other.kind === "files") {
    for (const column of main.columns ?? []) {
      const o = option(main, other, `column:${column}`, "name", { by: "fileNameEqualsColumn", column, ignoreExtension: true, loose: true }, `By “${column}”`);
      if (o.matched > 0) named.push(o);
    }
  } else if (main.kind === "files" && other.kind === "files") {
    const o = option(main, other, "name", "name", { by: "sameFileName" }, "By file name");
    if (o.matched > 0) named.push(o);
  } else if (main.kind === "rows" && other.kind === "rows") {
    // Columns with the same name first; without any, every pair of columns.
    const all = (main.columns ?? []).flatMap((left) => (other.columns ?? []).map((right) => [left, right] as const));
    const shared = all.filter(([l, r]) => nameKey(l) === nameKey(r));
    for (const [left, right] of (shared.length ? shared : all).slice(0, 200)) {
      const o = option(main, other, `columns:${left}=${right}`, "name", { by: "columnEquals", leftColumn: left, rightColumn: right }, left === right ? `By “${left}”` : `“${left}” = “${right}”`);
      if (o.matched > 0) named.push(o);
    }
  }
  named.sort((a, b) => b.matched - a.matched || a.missing.length - b.missing.length);
  const single = other.kind === "files" && other.items.length === 1;
  const same = single ? option(main, other, "same", "same", null, `The same ${nounOf(other, true)} for every ${nounOf(main, true)}: ${other.items[0].label}`) : null;
  const order = option(main, other, "order", "order", { by: "index" }, `In order: ${nounOf(main, true)} 1 → the first ${nounOf(other, true)}`);
  const none = option(main, other, "none", "none", null, "They aren't related");
  const best = named[0] && named[0].missing.length === 0 ? named[0] : (same ?? named[0] ?? order);
  const options = [best, ...named.slice(0, 2), ...(same ? [same] : []), order].filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i);
  const sure = best.kind === "same" || (best.kind === "name" && best.missing.length === 0);
  return { main, other, options: [...options.slice(0, 3), none], best, sure };
}

/** The input everything else pairs with: the biggest data file, else the biggest file list. */
function mainOf(sources: InputSource[]): InputSource | null {
  const by = (kind: InputSource["kind"]) => sources.filter((s) => s.kind === kind).sort((a, b) => b.items.length - a.items.length)[0];
  return by("rows") ?? by("files") ?? null;
}

export function analyzeInputs(sources: InputSource[]): InputAnalysis {
  const main = mainOf(sources);
  const relations = main ? sources.filter((s) => s !== main && s.items.length > 0).map((s) => relate(main, s)) : [];
  // The columns that should be unique: ID-like ones, and the ones items pair by.
  const keyed = new Map<InputSource, Set<string>>();
  for (const s of sources.filter((x) => x.kind === "rows")) keyed.set(s, new Set((s.columns ?? []).filter((c) => ID_COLUMN.test(c))));
  for (const r of relations) {
    const rule = r.best.rule;
    if (rule?.by === "fileNameEqualsColumn") keyed.get(r.main)?.add(rule.column);
    if (rule?.by === "columnEquals") keyed.get(r.main)?.add(rule.leftColumn);
  }
  const duplicates = [...keyed].flatMap(([s, columns]) => [...columns].flatMap((c) => duplicatesIn(s, c)));
  return { sources, relations, duplicates };
}

/** A question for the designer: plain, a few options, the best first. */
export interface InputQuestion {
  id: string;
  text: string;
  detail?: string;
  options: { id: string; label: string; detail?: string }[];
}

export function pairingQuestion(r: Relation): InputQuestion {
  const what = nounOf(r.other, true);
  const each = r.main.kind === "rows" ? "row" : nounOf(r.main, true);
  const formats = r.other.formats ? ` (${Object.keys(r.other.formats).map((e) => e.toUpperCase()).join(", ")})` : "";
  return {
    id: `pair:${r.other.id}`,
    text: `How should each ${each} in ${r.main.label} find its ${what} in ${r.other.label}?`,
    detail: `${r.main.items.length} ${nounOf(r.main)} · ${r.other.items.length} ${nounOf(r.other)}${formats}`,
    options: r.options.map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.kind === "none"
        ? {}
        : {
            detail: [
              o.examples.map((e) => `${e.from} → ${e.to}`).join(" · "),
              o.kind === "same" ? "" : `${o.matched} of ${r.main.items.length} have one`,
            ]
              .filter(Boolean)
              .join(" · "),
          }),
    })),
  };
}

export function missingQuestion(r: Relation, o: PairingOption): InputQuestion {
  const what = nounOf(r.other, true);
  const each = r.main.kind === "rows" ? "rows" : nounOf(r.main);
  const one = o.missing.length === 1;
  return {
    id: `missing:${r.other.id}`,
    text: `${o.missing.length} of ${r.main.items.length} ${each} ${one ? "has" : "have"} no ${what} in ${r.other.label}: ${shortList(o.missing)}. What should Doppl do with ${one ? "it" : "them"}?`,
    options: [
      { id: "skip", label: one ? "Skip it" : "Skip them", detail: `Doppl lists ${one ? "it" : "them"} after each run` },
      { id: "without", label: `Make ${one ? "it" : "them"} without the ${what}` },
      { id: "stop", label: `Stop so I can add the missing ${nounOf(r.other)}` },
    ],
  };
}

/** Facts for the AI: the inputs, and what was decided about how they pair. */
export function inputFacts(analysis: InputAnalysis, decisions: InputDecision[]): string[] {
  const lines = analysis.sources.map((s) =>
    s.kind === "rows"
      ? `${s.label}: ${s.items.length} rows (columns: ${(s.columns ?? []).join(", ")}).`
      : `${s.label}: ${s.items.length} ${nounOf(s)} (${Object.entries(s.formats ?? {})
          .map(([e, n]) => `${n} ${e.toUpperCase()}`)
          .join(", ")}).${Object.keys(s.formats ?? {}).length > 1 ? ` Accept every one of these formats in the input's "extensions".` : ""}`,
  );
  for (const d of decisions) {
    const r = analysis.relations.find((x) => x.main.id === d.mainId && x.other.id === d.otherId);
    if (!r) continue;
    const o = d.option;
    const who = d.confirmed ? "The designer chose this." : "Doppl is sure of this.";
    const each = r.main.kind === "rows" ? "row" : nounOf(r.main, true);
    if (o.kind === "none") lines.push(`${r.main.label} and ${r.other.label} aren't related: don't pair them. ${who}`);
    else if (o.kind === "same") lines.push(`${r.other.items[0].label} is one file used for every ${each}: make it a "file" input, not a list. ${who}`);
    else {
      const how =
        o.kind === "order"
          ? "in order (the first with the first)"
          : o.rule?.by === "fileNameEqualsColumn"
            ? `by its "${o.rule.column}" value and the file name (names match loosely: case, spaces, dashes, underscores, accents)`
            : o.rule?.by === "columnEquals"
              ? `by "${o.rule.leftColumn}" = "${o.rule.rightColumn}"`
              : "by similar file names";
      lines.push(
        `Each ${each} of ${r.main.label} pairs with its ${nounOf(r.other, true)} in ${r.other.label} ${how}: iterate over ${r.main.label} and declare ${r.other.label} as a second list input; Doppl pairs them, read the partner with ctx.matched.<input> ({{matched.<input>}} in Figma). ${o.matched} of ${r.main.items.length} have one. ${who}`,
      );
      if (o.missing.length) {
        lines.push(
          d.missing === "without"
            ? `${shortList(o.missing, 5)} ${o.missing.length === 1 ? "has" : "have"} no ${nounOf(r.other, true)}: make ${o.missing.length === 1 ? "it" : "them"} without it (ctx.matched.<input> is missing there: leave that part out or empty, don't fail).`
            : `${shortList(o.missing, 5)} ${o.missing.length === 1 ? "has" : "have"} no ${nounOf(r.other, true)}: Doppl skips ${o.missing.length === 1 ? "it" : "them"} with a clear reason.`,
        );
      }
      if (o.unused.length) lines.push(`Not used by any ${each} (left out): ${shortList(o.unused, 5)}.`);
    }
  }
  for (const d of analysis.duplicates.slice(0, 5)) {
    lines.push(`"${d.value}" appears in ${d.rows.length} rows of ${d.source} (${shortList(d.rows, 4)}) in "${d.column}": they get the same partner; don't treat it as an error.`);
  }
  return lines;
}

/** The pairing rule decided for two sources, or null (no pairing, or none decided). */
export function decidedRule(decisions: InputDecision[], mainId: string, otherId: string): MatchRule | null {
  const d = decisions.find((x) => x.mainId === mainId && x.otherId === otherId);
  if (!d?.option.rule) return null;
  return d.missing === "without" ? { ...d.option.rule, optional: true } : d.option.rule;
}

/** Which source a sample value came from: a data file's path, the folder its files are in, or "attached". */
export function sourceOf(sources: InputSource[], value: { kind: string; type?: string; path?: string; items?: ListItem[] } | undefined): InputSource | null {
  if (!value || value.kind !== "list") return null;
  if (value.type === "rows") return sources.find((s) => s.id === value.path) ?? null;
  const files = (value.items ?? []).map((i) => String(i.value));
  return sources.find((s) => s.kind === "files" && files.length > 0 && files.every((f) => s.items.some((i) => i.value === f))) ?? null;
}

/** How well a source fits an input by name ("Flavor images" and the folder "flavor pics"): shared words. */
export function nameFit(port: { key: string; label: string }, source: InputSource): number {
  const words = (s: string) => new Set(nameKey(stem(s).replace(/([a-z])([A-Z])/g, "$1 $2")).split(" ").filter((w) => w.length > 2).map((w) => w.replace(/s$/, "")));
  const a = new Set([...words(port.key), ...words(port.label)]);
  return [...words(source.label)].filter((w) => a.has(w)).length;
}

export { extOf as fileExtension };

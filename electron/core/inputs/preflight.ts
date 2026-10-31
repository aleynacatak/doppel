import path from "node:path";
import { nameKey, rankByLikeness as ranked, sameWords } from "../../shared/names";
import { fileAllowed, isListType } from "../../shared/ports";
import { DataFileError, type DataTable, listFolderFiles, readDataFile } from "../helpers/dataFiles";
import { type ImageInfo, LARGE_PIXELS, isCheckedImage, readImageInfo } from "../helpers/imageInfo";
import { itemName, pairItems, pairKey, singular, stem } from "../flows/match";
import { type FlowRoutines, routineOf } from "../flows/validateFlow";
import { InputValueError, type PortValue, resolveInput } from "../flows/values";
import type { Flow, FlowNode, InputValue, PreflightIssue, PreflightNote, PreflightReport } from "../types";
import { duplicatesIn } from "./inputCheck";

// The check before a run: Doppl reads what was picked the way the run will, and says what it handled on its own
// (an encoding, a delimiter, a column under another name, files matched despite their spelling), what needs the
// designer (a column it can't find, an item without its file), what will be skipped (an image that holds no picture)
// and what's good to know (CMYK or very large images). AI only for a column no name rule can place, and for files
// when the designer asks.

type Input = Extract<FlowNode, { kind: "input" }>;

const ENCODINGS: Record<string, string> = {
  "windows-1254": "Turkish (Windows)",
  "windows-1252": "Western (Windows)",
  "utf-16le": "Unicode text (UTF-16)",
  "utf-16be": "Unicode text (UTF-16)",
};
const DELIMITERS: Record<string, string> = { ";": "semicolons", "\t": "tabs", "|": "vertical bars" };

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";
const isEmpty = (v: InputValue | undefined) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const list = (names: string[], n = 3) => (names.length > n ? `${names.slice(0, n).join(", ")} and ${names.length - n} more` : names.join(", "));

/** The columns the routines fed by an input node need (the file has them), and the others they read. */
function neededColumns(flow: Flow, info: FlowRoutines, node: Input, which: "columns" | "uses" = "columns"): string[] {
  const columns = new Set(node.port[which] ?? []);
  for (const e of flow.edges.filter((x) => x.from.nodeId === node.id)) {
    const port = routineOf(info, e.to.nodeId)?.inputs.find((p) => p.key === e.to.port);
    if (port?.type === "rows") for (const c of port[which] ?? []) columns.add(c);
  }
  return [...columns];
}

/** AI that tells which of a file's columns holds each column a routine expects, when the names don't say. */
export type ColumnMatcher = (input: { routine: string; expected: string[]; columns: string[]; rows: Record<string, unknown>[] }) => Promise<Record<string, string | null>>;

export async function preflight(
  flow: Flow,
  info: FlowRoutines,
  inputs: Record<string, InputValue>,
  columns: Record<string, Record<string, string>> = {},
  opts: { matchColumns?: ColumnMatcher; aiColumns?: Record<string, Record<string, string>> } = {},
): Promise<PreflightReport> {
  const fixed: PreflightNote[] = [];
  const needs: PreflightIssue[] = [];
  const skipped: PreflightNote[] = [];
  const notes: PreflightNote[] = [];
  const values = new Map<string, PortValue>();
  // Columns matched with AI here, for the screen to keep (and the run to use).
  const matched: Record<string, Record<string, string>> = {};
  let aiCalls = 0;

  for (const node of flow.nodes.filter((n): n is Input => n.kind === "input")) {
    const raw = inputs[node.id];
    if (isEmpty(raw) || !flow.edges.some((e) => e.from.nodeId === node.id)) continue;
    const picked = { ...(columns[node.id] ?? {}) };

    if (node.port.type === "rows" && typeof raw === "string") {
      const file = path.basename(raw);
      let table: DataTable;
      try {
        table = await readDataFile(raw);
      } catch (err) {
        needs.push({ kind: "file", id: `file:${node.id}`, inputNodeId: node.id, text: err instanceof DataFileError ? err.message : `${file} couldn't be read.` });
        continue;
      }
      // A column the routine needs that isn't there under any spelling, and wasn't picked: Doppl asks the AI which
      // column holds it ("Ürün Adı" for "Flavor"); what the AI can't place, the designer picks.
      const needed = neededColumns(flow, info, node);
      // Another form of the same words ("Allergen" for "allergens") is read as it, without AI.
      let missing = needed.filter((c) => !table.columns.some((h) => nameKey(h) === nameKey(picked[c] ?? c) || (picked[c] === undefined && sameWords(h, c))));
      if (missing.length && opts.matchColumns) {
        const free = table.columns.filter((h) => !needed.some((n) => nameKey(n) === nameKey(h)) && !Object.values(picked).includes(h));
        const routines = flow.edges.filter((e) => e.from.nodeId === node.id).map((e) => routineOf(info, e.to.nodeId)).filter((r): r is NonNullable<typeof r> => !!r);
        aiCalls += 1;
        const found = await opts
          .matchColumns({ routine: routines.map((r) => [r.name, ...(r.steps ?? []).map((s) => s.plainLanguage)].join(": ")).join(" / "), expected: missing, columns: free, rows: table.rows.slice(0, 5) })
          .catch(() => ({}) as Record<string, string | null>);
        for (const c of missing) {
          const header = found[c];
          if (!header) continue;
          picked[c] = header;
          (matched[node.id] ??= {})[c] = header;
          fixed.push({ text: `Matched “${header}” in ${file} to “${c}” with AI`, change: { inputNodeId: node.id, column: c, candidates: ranked(c, free) } });
        }
        missing = missing.filter((c) => !picked[c]);
      }
      for (const c of missing) {
        const free = table.columns.filter((h) => !needed.some((n) => nameKey(n) === nameKey(h)));
        needs.push({ kind: "column", id: `column:${node.id}:${c}`, inputNodeId: node.id, column: c, text: `${file} has no column “${c}”. Which column holds it?`, candidates: ranked(c, free) });
      }
      if (missing.length) continue;
      let resolved;
      try {
        resolved = await resolveInput({ ...node.port, columns: needed, uses: neededColumns(flow, info, node, "uses") }, raw, { aliases: picked });
      } catch (err) {
        needs.push({ kind: "file", id: `file:${node.id}`, inputNodeId: node.id, text: err instanceof InputValueError ? err.message : `${file} couldn't be read.` });
        continue;
      }
      if (!resolved.value) continue;
      values.set(node.id, resolved.value);
      const readAs = resolved.value.kind === "list" ? resolved.value.readAs : undefined;
      if (readAs?.encoding && ENCODINGS[readAs.encoding]) fixed.push({ text: `Read ${file} as ${ENCODINGS[readAs.encoding]}`, detail: readAs.encoding });
      if (readAs?.delimiter && DELIMITERS[readAs.delimiter]) fixed.push({ text: `${file} separates its columns with ${DELIMITERS[readAs.delimiter]}` });
      for (const [expected, actual] of Object.entries(readAs?.renamed ?? {})) {
        if (matched[node.id]?.[expected]) continue;
        // Matched with AI on an earlier check: still said so, and still changeable.
        if (opts.aiColumns?.[node.id]?.[expected] === actual) {
          const free = table.columns.filter((h) => !needed.some((n) => nameKey(n) === nameKey(h)));
          fixed.push({ text: `Matched “${actual}” in ${file} to “${expected}” with AI`, change: { inputNodeId: node.id, column: expected, candidates: ranked(expected, free) } });
          continue;
        }
        fixed.push({ text: picked[expected] !== undefined ? `Used “${actual}” for “${expected}” in ${file}, as you picked` : `Read the column “${actual}” in ${file} as “${expected}”` });
      }
      for (const p of resolved.problems) skipped.push({ text: `${p.error} It will be skipped.` });
      // Empty cells don't stop a row; say which rows are made without a value (pairing columns speak for themselves).
      if (resolved.value.kind === "list") {
        const pairing = new Set(flow.edges.flatMap((e) => (e.match?.by === "fileNameEqualsColumn" ? [e.match.column] : e.match?.by === "columnEquals" ? [e.match.leftColumn, e.match.rightColumn] : [])));
        for (const c of needed.filter((x) => !pairing.has(x))) {
          const rows = resolved.value.items.filter((i) => blank((i.value as Record<string, unknown>)[c])).map((i) => i.label.replace(/^Row \d+ · /, ""));
          const names = rows.length > 3 ? list(rows) : rows.length > 1 ? `${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}` : rows[0];
          if (rows.length) fixed.push({ text: rows.length === 1 ? `${names} has no “${c}” in ${file}: it's made without it.` : `${rows.length} rows have no “${c}” in ${file}: ${names} are made without it.` });
        }
      }
      continue;
    }

    let resolved;
    try {
      resolved = await resolveInput(node.port, raw);
    } catch (err) {
      needs.push({ kind: "file", id: `file:${node.id}`, inputNodeId: node.id, text: err instanceof InputValueError ? err.message : errorText(err) });
      continue;
    }
    if (resolved.value) values.set(node.id, resolved.value);
    for (const p of resolved.problems) skipped.push({ text: `${p.error} It will be skipped.` });
    if (resolved.value) notes.push(...(await imageNotes(flow, info, node, resolved.value)));
    // A folder: files of other formats aren't used.
    if (node.port.type === "fileList" && typeof raw === "string" && node.port.extensions?.length) {
      const all = await listFolderFiles(raw).catch(() => []);
      const left = all.filter((f) => !fileAllowed(f.path, node.port.extensions)).map((f) => f.name);
      if (left.length) skipped.push({ text: `${path.basename(raw)}: ${list(left)} ${left.length === 1 ? "isn't" : "aren't"} ${node.port.extensions.map((e) => e.toUpperCase()).join(" or ")}, so ${left.length === 1 ? "it isn't" : "they aren't"} used.` });
    }
  }

  // How the items of each routine pair, where both lists come straight from the picked inputs.
  for (const node of flow.nodes) {
    if (node.kind !== "routine") continue;
    const routine = routineOf(info, node.id);
    if (!routine?.iterate) continue;
    const iterEdge = flow.edges.find((e) => e.to.nodeId === node.id && e.to.port === routine.iterate!.input);
    const iter = iterEdge ? values.get(iterEdge.from.nodeId) : undefined;
    if (!iter || iter.kind !== "list") continue;
    for (const port of routine.inputs) {
      if (port.key === routine.iterate.input || !isListType(port.type)) continue;
      const edge = flow.edges.find((e) => e.to.nodeId === node.id && e.to.port === port.key);
      // Files an earlier step makes are guessed from the files it's made from (a cutout keeps its photo's name).
      const made = edge && !values.has(edge.from.nodeId) ? madeFrom(flow, info, values, edge.from) : undefined;
      const joined = edge ? (values.get(edge.from.nodeId) ?? made?.files) : undefined;
      const rule = edge?.match;
      if (!rule || !joined || joined.kind !== "list") continue;
      const pairs = pairItems(rule, { type: iter.type, items: iter.items }, { type: joined.type, items: joined.items, label: port.label });
      const what = singular(port.label);
      const used = new Set<string>();
      const loose: string[] = [];
      const missing: { key: string; name: string }[] = [];
      for (const item of iter.items) {
        // Named as people see it: a row by its label ("Çilek Reçeli"), a file by its name.
        const shown = iter.type === "rows" ? item.label.replace(/^Row \d+ · /, "") : itemName(item, iter.type);
        const partner = pairs.get(item.key)?.matched;
        if (partner) {
          used.add(partner.key);
          const partnerName = itemName(partner, joined.type);
          const byHand = rule.pairs?.[pairKey(item, iter.type, rule)] !== undefined;
          if (!byHand && rule.by !== "index" && nameKey(stem(partnerName)) !== nameKey(stem(itemName(item, iter.type, rule)))) loose.push(`${partnerName} → ${shown}`);
        } else missing.push({ key: pairKey(item, iter.type, rule), name: shown });
      }
      const handPicked = Object.keys(rule.pairs ?? {}).length;
      if (handPicked) fixed.push({ text: `Used the ${handPicked === 1 ? `${what} you picked` : `${handPicked} ${what}s you picked`} for ${port.label}` });
      if (loose.length) fixed.push({ text: `Matched ${loose.length} ${loose.length === 1 ? what : `${what}s`} by name despite different spelling: ${list(loose)}` });
      const unused = joined.items.filter((j) => !used.has(j.key)).map((j) => itemName(j, joined.type));
      if (missing.length && rule.optional) fixed.push({ text: `${list(missing.map((m) => m.name))} will be made without a ${what}, as set` });
      else {
        const where = joined.type === "fileList" ? new Map(joined.items.map((j) => [itemName(j, "fileList"), String(j.value)])) : null;
        for (const m of missing.slice(0, 30)) {
          const candidates = ranked(m.name, unused);
          needs.push({
            kind: "partner",
            id: `partner:${node.id}:${port.key}:${m.key}`,
            nodeId: node.id,
            port: port.key,
            item: m.name,
            key: m.key,
            text: made ? `No ${what} found for ${m.name}: no ${singular(made.from)} has its name.` : `No ${what} found for ${m.name}.`,
            candidates,
            ...(where ? { files: Object.fromEntries(candidates.flatMap((c) => (where.has(c) ? [[c, where.get(c)!]] : []))) } : {}),
          });
        }
        if (missing.length > 30) skipped.push({ text: `${missing.length - 30} more items have no ${what} and will be skipped.` });
      }
      if (unused.length && !missing.length) skipped.push({ text: `Not used by any item: ${list(unused)}.` });
      if (iter.type === "rows" && rule.by === "fileNameEqualsColumn") {
        const source = { id: "", label: iterEdge?.from.nodeId ?? "", kind: "rows" as const, items: iter.items, columns: iter.columns };
        for (const d of duplicatesIn(source, rule.column).slice(0, 3)) skipped.push({ text: `“${d.value}” is in ${d.rows.length} rows (${list(d.rows)}); they all get the same ${what}.` });
      }
    }
  }
  return { fixed, needs, skipped, ...(notes.length ? { notes } : {}), ...(aiCalls ? { aiCalls } : {}), ...(Object.keys(matched).length ? { columns: matched } : {}) };
}

/** Good to know about the picked images: CMYK ones (where results are RGB) and very large ones. */
async function imageNotes(flow: Flow, info: FlowRoutines, node: Input, value: PortValue): Promise<PreflightNote[]> {
  const files = value.kind === "list" ? value.items.map((i) => String(i.value)) : value.type === "file" ? [String(value.value)] : [];
  const images = files.filter(isCheckedImage).slice(0, 500);
  const infos = await Promise.all(images.map(readImageInfo));
  const named = (pick: (i: ImageInfo) => boolean | undefined) => images.filter((_, k) => infos[k] && pick(infos[k]!)).map((f) => path.basename(f));
  const out: PreflightNote[] = [];
  // InDesign keeps CMYK for print; Photoshop's PNGs and anything in Figma are RGB.
  const apps = flow.edges.filter((e) => e.from.nodeId === node.id).map((e) => routineOf(info, e.to.nodeId)?.appId);
  const cmyk = apps.some((a) => a && a !== "indesign") ? named((i) => i.cmyk) : [];
  if (cmyk.length) out.push({ text: `${list(cmyk)} ${cmyk.length === 1 ? "is a CMYK image" : "are CMYK images"}. PNG and Figma results are RGB, so colors can shift a little.` });
  const large = images.flatMap((f, k) => {
    const i = infos[k];
    return i?.width && i.height && i.width * i.height >= LARGE_PIXELS ? [`${path.basename(f)} (${i.width} × ${i.height} px)`] : [];
  });
  if (large.length) out.push({ text: `Very large: ${list(large)}. ${large.length === 1 ? "It" : "They"} will be slow and make big files.` });
  return out;
}

/**
 * What an earlier routine will make, guessed before the run: when it runs once per picked file and passes files on,
 * it makes one (or a few) per file, which keep that file's key, and usually its name.
 */
function madeFrom(flow: Flow, info: FlowRoutines, values: Map<string, PortValue>, from: { nodeId: string; port: string }): { files: PortValue; from: string } | undefined {
  const maker = routineOf(info, from.nodeId);
  const out = maker?.outputs.find((p) => p.key === from.port);
  if (!maker?.iterate || !out || (out.type !== "file" && out.type !== "fileList")) return undefined;
  const source = flow.edges.find((e) => e.to.nodeId === from.nodeId && e.to.port === maker.iterate!.input);
  const files = source ? values.get(source.from.nodeId) : undefined;
  if (!files || files.kind !== "list" || files.type !== "fileList") return undefined;
  const label = flow.nodes.find((n) => n.id === source!.from.nodeId);
  return { files, from: label?.kind === "input" ? label.port.label : "file" };
}

/** AI that tells which of the designer's files goes with each item that found none by name. */
export type FileMatcher = (input: { routine: string; what: string; items: string[]; files: string[]; pictures?: { name: string; path: string }[] }) => Promise<Record<string, string | null>>;

/** At most this many pictures go with one "Let Doppl match them" call (files whose names say nothing). */
const MAX_PICTURES = 8;

/** A file name that says nothing about what's in it: "IMG_4032.jpg", "DSC00012.JPG", "Photo 2024-10-01 at 10.32.png". */
export function namelessFile(name: string): boolean {
  const stem = name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const words = stem.split(/[^a-z]+/).filter((w) => w.length >= 3 && !/^(img|dsc|dscf|dcim|pxl|photo|image|picture|scan|screenshot|untitled|copy|final|edit|at|and)$/.test(w));
  return words.length === 0;
}

/**
 * "Let Doppl match them": the files the AI suggests for items the check found without one, by issue id. One AI call
 * per input that pairs; the designer approves the suggestions, which are then kept like files picked by hand.
 */
export async function suggestPartners(flow: Flow, info: FlowRoutines, needs: PreflightIssue[], match: FileMatcher): Promise<Record<string, string>> {
  const groups = new Map<string, Extract<PreflightIssue, { kind: "partner" }>[]>();
  for (const i of needs) if (i.kind === "partner" && i.candidates.length) groups.set(`${i.nodeId}:${i.port}`, [...(groups.get(`${i.nodeId}:${i.port}`) ?? []), i]);
  const out: Record<string, string> = {};
  for (const group of groups.values()) {
    const routine = routineOf(info, group[0].nodeId);
    const port = routine?.inputs.find((p) => p.key === group[0].port);
    const files = [...new Set(group.flatMap((i) => i.candidates))];
    // Names that say nothing: the AI looks at those pictures instead.
    const where = Object.assign({}, ...group.map((i) => i.files ?? {})) as Record<string, string>;
    const pictures = files.filter((f) => where[f] && namelessFile(f)).slice(0, MAX_PICTURES).map((f) => ({ name: f, path: where[f] }));
    const found = await match({
      routine: routine ? [routine.name, ...(routine.steps ?? []).map((s) => s.plainLanguage)].join(": ") : "",
      what: port?.label ?? group[0].port,
      items: group.map((i) => i.item),
      files,
      ...(pictures.length ? { pictures } : {}),
    });
    const used = new Set<string>();
    for (const i of group) {
      const file = found[i.item];
      if (!file || !i.candidates.includes(file) || used.has(file)) continue;
      out[i.id] = file;
      used.add(file);
    }
  }
  return out;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

import path from "node:path";
import { DataFileError, type ReadAs, listFolderFiles, readDataFile } from "../helpers/dataFiles";
import { fileAllowed } from "../../shared/ports";
import type { InputValue, PortDef, PortType } from "../types";
import { errorMessage } from "../util";
import { type Composite, fileItem } from "../routines/placeholders";

// What travels along a flow's edges at run time. Lists keep an item key per entry (a data row "row-3", a file
// "file-photo.png"), so a routine further down knows which original item a file came from: a row that failed
// in Photoshop is skipped in Figma, and joins can pair items by the row they came from.

export interface ListItem {
  key: string;
  label: string;
  /** fileList: the file's path. rows: the row object. */
  value: unknown;
}

export type PortValue =
  | { kind: "value"; type: PortType; value: string | number | boolean | null }
  | { kind: "list"; type: "fileList" | "rows"; items: ListItem[]; columns?: string[]; name?: string; path?: string; readAs?: ReadAs };

/** An item that can't run, with the reason (a data row with errors). */
export interface ItemProblem {
  key: string;
  label: string;
  error: string;
}

/** A problem with an input value as a whole (a missing file, a data file without the needed columns). */
export class InputValueError extends Error {}

const LABEL_FIELDS = ["name", "title", "product", "sku", "id", "label", "code"];

/** "Row 3 · Strawberry jam": the row number and its most telling value. */
export function rowLabel(row: Record<string, unknown>, rowNumber: number): string {
  const keys = Object.keys(row);
  const preferred = LABEL_FIELDS.map((f) => keys.find((k) => k.toLowerCase() === f)).find((k) => k && row[k] !== null && row[k] !== "");
  const key = preferred ?? keys.find((k) => typeof row[k] === "string" && String(row[k]).trim());
  const value = key ? String(row[key]).trim() : "";
  return value ? `Row ${rowNumber} · ${value.slice(0, 40)}` : `Row ${rowNumber}`;
}

export const fileKey = (file: string) => `file-${path.basename(file)}`;

/** A file list from paths, keyed by file name (made unique). */
export function fileList(files: string[], keyOf: (file: string, i: number) => string = (f) => fileKey(f)): PortValue {
  const seen = new Map<string, number>();
  const items = files.map((file, i) => {
    let key = keyOf(file, i);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}-${n}`;
    return { key, label: path.basename(file), value: file };
  });
  return { kind: "list", type: "fileList", items };
}

/**
 * Reads what was picked for a flow input: a data file becomes rows, files or a folder become a file list.
 * Rows with errors are left out of the list and returned as problems (they fail at the input, the rest runs).
 */
export async function resolveInput(
  port: PortDef,
  raw: InputValue | undefined,
  options: { aliases?: Record<string, string> } = {},
): Promise<{ value: PortValue | null; problems: ItemProblem[] }> {
  const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
  if (empty) return { value: null, problems: [] };
  switch (port.type) {
    case "rows": {
      if (typeof raw !== "string") throw new InputValueError(`${port.label}: pick a CSV, JSON or Excel file.`);
      let table;
      try {
        table = await readDataFile(raw, { requiredColumns: port.columns, knownColumns: port.uses, aliases: options.aliases });
      } catch (err) {
        throw new InputValueError(err instanceof DataFileError ? err.message : `${path.basename(raw)} couldn't be read: ${errorMessage(err)}`);
      }
      const errors = new Map<number, string>();
      for (const e of table.errors) errors.set(e.row, [errors.get(e.row), e.message].filter(Boolean).join(" "));
      const items: ListItem[] = [];
      const problems: ItemProblem[] = [];
      table.rows.forEach((row, i) => {
        const n = table.rowNumbers[i] ?? i + 1;
        const item = { key: `row-${n}`, label: rowLabel(row, n), value: row };
        const problem = errors.get(n);
        if (problem) problems.push({ key: item.key, label: item.label, error: `Row ${n}: ${problem}` });
        else items.push(item);
      });
      return { value: { kind: "list", type: "rows", items, columns: table.columns, name: path.basename(raw), path: raw, ...(table.readAs ? { readAs: table.readAs } : {}) }, problems };
    }
    case "fileList": {
      let files: string[];
      if (Array.isArray(raw)) files = raw.map(String);
      else if (typeof raw === "string") {
        try {
          files = (await listFolderFiles(raw, { extensions: port.extensions })).map((f) => f.path);
        } catch (err) {
          throw new InputValueError(err instanceof DataFileError ? err.message : errorMessage(err));
        }
      } else throw new InputValueError(`${port.label}: pick files or a folder.`);
      const wrong = files.filter((f) => !fileAllowed(f, port.extensions));
      if (wrong.length) throw new InputValueError(`${port.label} takes ${port.extensions!.join(", ")} files; ${path.basename(wrong[0])} isn't one.`);
      return { value: fileList(files), problems: [] };
    }
    case "file":
      if (typeof raw !== "string") throw new InputValueError(`${port.label}: pick a file.`);
      if (!fileAllowed(raw, port.extensions)) throw new InputValueError(`${port.label} takes ${port.extensions!.join(", ")} files; ${path.basename(raw)} isn't one.`);
      return { value: { kind: "value", type: "file", value: raw }, problems: [] };
    case "folder":
    case "document":
    case "text":
      return { value: { kind: "value", type: port.type, value: String(raw) }, problems: [] };
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new InputValueError(`${port.label} must be a number.`);
      return { value: { kind: "value", type: "number", value: n }, problems: [] };
    }
    case "boolean":
      return { value: { kind: "value", type: "boolean", value: raw === true || raw === "true" }, problems: [] };
  }
}

/** A value as the input of a port: a file becomes a list of one, a folder a list of its files, a number text. */
export async function adaptValue(value: PortValue, port: PortDef): Promise<PortValue> {
  if (port.type === "fileList" && value.kind === "value" && value.type === "file" && typeof value.value === "string") return fileList([value.value]);
  if (port.type === "fileList" && value.kind === "value" && value.type === "folder" && typeof value.value === "string") {
    const files = await listFolderFiles(value.value, { extensions: port.extensions }).catch(() => []);
    return fileList(files.map((f) => f.path));
  }
  if (port.type === "text" && value.kind === "value" && value.value !== null) return { kind: "value", type: "text", value: String(value.value) };
  return value;
}

/** How many items a value has (1 for a single value). */
export const countOf = (value: PortValue | null | undefined) => (!value ? 0 : value.kind === "list" ? value.items.length : 1);

/** A port value for placeholders: {{inputs.<key>}} and its parts. */
export async function scopeValue(value: PortValue | undefined): Promise<unknown> {
  if (!value) return undefined;
  if (value.kind === "list") {
    if (value.type === "rows") {
      return { __value: value.name ?? `${value.items.length} rows`, rows: value.items.map((i) => i.value), columns: value.columns ?? [], name: value.name ?? "", count: value.items.length } satisfies Composite;
    }
    const files = value.items.map((i) => String(i.value));
    return { __value: files, files: files.map(fileItem), count: files.length } satisfies Composite;
  }
  if (value.type === "file" && typeof value.value === "string") return fileItem(value.value);
  if (value.type === "folder" && typeof value.value === "string") {
    const files = await listFolderFiles(value.value).catch(() => []);
    return { __value: value.value, path: value.value, name: path.basename(value.value), files: files.map((f) => fileItem(f.path)) } satisfies Composite;
  }
  return value.value;
}

/** A port value for scripts (params.<key>): paths, lists of paths, rows with their columns, plain values. */
export function scriptValue(value: PortValue | undefined): unknown {
  if (!value) return null;
  if (value.kind === "list") {
    if (value.type === "rows") return { rows: value.items.map((i) => i.value), columns: value.columns ?? [], name: value.name ?? "", path: value.path ?? null };
    return value.items.map((i) => String(i.value));
  }
  return value.value;
}

/** An item as {{item}} / ctx.item: a row object, or a file with its parts. */
export function itemValue(listType: "fileList" | "rows", item: ListItem): unknown {
  return listType === "fileList" ? fileItem(String(item.value)) : item.value;
}

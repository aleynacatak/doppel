import fs from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import readXlsxFile from "read-excel-file/node";
import { nameKey } from "../../shared/names";
import { extensionOf, normalizeExtensions as foldExtensions } from "../../shared/ports";

// Reads the spreadsheets and data files a routine runs on (CSV/TSV, JSON, Excel) into plain rows,
// and finds files in a folder by the names those rows mention.

export type DataValue = string | number | boolean | null;

/**
 * A problem with one row. `row` is the 1-based data row number: the header isn't counted, blank rows are,
 * so row 1 is the line right under the column names. `message` is a full sentence without a "Row N:"
 * prefix (show it as `Row ${row}: ${message}`), with column names in double quotes, e.g. `"price" is empty.`
 */
export interface DataRowError {
  row: number;
  column?: string;
  message: string;
}

export interface DataTable {
  fileName: string;
  format: "csv" | "json" | "xlsx";
  columns: string[];
  /** Every row has every column; empty values are null. Rows with errors are kept unless the error says otherwise. */
  rows: Record<string, DataValue>[];
  /** The 1-based data row number of each entry in `rows` (blank rows are skipped but counted), to match `errors`. */
  rowNumbers: number[];
  errors: DataRowError[];
  /** How the file was read, for telling the designer what Doppl handled (encoding, delimiter, renamed columns). */
  readAs?: ReadAs;
}

export interface ReadAs {
  /** "utf-8", "utf-16le", "utf-16be", "windows-1254" (Turkish), "windows-1252" (Western). */
  encoding?: string;
  delimiter?: string;
  /** Columns read under the name the routine expects: expected name → the name in the file ("Flavor" → "FLAVOR "). */
  renamed?: Record<string, string>;
}

/** A problem with the whole file. The message is a plain-language sentence that names the file. */
export class DataFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataFileError";
  }
}

export interface ReadDataOptions {
  /** Columns that must exist, and must have a value in every row. */
  requiredColumns?: string[];
  /** Default 10000. */
  maxRows?: number;
  /** Excel only: sheet name, or sheet number starting at 1. Default: the first sheet. */
  sheet?: string | number;
  /** Columns the designer picked for required ones Doppl couldn't find: required name → the column in the file. */
  aliases?: Record<string, string>;
  /** Other columns a routine reads: found under any case or spelling like required ones, but may be missing or empty. */
  knownColumns?: string[];
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 10000;
const FORMATS: Record<string, DataTable["format"]> = { csv: "csv", tsv: "csv", txt: "csv", json: "json", xlsx: "xlsx" };

/**
 * Reads a CSV/TSV/TXT, JSON or XLSX file. CSV values stay text (so leading zeros survive); Excel keeps
 * numbers, true/false and dates (as "YYYY-MM-DD", or a full ISO time when there is one).
 * Throws DataFileError for problems with the whole file; problems with single rows go to `errors`.
 */
export async function readDataFile(filePath: string, options: ReadDataOptions = {}): Promise<DataTable> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const format = FORMATS[ext];
  if (!format) {
    const kind = ext ? `".${ext}" files` : "files without an extension";
    throw new DataFileError(`Doppl can't read ${kind}. Save ${fileName} as CSV, Excel (.xlsx) or JSON and try again.`);
  }

  let data: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new DataFileError(`${fileName} is a folder, not a data file.`);
    if (stat.size > MAX_FILE_BYTES) {
      const mb = (stat.size / 1024 / 1024).toFixed(1);
      throw new DataFileError(`${fileName} is too large (${mb} MB). Doppl can read data files up to 20 MB.`);
    }
    data = await fs.readFile(filePath);
  } catch (err) {
    if (err instanceof DataFileError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DataFileError(`Couldn't find ${fileName}. It may have been moved or renamed.`);
    }
    throw new DataFileError(`Couldn't open ${fileName}. Check that Doppl is allowed to read it.`);
  }

  const ctx: Context = {
    fileName,
    format,
    required: options.requiredColumns ?? [],
    known: options.knownColumns ?? [],
    aliases: options.aliases ?? {},
    maxRows: options.maxRows && options.maxRows > 0 ? Math.max(1, Math.floor(options.maxRows)) : DEFAULT_MAX_ROWS,
    readAs: {},
  };
  if (format === "xlsx") return readXlsx(ctx, data, options.sheet);
  const { text, encoding } = decodeText(data);
  ctx.readAs.encoding = encoding;
  if (format === "json") return readJson(ctx, text);
  return readCsv(ctx, text, ext === "tsv" ? "\t" : "");
}

interface Context {
  fileName: string;
  format: DataTable["format"];
  required: string[];
  known: string[];
  aliases: Record<string, string>;
  maxRows: number;
  readAs: ReadAs;
}

interface Entry {
  row: number;
  values: Record<string, DataValue>;
}

// ---- CSV ----

function readCsv(ctx: Context, text: string, delimiter: string): DataTable {
  // Guess the delimiter with blank lines ignored, then parse everything so row numbers match the file.
  const sep = delimiter || sniffDelimiter(text);
  ctx.readAs.delimiter = sep;
  const parsed = Papa.parse<string[]>(text, { delimiter: sep, header: false, skipEmptyLines: false, dynamicTyping: false });
  const grid = parsed.data.map((record) => record.map(cleanValue));
  const headerIndex = grid.findIndex((record) => !isEmptyRecord(record));

  const errors: DataRowError[] = [];
  for (const e of parsed.errors) {
    if (e.type !== "Quotes" || e.row === undefined) continue;
    const message =
      e.code === "MissingQuotes"
        ? `A quotation mark (") is never closed, so everything after it was read as one value.`
        : `A quotation mark (") is in an unexpected place. Quoted values should look like "value".`;
    if (headerIndex < 0 || e.row <= headerIndex) {
      throw new DataFileError(`The column names in ${ctx.fileName} have a problem: ${message}`);
    }
    errors.push({ row: e.row - headerIndex, message });
  }
  return fromGrid(ctx, grid, errors, true);
}

/**
 * The delimiter whose columns line up: the header and (nearly) every row have the same number of fields, at least
 * two. Tab, then semicolon, then comma, then pipe: a value often holds a comma ("2,5", "TL, KDV dahil"), rarely a
 * semicolon, almost never a tab. Without a clear one, Papa's own guess.
 */
export function sniffDelimiter(text: string): string {
  for (const sep of ["\t", ";", ",", "|"]) {
    if (!text.includes(sep)) continue;
    const rows = Papa.parse<string[]>(text, { delimiter: sep, preview: 50, skipEmptyLines: "greedy" }).data;
    if (rows.length === 0) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    const same = rows.filter((r) => r.length === width).length;
    if (rows.length === 1 || same / rows.length >= 0.8) return sep;
  }
  return Papa.parse<string[]>(text, { preview: 50, skipEmptyLines: "greedy" }).meta.delimiter || ",";
}

/**
 * The text of a CSV or JSON file, whatever saved it: UTF-8 (with or without a BOM), UTF-16 (Excel's "Unicode
 * Text", with or without a BOM, either byte order), or an older 8-bit export: Turkish Windows when it has Turkish
 * letters (ğ ı ş İ Ş Ğ sit where Western Windows has ð ý þ Ý Þ Ð), Western Windows otherwise.
 */
function decodeText(data: Buffer): { text: string; encoding: string } {
  const decode = (encoding: string, bytes: Buffer = data) => ({ text: new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, ""), encoding });
  if (data[0] === 0xff && data[1] === 0xfe) return decode("utf-16le", data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return decode("utf-16be", data.subarray(2));
  // UTF-16 without a BOM: every other byte of plain text is 0.
  const head = data.subarray(0, Math.min(data.length, 2000));
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) i % 2 ? oddZeros++ : evenZeros++;
  if (head.length >= 4 && oddZeros > head.length * 0.3) return decode("utf-16le");
  if (head.length >= 4 && evenZeros > head.length * 0.3) return decode("utf-16be");
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^\uFEFF/, ""), encoding: "utf-8" };
  } catch {
    const turkish = data.some((b) => b === 0xd0 || b === 0xdd || b === 0xde || b === 0xf0 || b === 0xfd || b === 0xfe);
    return decode(turkish ? "windows-1254" : "windows-1252");
  }
}

// ---- XLSX ----

async function readXlsx(ctx: Context, data: Buffer, sheet: string | number | undefined): Promise<DataTable> {
  let sheets;
  try {
    sheets = await readXlsxFile(data, { trim: false });
  } catch {
    throw new DataFileError(`${ctx.fileName} couldn't be opened as an Excel file. Open it in Excel, save it as .xlsx and try again.`);
  }
  const names = sheets.map((s) => s.sheet);
  let picked: (typeof sheets)[number] | undefined = sheets[0];
  if (typeof sheet === "number") picked = sheets[sheet - 1];
  else if (typeof sheet === "string") {
    picked = sheets.find((s) => s.sheet === sheet) ?? sheets.find((s) => s.sheet.toLowerCase() === sheet.trim().toLowerCase());
  }
  if (!picked) {
    const which = typeof sheet === "number" ? `a sheet number ${sheet}` : `a sheet called "${sheet}"`;
    throw new DataFileError(`${ctx.fileName} doesn't have ${which}. Its sheets are: ${names.join(", ")}.`);
  }

  const grid = picked.data.map((record) => record.map((cell) => cleanValue(cell as unknown)));
  return fromGrid(ctx, grid, [], false);
}

function isoDate(date: Date): string {
  // Excel stores dates as fractions of a day; round away the float noise before deciding if there's a time.
  const d = new Date(Math.round(date.getTime() / 1000) * 1000);
  const iso = d.toISOString();
  return d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? iso : iso.slice(0, 10);
}

// ---- JSON ----

function readJson(ctx: Context, text: string): DataTable {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    const line = /line (\d+)/.exec(String((err as Error).message))?.[1];
    const near = line ? ` near line ${line}` : "";
    throw new DataFileError(`${ctx.fileName} isn't valid JSON. Check${near} for a missing comma, quote or bracket.`);
  }
  const list = Array.isArray(doc)
    ? doc
    : isPlainObject(doc) && Array.isArray(doc.rows)
      ? doc.rows
      : isPlainObject(doc) && Array.isArray(doc.data)
        ? doc.data
        : null;
  if (!list) {
    throw new DataFileError(`${ctx.fileName} should contain a list of rows, like [{"name": "…", "price": "…"}].`);
  }

  const columns: string[] = [];
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const errors: DataRowError[] = [];
  for (let i = 0; i < list.length; i++) {
    const row = i + 1;
    const item: unknown = list[i];
    if (!isPlainObject(item)) {
      errors.push({ row, message: `This item isn't a row of values (like {"name": "…"}), so it was skipped.` });
      continue;
    }
    const values: Record<string, DataValue> = {};
    const nested: string[] = [];
    for (const [key, raw] of Object.entries(item)) {
      if (raw !== null && typeof raw === "object") {
        nested.push(key);
        values[key] = null;
      } else values[key] = cleanValue(raw);
    }
    if (isEmptyRecord(Object.values(values)) && nested.length === 0) continue;
    if (entries.length >= ctx.maxRows) {
      errors.push(limitError(ctx, row));
      break;
    }
    for (const key of nested) {
      errors.push({ row, column: key, message: `"${key}" holds a list or group of values, which can't be used. It was left empty.` });
    }
    for (const key of Object.keys(values)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    entries.push({ row, values });
  }
  return finish(ctx, columns, entries, errors);
}

// ---- Shared ----

function fromGrid(ctx: Context, grid: DataValue[][], errors: DataRowError[], csv: boolean): DataTable {
  const headerIndex = grid.findIndex((record) => !isEmptyRecord(record));
  if (headerIndex < 0) throw new DataFileError(`${ctx.fileName} is empty.`);

  const header = grid[headerIndex].map((cell) => (cell === null ? "" : String(cell).trim()));
  // Trailing empty header cells are padding (a trailing comma, or an Excel sheet wider than its data).
  while (header.length && header[header.length - 1] === "") header.pop();
  const unnamed = header.indexOf("");
  if (unnamed >= 0) {
    throw new DataFileError(
      `Column ${unnamed + 1} in ${ctx.fileName} has no name. Give every column a name in the first row.`,
    );
  }
  const duplicate = header.find((name, i) => header.indexOf(name) !== i);
  if (duplicate !== undefined) {
    throw new DataFileError(`${ctx.fileName} has more than one column called "${duplicate}". Column names must be unique.`);
  }

  const entries: Entry[] = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const record = grid[i];
    if (isEmptyRecord(record)) continue;
    const row = i - headerIndex;
    if (entries.length >= ctx.maxRows) {
      errors.push(limitError(ctx, row));
      break;
    }
    const values: Record<string, DataValue> = {};
    header.forEach((name, j) => (values[name] = record[j] ?? null));
    let lastFilled = record.length - 1;
    while (lastFilled >= 0 && record[lastFilled] === null) lastFilled--;
    if (lastFilled >= header.length) {
      errors.push({
        row,
        message: csv
          ? `This row has ${lastFilled + 1} values, but there are only ${header.length} columns. The extra values were left out.`
          : "This row has values in columns without a name. They were left out.",
      });
    } else if (csv && record.length < header.length) {
      errors.push({
        row,
        message: `This row has ${record.length} ${record.length === 1 ? "value" : "values"}, but there are ${header.length} columns. The missing values were left empty.`,
      });
    }
    entries.push({ row, values });
  }
  return finish(ctx, header, entries, errors);
}

function finish(ctx: Context, fileColumns: string[], entries: Entry[], errors: DataRowError[]): DataTable {
  // A column the routine expects under another case, spacing or spelling of letters ("FLAVOR ", "ürün adı" for
  // "Ürün Adı") is read under the expected name; two columns that both look like it are a problem to fix.
  const columns = [...fileColumns];
  const renamed: Record<string, string> = {};
  const expected = [...ctx.required, ...ctx.known.filter((k) => !ctx.required.includes(k))];
  for (const name of expected) {
    if (columns.includes(name)) continue;
    const picked = ctx.aliases[name];
    const like = columns.filter((c) => !expected.includes(c) && (picked !== undefined ? nameKey(c) === nameKey(picked) : nameKey(c) === nameKey(name)));
    if (like.length > 1) throw new DataFileError(`${ctx.fileName} has more than one column like "${name}": ${like.map((c) => `"${c}"`).join(", ")}. Keep one of them.`);
    if (like.length === 1) {
      columns[columns.indexOf(like[0])] = name;
      renamed[name] = like[0];
    }
  }
  const missing = ctx.required.filter((name) => !columns.includes(name));
  if (missing.length) {
    const list = missing.map((name) => `"${name}"`);
    const names = list.length === 1 ? `the column ${list[0]}` : `the columns ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
    const hint = ctx.format === "json" ? "" : " Check the column names in the first row.";
    throw new DataFileError(`${ctx.fileName} is missing ${names}.${hint}`);
  }

  const rows = entries.map(({ row, values }) => {
    for (const name of ctx.required) {
      if (isEmpty(values[renamed[name] ?? name])) errors.push({ row, column: name, message: `"${name}" is empty.` });
    }
    return Object.fromEntries(columns.map((name, i) => [name, values[fileColumns[i]] ?? null]));
  });
  errors.sort((a, b) => a.row - b.row);
  const readAs: ReadAs = { ...ctx.readAs, ...(Object.keys(renamed).length ? { renamed } : {}) };
  return { fileName: ctx.fileName, format: ctx.format, columns, rows, rowNumbers: entries.map((e) => e.row), errors, ...(Object.keys(readAs).length ? { readAs } : {}) };
}

function limitError(ctx: Context, row: number): DataRowError {
  const max = ctx.maxRows.toLocaleString("en-US");
  return { row, message: `Only the first ${max} rows were read. This row and the rest of the file were skipped.` };
}

/** Empty or whitespace-only text becomes null; dates become ISO strings. */
function cleanValue(value: unknown): DataValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoDate(value);
  return String(value);
}

const isEmpty = (value: DataValue | undefined) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

const isEmptyRecord = (record: DataValue[]) => record.every(isEmpty);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---- Folders ----

export interface FolderFile {
  name: string;
  path: string;
  /** Name without the extension. */
  stem: string;
  /** Lowercase, no dot. */
  ext: string;
}

/** Allowed extensions with aliases folded ("jpeg" and "jpg" are one format), or undefined: any. */
const normalizeExtensions = (list?: string[]) => (list?.length ? foldExtensions(list) : undefined);

/** Files directly in the folder (not recursive), sorted by name, without dotfiles; optional extension filter (case-insensitive, no dots). */
export async function listFolderFiles(folder: string, options: { extensions?: string[] } = {}): Promise<FolderFile[]> {
  const allowed = normalizeExtensions(options.extensions);
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const name = path.basename(folder);
    if (code === "ENOENT") throw new DataFileError(`Couldn't find the folder ${name}. It may have been moved or renamed.`);
    if (code === "ENOTDIR") throw new DataFileError(`${name} is a file, not a folder.`);
    throw new DataFileError(`Couldn't open the folder ${name}.`);
  }

  const files: FolderFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(folder, entry.name);
    // Follow symlinks, but only keep the ones that point at files.
    const isFile = entry.isFile() || (entry.isSymbolicLink() && (await fs.stat(full).then((s) => s.isFile(), () => false)));
    if (!isFile) continue;
    const extname = path.extname(entry.name);
    const ext = extname.slice(1).toLowerCase();
    if (allowed && !allowed.includes(extensionOf(entry.name))) continue;
    files.push({ name: entry.name, path: full, stem: entry.name.slice(0, entry.name.length - extname.length), ext });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Finds a file in the folder by name: exact, then case-insensitive, then by stem (the name without its
 * extension, so "logo" finds "logo.png"; with `extensions`, the first allowed extension wins).
 * Returns null if missing, and for names containing "/", "\" or "..". Throws DataFileError if the folder can't be read.
 */
export async function resolveFileInFolder(
  folder: string,
  name: string,
  options: { extensions?: string[] } = {},
): Promise<string | null> {
  const wanted = String(name ?? "").trim();
  if (!wanted || /[/\\\0]/.test(wanted) || wanted.includes("..")) return null;

  const files = await listFolderFiles(folder, options);
  const exact = files.find((f) => f.name === wanted);
  if (exact) return exact.path;

  // macOS may store accented names decomposed, while typed text is usually composed.
  const fold = (s: string) => s.normalize("NFC").toLowerCase();
  const target = fold(wanted);
  const caseless = files.find((f) => fold(f.name) === target);
  if (caseless) return caseless.path;

  const byStem = files.filter((f) => fold(f.stem) === target);
  if (!byStem.length) return null;
  const order = normalizeExtensions(options.extensions);
  if (order) byStem.sort((a, b) => order.indexOf(extensionOf(a.name)) - order.indexOf(extensionOf(b.name)));
  return byStem[0].path;
}

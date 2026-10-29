import type { AppId, PortDef, PortType } from "../core/types";

// Port types and the rules for connecting them: the one place that decides whether a routine's output can feed
// another routine's input. Used by the main process (validation, runs) and the renderer (highlighting compatible
// ports while a connection is dragged), so it stays free of Node.js and Electron.

export const PORT_TYPES: readonly PortType[] = ["file", "fileList", "folder", "rows", "document", "text", "number", "boolean"];

/** Types whose values are lists of items (a routine can iterate over them). */
export const LIST_TYPES: readonly PortType[] = ["fileList", "rows"];

export const isListType = (type: PortType) => LIST_TYPES.includes(type);

/** What travels along an edge: a port's type with its sub-type. */
export interface PortSpec {
  type: PortType;
  /** file, fileList: allowed extensions, normalized ("jpeg" → "jpg"). Empty or missing: any file. */
  extensions?: string[];
  /** rows: the columns every row has, when known. */
  columns?: string[];
  /** document: the app the document is open in. */
  app?: AppId;
}

const ALIASES: Record<string, string> = { jpeg: "jpg", tiff: "tif", htm: "html", yml: "yaml" };

/** Lowercase, without dots, aliases folded ("JPEG" → "jpg"), each once. */
export function normalizeExtensions(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const ext = raw.trim().replace(/^\*?\./, "").toLowerCase();
    if (!/^[a-z0-9]{1,8}$/.test(ext)) continue;
    const folded = ALIASES[ext] ?? ext;
    if (!out.includes(folded)) out.push(folded);
  }
  return out;
}

/** The extension of a file name or path, normalized ("Photo.JPEG" → "jpg"). */
export function extensionOf(file: string): string {
  const name = file.split("/").pop() ?? file;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (normalizeExtensions([name.slice(dot + 1)])[0] ?? "") : "";
}

/** Whether a file is allowed by an extension list (an empty list allows any file). */
export function fileAllowed(file: string, extensions: string[] | undefined): boolean {
  const allowed = normalizeExtensions(extensions);
  return allowed.length === 0 || allowed.includes(extensionOf(file));
}

const withSubtype = (spec: PortSpec, port: Pick<PortDef, "extensions" | "columns">): PortSpec => {
  const extensions = normalizeExtensions(port.extensions);
  if ((spec.type === "file" || spec.type === "fileList") && extensions.length) spec.extensions = extensions;
  if (spec.type === "rows" && port.columns?.length) spec.columns = [...port.columns];
  return spec;
};

/** What an input port accepts. `app` is the routine's app (for document inputs). */
export function inputSpec(port: PortDef, app?: AppId): PortSpec {
  return withSubtype({ type: port.type, ...(port.type === "document" && app ? { app } : {}) }, port);
}

/**
 * What a routine output carries downstream. An iterating routine runs once per item and its outputs are collected
 * into lists: files become a file list, rows stay rows, and one value per item becomes rows with one column.
 */
export function outputSpec(port: PortDef, iterates: boolean, app?: AppId): PortSpec {
  if (!iterates) return withSubtype({ type: port.type, ...(port.type === "document" && app ? { app } : {}) }, port);
  if (port.type === "file" || port.type === "fileList") return withSubtype({ type: "fileList" }, port);
  if (port.type === "rows") return withSubtype({ type: "rows" }, port);
  return { type: "rows", columns: [port.key] };
}

export type Compatibility = { ok: true } | { ok: false; reason: string };

const OK: Compatibility = { ok: true };
const no = (reason: string): Compatibility => ({ ok: false, reason });

function extensionsFit(from: PortSpec, to: PortSpec): Compatibility {
  const wanted = to.extensions ?? [];
  const given = from.extensions ?? [];
  // Unknown file types are checked file by file when the flow runs.
  if (wanted.length === 0 || given.length === 0) return OK;
  const extra = given.filter((e) => !wanted.includes(e));
  if (extra.length === 0) return OK;
  return no(`${describeSpec({ ...from, extensions: extra })} can't go into an input that takes ${describeSpec(to)}.`);
}

/** Whether a value of type `from` can feed an input of type `to`, and why not. */
export function compatible(from: PortSpec, to: PortSpec): Compatibility {
  const mismatch = () => no(`${describeSpec(from)} can't go into an input that takes ${describeSpec(to)}.`);
  switch (to.type) {
    case "file":
      if (from.type === "fileList") return no(`A list of files can't go into an input that takes one file. ${describeSpec(to)} is one file.`);
      return from.type === "file" ? extensionsFit(from, to) : mismatch();
    case "fileList":
      if (from.type === "folder") return OK;
      return from.type === "file" || from.type === "fileList" ? extensionsFit(from, to) : mismatch();
    case "folder":
      return from.type === "folder" ? OK : mismatch();
    case "rows": {
      if (from.type !== "rows") return mismatch();
      const missing = from.columns?.length && to.columns?.length ? to.columns.filter((c) => !from.columns!.includes(c)) : [];
      return missing.length ? no(`The rows have no ${missing.map((c) => `"${c}"`).join(", ")} ${missing.length === 1 ? "column" : "columns"}.`) : OK;
    }
    case "document":
      if (from.type !== "document") return mismatch();
      return from.app && to.app && from.app !== to.app ? no(`A ${appName(from.app)} document can't go into a ${appName(to.app)} routine.`) : OK;
    case "text":
      return from.type === "text" || from.type === "number" || from.type === "boolean" ? OK : mismatch();
    case "number":
    case "boolean":
      return from.type === to.type ? OK : mismatch();
  }
}

/** Output nodes ("Save to folder") take files, folders, rows and values; documents stay in their app. */
export function acceptedByOutput(from: PortSpec): Compatibility {
  return from.type === "document" ? no("A document stays in its app; it can't be saved to a folder.") : OK;
}

const APP_NAMES: Record<string, string> = { indesign: "InDesign", figma: "Figma", photoshop: "Photoshop" };
const appName = (app: AppId) => APP_NAMES[app] ?? app;

const extList = (exts: string[]) => {
  const upper = exts.map((e) => e.toUpperCase());
  return upper.length <= 1 ? upper.join("") : `${upper.slice(0, -1).join(", ")} or ${upper[upper.length - 1]}`;
};

/** Plain-language type, e.g. "PNG files", "a PSD file", "data rows", "a Figma document". */
export function describeSpec(spec: PortSpec): string {
  const exts = spec.extensions ?? [];
  switch (spec.type) {
    case "file":
      return exts.length ? `a ${extList(exts)} file` : "a file";
    case "fileList":
      return exts.length ? `${extList(exts)} files` : "files";
    case "folder":
      return "a folder";
    case "rows":
      return "data rows";
    case "document":
      return spec.app ? `a ${appName(spec.app)} document` : "a document";
    case "text":
      return "text";
    case "number":
      return "a number";
    case "boolean":
      return "yes / no";
  }
}

/** Short type tag for developers, e.g. "fileList<png|jpg>", "rows<sku,photo>". */
export function typeTag(spec: PortSpec): string {
  if ((spec.type === "file" || spec.type === "fileList") && spec.extensions?.length) return `${spec.type}<${spec.extensions.join("|")}>`;
  if (spec.type === "rows" && spec.columns?.length) return `rows<${spec.columns.join(",")}>`;
  if (spec.type === "document" && spec.app) return `document<${spec.app}>`;
  return spec.type;
}

/** What an edge carries, for its label: "6 PNG", "12 rows", "1 file". */
export function countLabel(spec: PortSpec, count: number): string {
  const exts = spec.extensions ?? [];
  switch (spec.type) {
    case "file":
    case "fileList":
      return exts.length === 1 ? `${count} ${exts[0].toUpperCase()}` : `${count} ${count === 1 ? "file" : "files"}`;
    case "rows":
      return `${count} ${count === 1 ? "row" : "rows"}`;
    default:
      return count === 1 ? "1 value" : `${count} values`;
  }
}

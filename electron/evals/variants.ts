import fs from "node:fs/promises";
import path from "node:path";
import { compactKey } from "../shared/names";
import { listFolderFiles, readDataFile } from "../core/helpers/dataFiles";

// Messy versions of a task's inputs, made the way designers' real files differ from the ones a routine was made
// with: names in other case, with other separators, as one word, with copy suffixes; data saved by another
// program; extra files. What the files hold doesn't change, so a routine should give the same results. Used by the
// variety eval (saved routines rerun on each version, no AI) and to make a messy copy for a demo.

export interface Variant {
  id: string;
  label: string;
  /** A new file name stem (the n-th file of a folder). */
  rename?: (stem: string, n: number) => string;
  /** Extensions in capitals (".PNG"). */
  upperExtensions?: boolean;
  /** CSVs as a Turkish Excel saves them: semicolons, UTF-16 with a BOM, uppercase headers, empty rows. */
  spreadsheet?: boolean;
  /** Files that aren't inputs in the folders: notes, system files. */
  stray?: boolean;
}

const spaced = (stem: string) => stem.toUpperCase().replace(/[-_ ]+/g, " ");
const squashed = (stem: string, n: number) => `${compactKey(stem)}${["", "_final", " (1)", "-v2"][n % 4]}`;

export const VARIANTS: Variant[] = [
  { id: "names", label: "File names in other case and with other separators", rename: spaced, upperExtensions: true },
  { id: "squashed", label: "File names as one word, with copy and version suffixes", rename: squashed },
  { id: "spreadsheet", label: "Data saved by Excel in Turkish: semicolons, UTF-16, uppercase headers, empty rows", spreadsheet: true },
  { id: "stray", label: "Extra files in the folders: notes and system files", stray: true },
  { id: "everything", label: "All of these at once", rename: squashed, upperExtensions: true, spreadsheet: true, stray: true },
];

export function selectVariants(ids: string | undefined): Variant[] {
  if (!ids) return [];
  if (ids === "all") return VARIANTS;
  const wanted = ids.split(",").map((s) => s.trim());
  const unknown = wanted.filter((id) => !VARIANTS.some((v) => v.id === id));
  if (unknown.length) throw new Error(`Unknown variant ${unknown.join(", ")}. Known: ${VARIANTS.map((v) => v.id).join(", ")}, all.`);
  return VARIANTS.filter((v) => wanted.includes(v.id));
}

const DATA = new Set([".csv", ".tsv", ".txt"]);
const quote = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A CSV as a Turkish Excel saves it: same values, semicolons, uppercase headers, a blank row, UTF-16 with a BOM. */
export async function spreadsheetCopy(from: string, to: string) {
  const table = await readDataFile(from);
  const lines = [table.columns.map((c) => quote(c.toUpperCase())).join(";"), ...table.rows.map((r) => table.columns.map((c) => quote(r[c])).join(";"))];
  // A blank row after the first one, as people leave them.
  lines.splice(Math.min(2, lines.length), 0, "");
  await fs.writeFile(to, Buffer.from(`﻿${lines.join("\r\n")}\r\n\r\n`, "utf16le"));
}

/** A file's new name in this variant (the n-th in its folder). */
function renamed(variant: Variant, name: string, n: number) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  if (DATA.has(ext.toLowerCase())) return name;
  return `${variant.rename ? variant.rename(stem, n) : stem}${variant.upperExtensions ? ext.toUpperCase() : ext}`;
}

/** Copies a file, as this variant changes it. */
async function copyFile(variant: Variant, from: string, to: string) {
  if (variant.spreadsheet && [".csv", ".tsv"].includes(path.extname(from).toLowerCase())) await spreadsheetCopy(from, to);
  else await fs.copyFile(from, to);
}

/**
 * Writes this variant of the attachments into a folder and returns where each one is now: folders keep their name
 * (their files renamed, plus stray ones), files are copied (renamed unless they hold data).
 */
export async function makeVariant(variant: Variant, attachments: Record<string, { path: string; isFolder: boolean }>, outDir: string) {
  await fs.mkdir(outDir, { recursive: true });
  const out: Record<string, { path: string; isFolder: boolean; files: string[] }> = {};
  for (const [name, a] of Object.entries(attachments)) {
    if (a.isFolder) {
      const folder = path.join(outDir, path.basename(a.path));
      await fs.mkdir(folder, { recursive: true });
      const files: string[] = [];
      for (const [n, f] of (await listFolderFiles(a.path)).entries()) {
        const target = path.join(folder, renamed(variant, f.name, n));
        await copyFile(variant, f.path, target);
        files.push(target);
      }
      if (variant.stray) {
        await fs.writeFile(path.join(folder, "notes.txt"), "Shoot again on Friday.\n");
        await fs.writeFile(path.join(folder, ".DS_Store"), "");
        await fs.writeFile(path.join(folder, "Thumbs.db"), "");
      }
      out[name] = { path: folder, isFolder: true, files };
    } else {
      const target = path.join(outDir, renamed(variant, path.basename(a.path), 0));
      await copyFile(variant, a.path, target);
      out[name] = { path: target, isFolder: false, files: [target] };
    }
  }
  return out;
}

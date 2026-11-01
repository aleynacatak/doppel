import fs from "node:fs/promises";
import path from "node:path";
import type { Storage } from "./storage";

const isFolder = async (p: string) => (await fs.stat(p).catch(() => null))?.isDirectory() ?? false;

/** Where a file or folder picker opens: the folder of the last pick, while it's still there. Otherwise macOS chooses. */
export async function pickerStart(storage: Pick<Storage, "getLastFolder">): Promise<string | undefined> {
  const folder = await storage.getLastFolder();
  return folder && (await isFolder(folder)) ? folder : undefined;
}

/** Remembers what was picked: a folder itself, a file by its folder. */
export async function rememberPick(storage: Pick<Storage, "saveLastFolder">, picked: string[]): Promise<void> {
  if (!picked.length) return;
  await storage.saveLastFolder((await isFolder(picked[0])) ? picked[0] : path.dirname(picked[0]));
}

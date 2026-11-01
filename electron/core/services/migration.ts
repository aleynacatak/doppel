import fs from "node:fs/promises";
import path from "node:path";

const MARKER = ".migrated-from-doppel";

/**
 * Earlier builds were called "Doppel" and kept their data in Application Support/Doppel. Copies routines,
 * runs and settings into the Doppl folder once; the old folder stays as it is.
 * Codes, keys and tokens are not copied: they were encrypted under the old name and must be entered again.
 */
export async function migrateDoppelData(appData: string, userData: string): Promise<boolean> {
  const oldDir = path.join(appData, "Doppel");
  if (path.resolve(oldDir) === path.resolve(userData)) return false;
  const exists = (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    );
  if ((await exists(path.join(userData, MARKER))) || (await exists(path.join(userData, "settings.json")))) return false;
  if (!(await exists(path.join(oldDir, "settings.json")))) return false;

  await fs.mkdir(userData, { recursive: true });
  for (const dir of ["routines", "runs"]) {
    const names = await fs.readdir(path.join(oldDir, dir)).catch(() => [] as string[]);
    await fs.mkdir(path.join(userData, dir), { recursive: true });
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      await fs.copyFile(path.join(oldDir, dir, name), path.join(userData, dir, name));
    }
  }
  for (const file of ["settings.json", ".demo-data-removed"]) {
    await fs.copyFile(path.join(oldDir, file), path.join(userData, file)).catch(() => undefined);
  }
  await fs.writeFile(path.join(userData, MARKER), new Date().toISOString());
  return true;
}

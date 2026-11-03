import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeImage } from "electron";
import { INDESIGN_BUNDLE_ID } from "../../adapters/indesign/bridge";
import { PHOTOSHOP_BUNDLE_ID } from "../../adapters/photoshop/bridge";

const ICON_SIZE = 64;
const APPS = [
  { id: "indesign", bundleId: INDESIGN_BUNDLE_ID, folderPrefix: "Adobe InDesign" },
  { id: "photoshop", bundleId: PHOTOSHOP_BUNDLE_ID, folderPrefix: "Adobe Photoshop" },
  { id: "figma", bundleId: "com.figma.Desktop", folderPrefix: "Figma" },
];

/** The copy to show: one in the Applications folder first, then the newest by name (Adobe puts the year in it). */
export function preferredApp(paths: string[]): string | undefined {
  const apps = paths.filter((p) => p.endsWith(".app"));
  const installed = apps.filter((p) => p.startsWith("/Applications/"));
  return (installed.length ? installed : apps).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

/** Where an app is: Spotlight first, then the Applications folder. */
async function findApp(bundleId: string, folderPrefix: string): Promise<string | undefined> {
  const hits = await new Promise<string[]>((resolve) => {
    execFile("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 5000 }, (err, stdout) => resolve(err ? [] : String(stdout).split("\n")));
  });
  const found = preferredApp(hits);
  if (found) return found;
  const entries = await fs.readdir("/Applications").catch(() => [] as string[]);
  return preferredApp(entries.filter((e) => e.startsWith(folderPrefix)).map((e) => (e.endsWith(".app") ? path.join("/Applications", e) : path.join("/Applications", e, `${e}.app`))));
}

async function readIcon(bundleId: string, folderPrefix: string): Promise<string | null> {
  const app = await findApp(bundleId, folderPrefix);
  if (!app) return null;
  // app.getFileIcon gives macOS's generic app icon for these apps; a thumbnail gives their own.
  const image = await nativeImage.createThumbnailFromPath(app, { width: ICON_SIZE, height: ICON_SIZE }).catch(() => null);
  return image && !image.isEmpty() ? image.toDataURL() : null;
}

let icons: Promise<Record<string, string>> | null = null;

/** Logos of the apps installed on this Mac, as data URLs, read once per launch. An app that isn't installed has none. */
export function appIcons(): Promise<Record<string, string>> {
  icons ??= Promise.all(APPS.map(async (a) => [a.id, await readIcon(a.bundleId, a.folderPrefix)] as const)).then((list) =>
    Object.fromEntries(list.filter((entry): entry is readonly [string, string] => !!entry[1])),
  );
  return icons;
}

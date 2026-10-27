import fs from "node:fs/promises";
import path from "node:path";
import type { Routine, Run, Settings, StyleProfile } from "../types";

/**
 * JSON persistence. One file per routine (routines/<id>.json) and per run (runs/<id>.json),
 * so a sync folder can be added later without a migration.
 */
export interface Storage {
  readonly root: string;
  listRoutines(): Promise<Routine[]>;
  getRoutine(id: string): Promise<Routine | null>;
  saveRoutine(routine: Routine): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  saveRun(run: Run): Promise<void>;
  getSettings(): Promise<Settings | null>;
  saveSettings(settings: Settings): Promise<void>;
  getStyleProfile(): Promise<StyleProfile | null>;
  saveStyleProfile(profile: StyleProfile): Promise<void>;
  /** Marker files, e.g. "seeded". */
  hasMarker(name: string): Promise<boolean>;
  setMarker(name: string): Promise<void>;
  /** Removes routines, runs, settings and markers (dev panel "Reset all data"). */
  clear(): Promise<void>;
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class JsonStorage implements Storage {
  constructor(readonly root: string) {}

  private dir(name: string) {
    return path.join(this.root, name);
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.error(`[storage] could not read ${file}:`, err);
      return null;
    }
  }

  private async writeJson(file: string, data: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write to a temp file first so a crash never leaves half a routine on disk.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  private fileFor(kind: "routines" | "runs", id: string) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid id: ${id}`);
    return path.join(this.dir(kind), `${id}.json`);
  }

  async listRoutines(): Promise<Routine[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir("routines"));
    } catch {
      return [];
    }
    const routines = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => this.readJson<Routine>(path.join(this.dir("routines"), n))),
    );
    return routines.filter((r): r is Routine => r !== null);
  }

  getRoutine(id: string) {
    return this.readJson<Routine>(this.fileFor("routines", id));
  }

  saveRoutine(routine: Routine) {
    return this.writeJson(this.fileFor("routines", routine.id), routine);
  }

  getRun(id: string) {
    return this.readJson<Run>(this.fileFor("runs", id));
  }

  saveRun(run: Run) {
    return this.writeJson(this.fileFor("runs", run.id), run);
  }

  getSettings() {
    return this.readJson<Settings>(path.join(this.root, "settings.json"));
  }

  saveSettings(settings: Settings) {
    return this.writeJson(path.join(this.root, "settings.json"), settings);
  }

  getStyleProfile() {
    return this.readJson<StyleProfile>(path.join(this.root, "style-profile.json"));
  }

  saveStyleProfile(profile: StyleProfile) {
    return this.writeJson(path.join(this.root, "style-profile.json"), profile);
  }

  async hasMarker(name: string) {
    try {
      await fs.access(path.join(this.root, `.${name}`));
      return true;
    } catch {
      return false;
    }
  }

  async setMarker(name: string) {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, `.${name}`), new Date().toISOString());
  }

  async clear() {
    for (const name of ["routines", "runs"]) {
      await fs.rm(this.dir(name), { recursive: true, force: true });
    }
    for (const file of ["settings.json", "style-profile.json", ".seeded"]) {
      await fs.rm(path.join(this.root, file), { force: true });
    }
  }
}

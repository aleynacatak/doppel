import fs from "node:fs/promises";
import path from "node:path";
import type { AppId, Flow, InputValue, MatchRule, ParamValue, Routine, Run, Settings, StyleProfile } from "../types";

/** Values picked last time for a routine or flow, on this Mac only (they hold paths). */
export interface LastValues {
  inputs: Record<string, InputValue>;
  outputFolders: Record<string, string>;
  settings: Record<string, ParamValue>;
  matches: Record<string, MatchRule>;
  /** Columns picked per input node, remembered like the rest (see RunRequest.columns). */
  columns?: Record<string, Record<string, string>>;
  documents?: Partial<Record<AppId, string>>;
}

/**
 * JSON persistence. One file per routine (routines/<id>.json), flow (flows/<id>.json) and run (runs/<id>.json),
 * so a sync folder can be added later without a migration. Earlier versions of a routine are kept in
 * routine-versions/<id>/<version>.json, so flows can pin them. Values picked at run time (paths) stay in
 * last-values.json, never in routine or flow files.
 */
export interface Storage {
  readonly root: string;
  listRoutines(): Promise<Routine[]>;
  getRoutine(id: string): Promise<Routine | null>;
  saveRoutine(routine: Routine): Promise<void>;
  deleteRoutine(id: string): Promise<void>;
  /** A routine in one version: the current file, or a kept earlier version. */
  getRoutineVersion(id: string, version: number): Promise<Routine | null>;
  /** Keeps a routine version (before a newer one replaces it). */
  keepRoutineVersion(routine: Routine): Promise<void>;
  listFlows(): Promise<Flow[]>;
  getFlow(id: string): Promise<Flow | null>;
  saveFlow(flow: Flow): Promise<void>;
  deleteFlow(id: string): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  saveRun(run: Run): Promise<void>;
  deleteRun(id: string): Promise<void>;
  /** Last-used values per routine or flow ("routine:<id>", "flow:<id>"). */
  getLastValues(scope: string): Promise<LastValues | null>;
  saveLastValues(scope: string, values: LastValues): Promise<void>;
  getSettings(): Promise<Settings | null>;
  saveSettings(settings: Settings): Promise<void>;
  getStyleProfile(): Promise<StyleProfile | null>;
  saveStyleProfile(profile: StyleProfile): Promise<void>;
  /** Marker files, e.g. "demo-data-removed". */
  hasMarker(name: string): Promise<boolean>;
  setMarker(name: string): Promise<void>;
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
    // Write to a temp file first so a crash never leaves half a routine on disk; its own name per write, so two
    // saves of the same file at once (a run's progress and its fix) don't collide.
    const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  private fileFor(kind: "routines" | "runs" | "flows", id: string) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid id: ${id}`);
    return path.join(this.dir(kind), `${id}.json`);
  }

  private async listDir<T>(kind: "routines" | "flows"): Promise<T[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir(kind));
    } catch {
      return [];
    }
    const items = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.readJson<T>(path.join(this.dir(kind), n))));
    return items.filter((r): r is Awaited<T> => r !== null) as T[];
  }

  listRoutines(): Promise<Routine[]> {
    return this.listDir<Routine>("routines");
  }

  private versionFile(id: string, version: number) {
    if (!SAFE_ID.test(id) || !Number.isInteger(version) || version < 1) throw new Error(`Invalid routine version: ${id} v${version}`);
    return path.join(this.dir("routine-versions"), id, `${version}.json`);
  }

  async getRoutineVersion(id: string, version: number) {
    const current = await this.getRoutine(id);
    if (current?.version === version) return current;
    return this.readJson<Routine>(this.versionFile(id, version));
  }

  keepRoutineVersion(routine: Routine) {
    return this.writeJson(this.versionFile(routine.id, routine.version), { ...routine, runs: [] });
  }

  listFlows(): Promise<Flow[]> {
    return this.listDir<Flow>("flows");
  }

  getFlow(id: string) {
    return this.readJson<Flow>(this.fileFor("flows", id));
  }

  saveFlow(flow: Flow) {
    return this.writeJson(this.fileFor("flows", flow.id), flow);
  }

  async deleteFlow(id: string) {
    await fs.rm(this.fileFor("flows", id), { force: true });
  }

  private lastValuesFile() {
    return path.join(this.root, "last-values.json");
  }

  async getLastValues(scope: string) {
    const all = (await this.readJson<Record<string, LastValues>>(this.lastValuesFile())) ?? {};
    return all[scope] ?? null;
  }

  async saveLastValues(scope: string, values: LastValues) {
    const all = (await this.readJson<Record<string, LastValues>>(this.lastValuesFile())) ?? {};
    all[scope] = values;
    await this.writeJson(this.lastValuesFile(), all);
  }

  getRoutine(id: string) {
    return this.readJson<Routine>(this.fileFor("routines", id));
  }

  saveRoutine(routine: Routine) {
    return this.writeJson(this.fileFor("routines", routine.id), routine);
  }

  async deleteRoutine(id: string) {
    await fs.rm(this.fileFor("routines", id), { force: true });
  }

  getRun(id: string) {
    return this.readJson<Run>(this.fileFor("runs", id));
  }

  async deleteRun(id: string) {
    await fs.rm(this.fileFor("runs", id), { force: true });
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
}

import type { Routine } from "../types";
import { newId, nowIso } from "../util";
import { type StarterService, isStarterId } from "./starterService";
import type { Storage } from "./storage";

/**
 * Routines as the rest of Doppl sees them: mine (in storage, with their earlier versions kept so flows can pin
 * them) and starters (read-only, from the app). Saving a new version keeps the one it replaces.
 */
export class LibraryService {
  constructor(private readonly deps: { storage: Storage; starters: StarterService }) {}

  async list(): Promise<Routine[]> {
    const routines = await this.deps.storage.listRoutines();
    return routines.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listStarters(): Routine[] {
    return this.deps.starters.list();
  }

  /** The newest version of a routine (mine or a starter). */
  async get(id: string): Promise<Routine | null> {
    if (isStarterId(id)) return this.deps.starters.get(id);
    return this.deps.storage.getRoutine(id);
  }

  async require(id: string): Promise<Routine> {
    const routine = await this.get(id);
    if (!routine) throw new Error("This routine doesn't exist anymore.");
    return routine;
  }

  async getVersion(id: string, version: number): Promise<Routine | null> {
    if (isStarterId(id)) return this.deps.starters.getVersion(id, version);
    return this.deps.storage.getRoutineVersion(id, version).catch(() => null);
  }

  /** Saves a routine. When it replaces an earlier version, that version is kept first. */
  async save(routine: Routine): Promise<void> {
    if (routine.starter) throw new Error("Starter routines are read-only. Duplicate it to change it.");
    const current = await this.deps.storage.getRoutine(routine.id);
    if (current && current.version !== routine.version) await this.deps.storage.keepRoutineVersion(current);
    await this.deps.storage.saveRoutine(routine);
  }

  /** A new version with an earlier version's content and name; the history stays as it is. */
  async restore(id: string, version: number): Promise<Routine> {
    const current = await this.require(id);
    if (current.starter) throw new Error("Starter routines can't change. Duplicate it first.");
    if (version === current.version) return current;
    const old = await this.getVersion(id, version);
    if (!old) throw new Error(`Version ${version} of this routine isn't there anymore.`);
    const now = nowIso();
    const next = current.version + 1;
    const restored: Routine = {
      ...structuredClone(old),
      id,
      version: next,
      createdWithAiCalls: current.createdWithAiCalls,
      runs: current.runs,
      createdAt: current.createdAt,
      updatedAt: now,
      versions: [...current.versions, { version: next, createdAt: now, aiCalls: 0, note: `Restored version ${version}` }],
    };
    await this.save(restored);
    return restored;
  }

  /** Copies a routine (usually a starter) into my routines. The copy is independent of later starter updates. */
  async duplicate(id: string): Promise<Routine> {
    const source = await this.require(id);
    const now = nowIso();
    const { starter: _starter, ...rest } = source;
    const copy: Routine = {
      ...structuredClone(rest),
      id: newId(),
      name: source.starter ? source.name : `${source.name} (copy)`,
      version: 1,
      createdWithAiCalls: 0,
      runs: [],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, createdAt: now, aiCalls: 0, note: `Copied from “${source.name}” (version ${source.version})` }],
      duplicatedFrom: { routineId: source.id, version: source.version, name: source.name },
      portabilityIssues: undefined,
    };
    await this.deps.storage.saveRoutine(copy);
    return copy;
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import type { Routine } from "../types";
import { findPortabilityIssues } from "./portability";

// Starter routines: made by Doppl and shipped inside the app (resources/starters/*.json), read-only. They run and
// go into flows like any routine; to change one, the designer duplicates it into their own routines. A starter
// tagged "converter" with one input and one output is offered to bridge incompatible edges in flows.

const STARTER_PREFIX = "starter-";

export const isStarterId = (id: string) => id.startsWith(STARTER_PREFIX);

/** A starter as loaded: read-only, without run history, tagged. Null when the file isn't a usable routine. */
function toStarter(raw: Record<string, any>): Routine | null {
  if (!raw || raw.format !== 2 || typeof raw.id !== "string" || typeof raw.name !== "string" || !Number.isInteger(raw.version)) return null;
  if (!Array.isArray(raw.inputs) || !Array.isArray(raw.outputs) || typeof raw.appId !== "string") return null;
  const id = raw.id.startsWith(STARTER_PREFIX) ? raw.id : `${STARTER_PREFIX}${raw.id}`;
  return {
    ...(raw as Routine),
    id,
    settings: Array.isArray(raw.settings) ? raw.settings : [],
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    versions: Array.isArray(raw.versions) ? raw.versions : [],
    requiredFonts: Array.isArray(raw.requiredFonts) ? raw.requiredFonts : [],
    script: typeof raw.script === "string" ? raw.script : "",
    runs: [],
    starter: { tags: Array.isArray(raw.starter?.tags) ? raw.starter.tags.filter((t: unknown) => typeof t === "string") : [] },
  };
}

export class StarterService {
  /** Per starter id: every version found, newest first. */
  private starters = new Map<string, Routine[]>();

  constructor(private readonly dir: string) {}

  /** Reads every starter file (resources/starters/*.json, and one folder level down for older versions). */
  async load(): Promise<void> {
    const found: Routine[] = [];
    const readDir = async (dir: string, depth: number) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth === 0) await readDir(full, 1);
        else if (e.isFile() && e.name.endsWith(".json")) {
          try {
            const starter = toStarter(JSON.parse(await fs.readFile(full, "utf8")));
            if (starter) found.push(starter);
            else console.error(`[starters] ${e.name} isn't a routine in the starter format; skipped.`);
          } catch (err) {
            console.error(`[starters] couldn't read ${e.name}:`, err);
          }
        }
      }
    };
    await readDir(this.dir, 0);
    this.starters.clear();
    for (const s of found) {
      const list = this.starters.get(s.id) ?? [];
      if (!list.some((x) => x.version === s.version)) list.push(s);
      this.starters.set(s.id, list.sort((a, b) => b.version - a.version));
    }
  }

  /** The newest version of each starter. */
  list(): Routine[] {
    return [...this.starters.values()].map((versions) => versions[0]).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Routine | null {
    return this.starters.get(id)?.[0] ?? null;
  }

  getVersion(id: string, version: number): Routine | null {
    return this.starters.get(id)?.find((r) => r.version === version) ?? null;
  }

  /** Starters tagged "converter" with one input and one output. */
  converters(): Routine[] {
    return this.list().filter((r) => r.starter?.tags.includes("converter") && r.inputs.filter((p) => p.type !== "document").length === 1 && r.outputs.length === 1);
  }
}

const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "routine";

const hasPath = (text: string) => findPortabilityIssues(text).length > 0;

/**
 * One of my routines in the starter format: run history, notes about requests, values picked on this Mac and
 * anything that points at a location on this Mac are taken out (what was removed is listed). A routine whose
 * script or actions point at a fixed location can't become a starter; that has to be fixed first.
 */
export function toStarterFile(routine: Routine, options: { converter: boolean }): { starter: Routine; removed: string[] } {
  const removed: string[] = [];
  const body = routine.kind === "actions" ? JSON.stringify(routine.actions ?? []) : routine.script;
  const bodyIssue = findPortabilityIssues(routine.kind === "actions" ? body.replace(/\{\{[^}]*\}\}/g, "") : body)[0];
  if (bodyIssue) throw new Error(`This routine points to a fixed location on this Mac (${bodyIssue.text.trim().slice(0, 80)}). Fix it before exporting it as a starter.`);

  if (routine.runs.length) removed.push(`run history (${routine.runs.length} ${routine.runs.length === 1 ? "run" : "runs"})`);
  if (routine.versions.length) removed.push("version notes (they quote the requests the routine was made from)");
  if (routine.portabilityIssues?.length) removed.push("accepted portability issues");
  if (routine.duplicatedFrom) removed.push("where it was copied from");
  const settings = routine.settings.map((s) => {
    if (typeof s.default === "string" && hasPath(s.default)) {
      removed.push(`the default of “${s.label}” (a location on this Mac)`);
      const { default: _d, ...rest } = s;
      return rest;
    }
    return s;
  });
  const clean = (text: string, what: string) => {
    if (!hasPath(text)) return text;
    removed.push(`a location on this Mac in the ${what}`);
    return text.replace(/(?:\/Users|\/Volumes|\/private|\/var|~)\/[^\s"'`,;)]*/g, "…");
  };
  const now = new Date().toISOString();
  const starter: Routine = {
    id: `${STARTER_PREFIX}${slug(routine.name)}`,
    name: routine.name,
    appId: routine.appId,
    description: clean(routine.description, "description"),
    steps: routine.steps.map((s, i) => ({ id: `step-${i + 1}`, plainLanguage: clean(s.plainLanguage, "steps") })),
    inputs: routine.inputs.map((p) => ({ ...p, ...(p.description ? { description: clean(p.description, "input descriptions") } : {}) })),
    outputs: routine.outputs,
    settings,
    ...(routine.iterate ? { iterate: routine.iterate } : {}),
    ...(routine.matches ? { matches: routine.matches } : {}),
    kind: routine.kind,
    script: routine.script,
    ...(routine.kind === "actions" ? { actions: routine.actions ?? [] } : {}),
    version: 1,
    createdWithAiCalls: 0,
    appVersion: routine.appVersion,
    requiredFonts: routine.requiredFonts,
    runs: [],
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, createdAt: now, aiCalls: 0, note: "Made by Doppl" }],
    modifiesDocument: routine.modifiesDocument,
    qcProfile: routine.qcProfile,
    ...(routine.builtInQc ? { builtInQc: true } : {}),
    ...(routine.keyObjects?.length ? { keyObjects: routine.keyObjects } : {}),
    ...(routine.objectChecks?.length ? { objectChecks: routine.objectChecks } : {}),
    starter: { tags: options.converter ? ["converter"] : [] },
    format: 2,
  };
  return { starter, removed: [...new Set(removed)] };
}

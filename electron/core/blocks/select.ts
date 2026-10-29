import type { HelperDef } from "./types";

// Picking versions out of a list of block definitions (a list may hold several versions of one block).

/** Every block at its first version, in list order: what routines saved before building blocks were pinned run. */
export function firstVersions(defs: HelperDef[]): HelperDef[] {
  const out = new Map<string, HelperDef>();
  for (const d of defs) if (!out.has(d.id) || d.version < out.get(d.id)!.version) out.set(d.id, d);
  return [...out.values()];
}

/** Every block at its newest version, in list order. */
export function latestVersions(defs: HelperDef[]): HelperDef[] {
  const out = new Map<string, HelperDef>();
  for (const d of defs) if (!out.has(d.id) || d.version > out.get(d.id)!.version) out.set(d.id, d);
  return [...out.values()];
}

import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import { parseFigmaLink } from "../../adapters/figma/figmaRest";
import type { CheckResult, StyleProfile, StyleSource } from "../types";
import { errorMessage, newId, nowIso } from "../util";
import type { Storage } from "./storage";

/**
 * Style profile: house-style facts read from past projects (InDesign files through InDesign,
 * Figma files through their links). The rules are the facts, grouped and de-duplicated; they go
 * into the prompt whenever Doppl writes a routine.
 */
export class StyleService {
  constructor(
    private readonly storage: Storage,
    private readonly registry: AdapterRegistry,
  ) {}

  async get(): Promise<StyleProfile> {
    const profile = (await this.storage.getStyleProfile()) ?? { sources: [], rules: [] };
    profile.sources = profile.sources.map((s) => ({ ...s, kind: s.kind ?? "indesign" }));
    return profile;
  }

  private async save(profile: StyleProfile) {
    profile.rules = buildRules(profile.sources);
    await this.storage.saveStyleProfile(profile);
    return profile;
  }

  private async read(kind: StyleSource["kind"], source: string): Promise<StyleSource> {
    const adapter = this.registry.get(kind);
    const base: StyleSource = { id: newId(), kind, name: kind === "indesign" ? path.basename(source) : source, path: source, addedAt: nowIso() };
    try {
      const facts = await adapter.readStyleFacts!(source);
      return { ...base, name: facts.name, facts: facts.facts };
    } catch (err) {
      return { ...base, error: errorMessage(err) };
    }
  }

  async addInDesignFiles(paths: string[]): Promise<StyleProfile> {
    const profile = await this.get();
    for (const p of paths) {
      if (profile.sources.some((s) => s.path === p)) continue;
      profile.sources.push(await this.read("indesign", p));
    }
    return this.save(profile);
  }

  async addFigmaLink(url: string): Promise<CheckResult<StyleProfile>> {
    if (!parseFigmaLink(url)) return { ok: false, error: { code: "invalid_link", message: "That doesn't look like a Figma file link." } };
    const source = await this.read("figma", url.trim());
    if (source.error) return { ok: false, error: { code: "figma", message: source.error } };
    const profile = await this.get();
    profile.sources = [...profile.sources.filter((s) => s.path !== source.path), source];
    return { ok: true, value: await this.save(profile) };
  }

  async removeSource(id: string): Promise<StyleProfile> {
    const profile = await this.get();
    profile.sources = profile.sources.filter((s) => s.id !== id);
    return this.save(profile);
  }
}

/** One rule per fact label; when several projects disagree, the values are listed together. */
function buildRules(sources: StyleSource[]): StyleProfile["rules"] {
  const byLabel = new Map<string, string[]>();
  for (const s of sources) {
    for (const f of s.facts ?? []) {
      const values = byLabel.get(f.label) ?? [];
      if (!values.includes(f.value)) values.push(f.value);
      byLabel.set(f.label, values);
    }
  }
  return [...byLabel.entries()].map(([label, values]) => ({ label, value: values.slice(0, 3).join(" | ") }));
}

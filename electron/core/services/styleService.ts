import path from "node:path";
import type { StyleProfile } from "../types";
import { newId, nowIso } from "../util";
import type { Storage } from "./storage";

// Mock: rules a real model would extract from past projects. "Coming soon" in the UI.
const EXTRACTED_RULES: StyleProfile["rules"] = [
  { label: "Body text", value: "10/14 pt" },
  { label: "Headlines", value: "28/32 pt, sentence case" },
  { label: "Grid", value: "12 columns, 5 mm gutter" },
  { label: "Margins", value: "15 mm, 20 mm inside" },
  { label: "Image resolution", value: "300 ppi for print, 150 ppi for web" },
  { label: "Export naming", value: "client_format_v1" },
];

export class StyleService {
  constructor(private readonly storage: Storage) {}

  async get(): Promise<StyleProfile> {
    return (await this.storage.getStyleProfile()) ?? { sources: [], rules: [] };
  }

  async addSources(paths: string[]): Promise<StyleProfile> {
    const profile = await this.get();
    for (const p of paths) {
      if (profile.sources.some((s) => s.path === p)) continue;
      profile.sources.push({ id: newId(), name: path.basename(p), path: p, addedAt: nowIso() });
    }
    if (profile.sources.length) profile.rules = EXTRACTED_RULES;
    await this.storage.saveStyleProfile(profile);
    return profile;
  }

  async removeSource(id: string): Promise<StyleProfile> {
    const profile = await this.get();
    profile.sources = profile.sources.filter((s) => s.id !== id);
    if (profile.sources.length === 0) profile.rules = [];
    await this.storage.saveStyleProfile(profile);
    return profile;
  }
}

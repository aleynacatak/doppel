import type { Settings } from "../types";
import type { Storage } from "./storage";

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  aiProvider: "doppl-demo",
  monthlySpendLimit: 50,
  ownKeySpend: { month: "", estUsd: 0 },
  scriptTimeoutSec: 120,
  mockFigmaConnected: false,
};

const thisMonth = () => new Date().toISOString().slice(0, 7);

export class SettingsService {
  private settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(private readonly storage: Storage) {}

  async load(): Promise<Settings> {
    const stored = (await this.storage.getSettings()) as Partial<Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    if (this.settings.aiProvider === "local") this.settings.aiProvider = "doppl-demo";
    return this.settings;
  }

  get current(): Settings {
    return this.settings;
  }

  async save(patch: Partial<Settings>): Promise<Settings> {
    const next: Settings = { ...this.settings, ...patch };
    // Muse Glimmer (local) isn't available yet.
    if (next.aiProvider === "local") next.aiProvider = this.settings.aiProvider;
    next.scriptTimeoutSec = Math.min(Math.max(Math.round(next.scriptTimeoutSec) || 120, 10), 3600);
    next.monthlySpendLimit = Math.max(0, Number(next.monthlySpendLimit) || 0);
    this.settings = next;
    await this.storage.saveSettings(next);
    return this.settings;
  }

  /** Own-key spend this month (resets when the month changes). */
  ownKeySpend(): number {
    const s = this.settings.ownKeySpend;
    return s.month === thisMonth() ? s.estUsd : 0;
  }

  async addOwnKeySpend(usd: number) {
    await this.save({ ownKeySpend: { month: thisMonth(), estUsd: this.ownKeySpend() + usd } });
  }
}

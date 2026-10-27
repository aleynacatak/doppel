import type { AppId } from "../core/types";
import type { DesignAppAdapter } from "./types";

/** The adapters Doppl knows about, in display order. Built in core/config.ts. */
export class AdapterRegistry {
  constructor(private readonly adapters: DesignAppAdapter[]) {}

  list(): DesignAppAdapter[] {
    return this.adapters;
  }

  get(appId: AppId): DesignAppAdapter {
    const adapter = this.adapters.find((a) => a.id === appId);
    if (!adapter) throw new Error(`No adapter for app "${appId}"`);
    return adapter;
  }
}

import type { AdapterRegistry } from "../../adapters/registry";
import type { App, AppId, AppStatus } from "../types";
import type { DevFlagsStore } from "../mock/devFlags";

const POLL_MS = 3000;

/** Polls every adapter for its status and reports changes (renderer: onAppStatusChange). */
export class AppStatusService {
  private apps: App[] = [];
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly flags: DevFlagsStore,
    private readonly onChange: (apps: App[]) => void,
  ) {
    flags.onChange(() => void this.refresh());
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Status with the dev panel's forced state applied. */
  async statusOf(appId: AppId): Promise<AppStatus> {
    const forced = this.flags.get().forceStatus[appId];
    if (forced && forced !== "auto") return forced;
    return this.registry.get(appId).getStatus();
  }

  async list(): Promise<App[]> {
    if (this.apps.length === 0) await this.refresh();
    return this.apps;
  }

  async check(appId: AppId): Promise<App> {
    await this.registry.get(appId).connect();
    await this.refresh();
    return this.apps.find((a) => a.id === appId)!;
  }

  async refresh(): Promise<App[]> {
    if (this.polling) return this.apps;
    this.polling = true;
    try {
      const next: App[] = [];
      for (const adapter of this.registry.list()) {
        let status: AppStatus;
        try {
          status = await this.statusOf(adapter.id);
        } catch {
          status = "not-running";
        }
        const version = status === "connected" ? (await adapter.getAppVersion().catch(() => null)) ?? undefined : undefined;
        next.push({
          id: adapter.id,
          name: adapter.name,
          scriptLanguage: adapter.scriptLanguage,
          connection: adapter.connection,
          status,
          version,
        });
      }
      if (JSON.stringify(next) !== JSON.stringify(this.apps)) {
        this.apps = next;
        this.onChange(next);
      }
      return this.apps;
    } finally {
      this.polling = false;
    }
  }
}

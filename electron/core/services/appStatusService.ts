import type { AdapterRegistry } from "../../adapters/registry";
import type { App, AppId, AppStatus } from "../types";

const POLL_MS = 3000;

/** Polls every adapter for its status and reports changes (renderer: onAppStatusChange). */
export class AppStatusService {
  private apps: App[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** The check in progress; callers wait for it instead of getting a stale list. */
  private inflight: Promise<App[]> | null = null;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly onChange: (apps: App[]) => void,
  ) {}

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  statusOf(appId: AppId): Promise<AppStatus> {
    return this.registry.get(appId).getStatus();
  }

  async list(): Promise<App[]> {
    if (this.apps.length === 0) await this.refresh();
    return this.apps;
  }

  async checkApp(appId: AppId): Promise<App> {
    await this.registry.get(appId).connect();
    await this.refresh();
    return this.apps.find((a) => a.id === appId)!;
  }

  refresh(): Promise<App[]> {
    this.inflight ??= this.check().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async check(): Promise<App[]> {
    const next: App[] = [];
    for (const adapter of this.registry.list()) {
      const status: AppStatus = await adapter.getStatus().catch(() => "not-running" as const);
      const version = status === "connected" ? ((await adapter.getAppVersion().catch(() => null)) ?? undefined) : undefined;
      const detail = await adapter.getDetail().catch(() => undefined);
      next.push({ id: adapter.id, name: adapter.name, scriptLanguage: adapter.scriptLanguage, connection: adapter.connection, status, version, detail });
    }
    if (JSON.stringify(next) !== JSON.stringify(this.apps)) {
      this.apps = next;
      this.onChange(next);
    }
    return this.apps;
  }
}

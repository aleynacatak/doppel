import type { AppStatus } from "../../core/types";
import { type AdobeBridge, BridgeError } from "./bridge";

/**
 * Connection state of one Adobe app: installed, running, and whether Doppl may control it (macOS Automation
 * permission). Status checks never launch the app. The first probe triggers macOS's
 * "Doppl wants to control <app>" prompt.
 */
export class AdobeConnection {
  private installed: boolean | null = null;
  private installedCheckedAt = 0;
  /** Set once a script round-trip succeeded since the app started. */
  private probed = false;
  private permissionDenied = false;
  private lastProbeAt = 0;
  version: string | null = null;

  constructor(
    readonly bridge: AdobeBridge,
    /** ExtendScript `function (input) { return { version: app.version }; }` */
    private readonly probeScript: string,
    private readonly timeoutSec: () => number,
  ) {}

  /** Runs a script and keeps the permission state up to date. */
  async call<T>(main: string, input: unknown, timeoutSec = this.timeoutSec(), label?: string): Promise<T> {
    try {
      const data = await this.bridge.runJsx<T>(main, input, timeoutSec, label);
      this.permissionDenied = false;
      this.probed = true;
      return data;
    } catch (err) {
      if (err instanceof BridgeError && err.kind === "permission-denied") this.permissionDenied = true;
      throw err;
    }
  }

  async getStatus(): Promise<AppStatus> {
    const now = Date.now();
    if (this.installed === null || (!this.installed && now - this.installedCheckedAt > 30_000)) {
      this.installed = await this.bridge.isInstalled();
      this.installedCheckedAt = now;
    }
    if (!this.installed) return "not-installed";
    if (!(await this.bridge.isRunning())) {
      this.probed = false;
      this.version = null;
      return "not-running";
    }
    if (this.probed && !this.permissionDenied) return "connected";
    if (this.bridge.isBusy() || now - this.lastProbeAt < (this.permissionDenied ? 10_000 : 2_000)) {
      return this.permissionDenied ? "permission-denied" : "not-running";
    }
    this.lastProbeAt = now;
    try {
      // Long timeout: the first probe waits while macOS shows its permission prompt.
      const info = await this.call<{ version: string }>(this.probeScript, {}, 90, "probe");
      this.version = info.version;
      return "connected";
    } catch (err) {
      if (err instanceof BridgeError && err.kind === "permission-denied") return "permission-denied";
      // Still launching, or busy with a modal dialog.
      return "not-running";
    }
  }

  /** Full version string ("21.6.0.57"), probing the app if needed. */
  async getVersion(): Promise<string | null> {
    if (!this.version && (await this.bridge.isRunning())) {
      try {
        this.version = (await this.call<{ version: string }>(this.probeScript, {}, 20, "probe")).version;
      } catch {
        return null;
      }
    }
    return this.version;
  }

  /** "Check again" on the Connect screen. */
  reset() {
    this.installed = null;
    this.lastProbeAt = 0;
  }
}

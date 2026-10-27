import type { AppStatus } from "../../core/types";
import { type AdobeBridge, BridgeError } from "./bridge";

/** A first probe that hasn't answered after this long is most likely waiting on macOS's permission prompt. */
export const PROMPT_AFTER_MS = 2000;
/** How long a status check waits for a probe before answering, so a normal connect shows "connected" at once. */
const QUICK_ANSWER_MS = 1500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connection state of one Adobe app: installed, running, and whether Doppl may control it (macOS Automation
 * permission). Status checks never launch the app and never wait long: the probe (a tiny script) runs in the
 * background, because the first one waits while macOS asks "Doppl wants to control <app>". Meanwhile the
 * status is "awaiting-permission", and `onChange` fires once the probe answers.
 */
export class AdobeConnection {
  private installed: boolean | null = null;
  private installedCheckedAt = 0;
  /** Set once a script round-trip succeeded since the app started. */
  private probed = false;
  private permissionDenied = false;
  private lastProbeAt = 0;
  private probe: Promise<void> | null = null;
  private probeStartedAt = 0;
  version: string | null = null;

  constructor(
    readonly bridge: AdobeBridge,
    /** ExtendScript `function (input) { return { version: app.version }; }` */
    private readonly probeScript: string,
    private readonly timeoutSec: () => number,
    private readonly options: { onChange?: () => void; promptAfterMs?: number; quickAnswerMs?: number } = {},
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

  /** The status from what is known right now (no waiting). */
  private current(): AppStatus {
    if (this.permissionDenied) return "permission-denied";
    if (this.probed) return "connected";
    if (this.probe && Date.now() - this.probeStartedAt >= (this.options.promptAfterMs ?? PROMPT_AFTER_MS)) return "awaiting-permission";
    return "not-running";
  }

  private startProbe() {
    this.lastProbeAt = this.probeStartedAt = Date.now();
    // Long timeout: the first probe waits while macOS shows its permission prompt.
    this.probe = this.call<{ version: string }>(this.probeScript, {}, 90, "probe")
      .then((info) => {
        this.version = info.version;
      })
      .catch(() => {
        // Still launching, busy with a modal dialog, or not allowed (call() noted that).
      })
      .finally(() => {
        this.probe = null;
        this.lastProbeAt = Date.now();
        this.options.onChange?.();
      });
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
    if (this.probe) return this.current();
    if (this.bridge.isBusy() || now - this.lastProbeAt < (this.permissionDenied ? 10_000 : 2_000)) return this.current();
    this.startProbe();
    await Promise.race([this.probe, wait(this.options.quickAnswerMs ?? QUICK_ANSWER_MS)]);
    return this.current();
  }

  /** Full version string ("21.6.0.57"), probing the app if needed. */
  async getVersion(): Promise<string | null> {
    if (!this.version && this.probed && (await this.bridge.isRunning())) {
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

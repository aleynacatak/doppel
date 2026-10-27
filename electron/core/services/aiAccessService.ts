import type { DevFlagsStore } from "../mock/devFlags";
import type { AiAccess, AiProvider, CheckResult, DemoSession } from "../types";
import {
  AiError,
  type AiTransport,
  CHAT_MODEL,
  DopplDemoTransport,
  META_API_BASE,
  MetaDirectTransport,
  checkMetaKey,
  fetchDemoSession,
} from "./aiTransport";
import { type SecretStore, secretHint } from "./secretStore";
import type { SettingsService } from "./settingsService";

/**
 * Settings → AI access: which provider is used, the (encrypted) access code or own key,
 * and the last known demo quota. Builds the transport the AI service sends requests through.
 */
export class AiAccessService {
  private session: DemoSession | null = null;

  constructor(
    private readonly deps: {
      settings: SettingsService;
      secrets: SecretStore;
      flags: DevFlagsStore;
      /** Demo Worker base URL (build-time setting). */
      workerUrl: string;
      /** Meta API base URL (overridable for local testing). */
      metaApiBase?: string;
    },
  ) {}

  get workerUrl() {
    return this.deps.workerUrl;
  }

  provider(): AiProvider {
    return this.deps.settings.current.aiProvider;
  }

  async describe(): Promise<AiAccess> {
    const { settings, secrets, flags } = this.deps;
    const [code, key] = await Promise.all([secrets.get("accessCode"), secrets.get("metaApiKey")]);
    return {
      provider: this.provider(),
      model: CHAT_MODEL,
      workerUrl: this.deps.workerUrl,
      encryptionAvailable: secrets.available(),
      accessCode: { saved: !!code, hint: secretHint(code) },
      session: code ? this.session : null,
      ownKey: { saved: !!key, hint: secretHint(key) },
      ownKeySpend: { month: new Date().toISOString().slice(0, 7), estUsd: settings.ownKeySpend(), limit: settings.current.monthlySpendLimit },
      mock: flags.get().mockAi,
    };
  }

  async setProvider(provider: AiProvider): Promise<AiAccess> {
    await this.deps.settings.save({ aiProvider: provider });
    return this.describe();
  }

  private fail(err: unknown): CheckResult<AiAccess> {
    if (err instanceof AiError) return { ok: false, error: { code: err.code, message: err.message, action: err.action } };
    return { ok: false, error: { code: "error", message: err instanceof Error ? err.message : String(err) } };
  }

  async saveAccessCode(code: string): Promise<CheckResult<AiAccess>> {
    const value = code.trim().toUpperCase();
    if (!value) return { ok: false, error: { code: "invalid_code", message: "Enter an access code." } };
    try {
      this.session = await fetchDemoSession(this.deps.workerUrl, value);
      await this.deps.secrets.set("accessCode", value);
      await this.deps.settings.save({ aiProvider: "doppl-demo" });
      return { ok: true, value: await this.describe() };
    } catch (err) {
      return this.fail(err);
    }
  }

  async refreshSession(): Promise<CheckResult<AiAccess>> {
    const code = await this.deps.secrets.get("accessCode");
    if (!code) return { ok: false, error: { code: "no_access", message: "No access code saved yet.", action: "settings" } };
    try {
      this.session = await fetchDemoSession(this.deps.workerUrl, code);
      return { ok: true, value: await this.describe() };
    } catch (err) {
      return this.fail(err);
    }
  }

  async clearAccessCode(): Promise<AiAccess> {
    await this.deps.secrets.set("accessCode", null);
    this.session = null;
    return this.describe();
  }

  async saveApiKey(key: string): Promise<CheckResult<AiAccess>> {
    const value = key.trim();
    if (!value) return { ok: false, error: { code: "own_key_invalid", message: "Enter your Meta API key." } };
    try {
      await checkMetaKey(value, this.deps.metaApiBase ?? META_API_BASE);
      await this.deps.secrets.set("metaApiKey", value);
      await this.deps.settings.save({ aiProvider: "meta-api" });
      return { ok: true, value: await this.describe() };
    } catch (err) {
      return this.fail(err);
    }
  }

  async clearApiKey(): Promise<AiAccess> {
    await this.deps.secrets.set("metaApiKey", null);
    return this.describe();
  }

  /** Keeps the cached quota in step with the Worker's response headers. */
  noteQuota(creations: { used: number; max: number }, samImages: { used: number; max: number }) {
    if (this.session) this.session = { ...this.session, creations, samImages, checkedAt: new Date().toISOString() };
  }

  lastSession() {
    return this.session;
  }

  /** The transport for the current provider. Throws a friendly AiError when nothing is set up. */
  async transport(): Promise<AiTransport> {
    const { secrets, settings } = this.deps;
    const provider = this.provider();
    if (provider === "meta-api") {
      if (!(await secrets.get("metaApiKey"))) {
        throw new AiError("no_access", "Add your Meta API key in Settings → AI access.", "settings");
      }
      return new MetaDirectTransport(
        () => secrets.get("metaApiKey"),
        {
          limit: () => settings.current.monthlySpendLimit,
          spent: () => settings.ownKeySpend(),
          add: (usd) => settings.addOwnKeySpend(usd),
        },
        this.deps.metaApiBase ?? META_API_BASE,
      );
    }
    if (provider === "local") throw new AiError("no_access", "Muse Glimmer (local) isn't available yet.", "settings");
    if (!(await secrets.get("accessCode"))) {
      throw new AiError("no_access", "Add a demo access code or your own Meta API key in Settings → AI access.", "settings");
    }
    return new DopplDemoTransport(this.deps.workerUrl, () => secrets.get("accessCode"));
  }
}

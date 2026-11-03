import { net } from "electron";
import { AiGateway, DEFAULT_ROLES, ROLES, type RoleConfig, type Routing, mergeRoles } from "../ai/gateway";
import { DopplDemoProvider, type FetchLike, OpenAICompatibleProvider } from "../ai/providers";
import { type ModelEntry, ModelRegistry, type RegistryData } from "../ai/registry";
import type { AiAccess, AiCustomEndpoint, AiModelSettings, AiModelsInfo, AiProvider, AiRole, AiRoleBinding, CheckResult, DemoSession } from "../types";
import { newId } from "../util";
import { AiError, checkMetaKey, fetchDemoSession } from "./aiTransport";
import { type SecretStore, secretHint } from "./secretStore";
import { type SettingsService, thisMonth } from "./settingsService";

/**
 * Settings → AI access and Advanced → AI models: how Doppl reaches models (the demo Worker with an access code, Meta
 * with the designer's own key, custom OpenAI-compatible endpoints), the keys (encrypted), spend per provider, and
 * which model serves each role. Builds the role router every AI call goes through.
 */
export class AiAccessService {
  private session: DemoSession | null = null;
  /** An eval profile's role overrides, on top of everything else. */
  private evalRoles: Partial<RoleConfig> | undefined;
  readonly gateway: AiGateway;

  constructor(
    private readonly deps: {
      settings: SettingsService;
      secrets: SecretStore;
      /** Demo Worker base URL (build-time setting). */
      workerUrl: string;
      /** Tests: another registry and fetch. */
      registryData?: RegistryData;
      fetch?: FetchLike;
    },
  ) {
    this.gateway = new AiGateway(this.routing());
  }

  get workerUrl() {
    return this.deps.workerUrl;
  }

  provider(): AiProvider {
    return this.deps.settings.current.aiProvider;
  }

  private get models(): AiModelSettings {
    return this.deps.settings.current.aiModels;
  }

  registry(): ModelRegistry {
    return new ModelRegistry(this.deps.registryData, this.models.customEndpoints);
  }

  roles(): RoleConfig {
    return mergeRoles(DEFAULT_ROLES, this.models.roleOverrides as Partial<RoleConfig>, this.evalRoles);
  }

  /** Evals: route roles as the profile says (until cleared). */
  useRoles(roles: Partial<RoleConfig> | undefined) {
    this.evalRoles = roles;
  }

  private fetch(): FetchLike {
    return this.deps.fetch ?? ((url, init) => net.fetch(url, init));
  }

  private routing(): Routing {
    return {
      registry: () => this.registry(),
      roles: () => this.roles(),
      provider: async (model) => this.providerFor(model),
      spend: {
        check: (providerId) => {
          const { settings } = this.deps;
          const meta = providerId === "meta";
          const limit = meta ? settings.current.monthlySpendLimit : (this.models.providerLimits[providerId] ?? 0);
          const spent = meta ? settings.ownKeySpend() : settings.providerSpend(providerId);
          if (limit > 0 && spent >= limit) {
            throw new AiError(
              "spend_limit",
              meta
                ? "You've reached this month's spend limit for your own key. Raise it in Settings → AI access."
                : "You've reached this month's spend limit for this provider. Raise it in Settings → Advanced → AI models.",
              "settings",
            );
          }
        },
        add: (providerId, usd) => (providerId === "meta" ? this.deps.settings.addOwnKeySpend(usd) : this.deps.settings.addProviderSpend(providerId, usd)),
      },
    };
  }

  /** The adapter that reaches a model, by the designer's access. */
  private async providerFor(model: ModelEntry) {
    const registry = this.registry();
    const { secrets } = this.deps;
    const settings = { fetch: this.fetch() };
    const demo = registry.demoFor(model.provider);
    if (demo && this.provider() !== "meta-api") {
      if (!(await secrets.get("accessCode"))) {
        throw new AiError("no_access", "Add a demo access code or your own Meta API key in Settings → AI access.", "settings");
      }
      return { adapter: new DopplDemoProvider(this.deps.workerUrl, () => secrets.get("accessCode"), settings), entry: demo };
    }
    const entry = registry.provider(model.provider);
    if (!entry.baseUrl) throw new AiError("no_access", `Doppl can't reach ${entry.displayName} directly.`, "settings");
    const getKey = entry.id === "meta" ? () => secrets.get("metaApiKey") : () => secrets.get(`provider:${entry.id}`);
    if (entry.id === "meta" && !(await getKey())) throw new AiError("no_access", "Add your Meta API key in Settings → AI access.", "settings");
    return { adapter: new OpenAICompatibleProvider({ id: entry.id, displayName: entry.displayName, baseUrl: entry.baseUrl, segmentPath: entry.segmentPath }, getKey, settings), entry };
  }

  /** Throws a friendly AiError when the models Doppl needs can't be reached (nothing set up yet). */
  async ensureReady(): Promise<void> {
    if (this.provider() === "local") throw new AiError("no_access", "Muse Glimmer (local) isn't available yet.", "settings");
    const registry = this.registry();
    for (const role of ["planner", "coder"] as const) await this.providerFor(registry.model(this.roles()[role].model));
  }

  /** Calls per creation the provider of the creation roles allows (the demo Worker counts them), if it limits them. */
  callLimit(): number | undefined {
    const registry = this.registry();
    const limits = (["planner", "coder", "reviewer"] as const).map((r) => {
      const model = registry.model(this.roles()[r].model);
      return this.provider() !== "meta-api" ? registry.demoFor(model.provider)?.maxCallsPerCreation : undefined;
    });
    const known = limits.filter((l): l is number => typeof l === "number");
    return known.length ? Math.min(...known) : undefined;
  }

  /** What opening the app needs: only whether things are saved, so a Keychain prompt can't hold up the window. */
  async summary(): Promise<AiAccess> {
    const { settings, secrets } = this.deps;
    const [code, key] = await Promise.all([secrets.has("accessCode"), secrets.has("metaApiKey")]);
    return {
      provider: this.provider(),
      model: this.roles().coder.model,
      workerUrl: this.deps.workerUrl,
      encryptionAvailable: true,
      accessCode: { saved: code, hint: null },
      session: code ? this.session : null,
      ownKey: { saved: key, hint: null },
      ownKeySpend: { month: thisMonth(), estUsd: settings.ownKeySpend(), limit: settings.current.monthlySpendLimit },
    };
  }

  async describe(): Promise<AiAccess> {
    const { secrets } = this.deps;
    const summary = await this.summary();
    const [code, key] = await Promise.all([secrets.get("accessCode"), secrets.get("metaApiKey")]);
    return {
      ...summary,
      // Nothing saved means nothing to unlock, and saving says so if encryption is off.
      encryptionAvailable: summary.accessCode.saved || summary.ownKey.saved ? await secrets.available() : true,
      accessCode: { saved: !!code, hint: secretHint(code) },
      session: code ? this.session : null,
      ownKey: { saved: !!key, hint: secretHint(key) },
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
      await checkMetaKey(value);
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

  // ---------- Settings → Advanced → AI models ----------

  async modelsInfo(): Promise<AiModelsInfo> {
    const registry = this.registry();
    const { settings, secrets } = this.deps;
    const defaults = Object.fromEntries(ROLES.map((r) => [r, { ...DEFAULT_ROLES[r] }])) as Record<AiRole, AiRoleBinding>;
    const customEndpoints = await Promise.all(
      this.models.customEndpoints.map(async (c) => {
        const key = await secrets.get(`provider:custom:${c.id}`);
        return { ...c, key: { saved: !!key, hint: secretHint(key) } };
      }),
    );
    const spendProviders = registry.providers.filter((p) => p.kind === "openai-compatible");
    return {
      models: registry.enabled().map((m) => ({
        id: m.id,
        displayName: m.displayName,
        provider: m.provider,
        location: m.location,
        vision: m.capabilities.vision,
        structuredOutput: m.capabilities.structuredOutput,
        segmentation: !!m.capabilities.segmentation,
        reasoningEffort: m.capabilities.reasoningEffort ?? [],
        trainsOnData: m.dataPolicy.trainsOnData,
        experimental: !!m.experimental,
      })),
      defaults,
      overrides: this.models.roleOverrides,
      customEndpoints,
      providerSpend: spendProviders.map((p) => ({
        provider: p.id,
        displayName: p.displayName,
        month: thisMonth(),
        estUsd: p.id === "meta" ? settings.ownKeySpend() : settings.providerSpend(p.id),
        limit: p.id === "meta" ? settings.current.monthlySpendLimit : (this.models.providerLimits[p.id] ?? 0),
      })),
    };
  }

  /** Role overrides: only models the registry knows, never one that trains on data for a role that sees files. */
  async setRoleOverrides(overrides: Partial<Record<AiRole, AiRoleBinding | null>>): Promise<AiModelsInfo> {
    const registry = this.registry();
    const next: Partial<Record<AiRole, AiRoleBinding>> = { ...this.models.roleOverrides };
    for (const role of ROLES) {
      if (!(role in overrides)) continue;
      const b = overrides[role];
      if (!b) {
        delete next[role];
        continue;
      }
      const model = registry.model(b.model);
      if (model.dataPolicy.trainsOnData) throw new Error(`${model.displayName} may train on what it's sent; Doppl doesn't use it for routines.`);
      if (model.backupOnly) throw new Error(`${model.displayName} only takes over when trial runs keep failing; it can't be picked here.`);
      if (role === "segmenter" ? !model.capabilities.segmentation : model.capabilities.segmentation) {
        throw new Error(role === "segmenter" ? `${model.displayName} can't segment images.` : `${model.displayName} only segments images.`);
      }
      if (role === "reviewer" && !model.capabilities.vision) throw new Error(`${model.displayName} can't look at images, so it can't review outputs.`);
      next[role] = { model: b.model, ...(b.reasoningEffort ? { reasoningEffort: b.reasoningEffort } : {}) };
    }
    await this.deps.settings.save({ aiModels: { ...this.models, roleOverrides: next } });
    return this.modelsInfo();
  }

  async saveCustomEndpoint(input: Omit<AiCustomEndpoint, "id"> & { id?: string; key?: string }): Promise<AiModelsInfo> {
    const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error("Enter the endpoint's base URL, like https://openrouter.ai/api/v1.");
    if (!input.model.trim()) throw new Error("Enter the model id the endpoint expects.");
    const id = input.id ?? newId().slice(0, 8);
    const endpoint: AiCustomEndpoint = {
      id,
      displayName: input.displayName.trim() || new URL(baseUrl).host,
      baseUrl,
      model: input.model.trim(),
      structuredOutput: !!input.structuredOutput,
      vision: !!input.vision,
    };
    const list = this.models.customEndpoints.filter((c) => c.id !== id);
    await this.deps.settings.save({ aiModels: { ...this.models, customEndpoints: [...list, endpoint] } });
    if (input.key !== undefined) await this.deps.secrets.set(`provider:custom:${id}`, input.key.trim() || null);
    return this.modelsInfo();
  }

  async removeCustomEndpoint(id: string): Promise<AiModelsInfo> {
    const overrides = Object.fromEntries(Object.entries(this.models.roleOverrides).filter(([, b]) => b?.model !== `custom:${id}`));
    await this.deps.settings.save({ aiModels: { ...this.models, roleOverrides: overrides, customEndpoints: this.models.customEndpoints.filter((c) => c.id !== id) } });
    await this.deps.secrets.set(`provider:custom:${id}`, null);
    return this.modelsInfo();
  }

  async setProviderLimit(provider: string, usd: number): Promise<AiModelsInfo> {
    if (provider === "meta") await this.deps.settings.save({ monthlySpendLimit: Math.max(0, usd) });
    else await this.deps.settings.save({ aiModels: { ...this.models, providerLimits: { ...this.models.providerLimits, [provider]: Math.max(0, usd) } } });
    return this.modelsInfo();
  }

  /** One small request to a custom endpoint: does it answer? */
  async testEndpoint(id: string): Promise<CheckResult<string>> {
    try {
      const model = this.registry().model(`custom:${id}`);
      const { adapter } = await this.providerFor(model);
      const res = await adapter.chat({ model: model.apiModel ?? model.id, messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 400 }, {});
      return { ok: true, value: res.content.trim().slice(0, 80) || "(empty answer)" };
    } catch (err) {
      return { ok: false, error: { code: err instanceof AiError ? err.code : "error", message: err instanceof Error ? err.message : String(err) } };
    }
  }
}

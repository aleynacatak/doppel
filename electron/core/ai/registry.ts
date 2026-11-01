import bundled from "../../ai/models.json";

// The model registry (electron/ai/models.json, bundled and versioned): which models exist, who serves them, what they
// can do, what they cost, their quirks and data policy. Everything model-specific keys off this, never off a model
// name in code. Custom OpenAI-compatible endpoints from Settings → Advanced join it as extra entries.

export type Quirk = "alphabeticalFields";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelEntry {
  id: string;
  provider: string;
  /** The id sent to the provider (default: id). */
  apiModel?: string;
  displayName: string;
  capabilities: {
    tools: boolean;
    structuredOutput: boolean;
    vision: boolean;
    reasoningEffort?: ReasoningEffort[];
    contextWindow: number;
    segmentation?: boolean;
  };
  location: "cloud" | "local";
  pricing?: { inputPerM: number; cachedInputPerM?: number; outputPerM: number; perImage?: number };
  quirks: Quirk[];
  dataPolicy: { trainsOnData: boolean };
  enabled: boolean;
  /** Only takes over when a role's own model keeps failing (see escalation in roles.json): not offered in Settings. */
  backupOnly?: boolean;
  /** Settings → Advanced: an endpoint the designer added. */
  experimental?: boolean;
}

export interface ProviderEntry {
  id: string;
  kind: "openai-compatible" | "doppl-demo";
  displayName: string;
  baseUrl?: string;
  auth?: "bearer";
  /** SAM through the Responses API. */
  segmentPath?: string;
  /** The Doppl demo Worker serves this provider's models. */
  serves?: string;
  maxOutputTokens?: number;
  /** A hard limit on model calls per creation (the demo Worker's). */
  maxCallsPerCreation?: number;
}

export interface CustomEndpoint {
  id: string;
  displayName: string;
  baseUrl: string;
  /** The model id the endpoint expects. */
  model: string;
  structuredOutput: boolean;
  vision: boolean;
}

export interface RegistryData {
  version: number;
  providers: ProviderEntry[];
  models: ModelEntry[];
}

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

export class ModelRegistry {
  readonly providers: ProviderEntry[];
  readonly models: ModelEntry[];

  constructor(data: RegistryData = bundled as RegistryData, custom: CustomEndpoint[] = []) {
    this.providers = [...data.providers];
    this.models = [...data.models];
    for (const c of custom) {
      const id = `custom:${c.id}`;
      this.providers.push({ id, kind: "openai-compatible", displayName: c.displayName, baseUrl: c.baseUrl.replace(/\/$/, ""), auth: "bearer" });
      this.models.push({
        id,
        provider: id,
        apiModel: c.model,
        displayName: `${c.displayName} (${c.model})`,
        capabilities: { tools: false, structuredOutput: c.structuredOutput, vision: c.vision, contextWindow: 128000 },
        location: isLocal(c.baseUrl) ? "local" : "cloud",
        quirks: [],
        dataPolicy: { trainsOnData: false },
        enabled: true,
        experimental: true,
      });
    }
  }

  model(id: string): ModelEntry {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new Error(`No model "${id}" in the model registry.`);
    return m;
  }

  provider(id: string): ProviderEntry {
    const p = this.providers.find((x) => x.id === id);
    if (!p) throw new Error(`No provider "${id}" in the model registry.`);
    return p;
  }

  /** Models that can be picked for a role (enabled ones, plus custom endpoints). */
  enabled(): ModelEntry[] {
    return this.models.filter((m) => m.enabled && !m.backupOnly);
  }

  /** The demo access provider, which serves the given provider's models for designers without their own key. */
  demoFor(providerId: string): ProviderEntry | undefined {
    return this.providers.find((p) => p.kind === "doppl-demo" && p.serves === providerId);
  }
}

/** USD for one call's usage at the model's prices. */
export function costOf(model: ModelEntry, usage: { input: number; cached: number; output: number } | null, images = 0): number {
  const p = model.pricing;
  if (!p) return 0;
  const u = usage ?? { input: 0, cached: 0, output: 0 };
  return (Math.max(0, u.input - u.cached) * p.inputPerM + u.cached * (p.cachedInputPerM ?? p.inputPerM) + u.output * p.outputPerM) / 1e6 + images * (p.perImage ?? 0);
}

// ---------- Field order ----------

/**
 * A schema with some fields first. Models with the "alphabeticalFields" quirk write fields in alphabetical order no
 * matter how the schema lists them, so those fields get a prefix that sorts first ("plan" → "a0_plan", which comes
 * before "action"); other models get them first in the schema. The canonical names stay unprefixed in code: answers
 * are mapped back with `fromModel`.
 */
export function orderFields(schema: Record<string, unknown>, first: string[], quirks: Quirk[]) {
  const props = { ...((schema.properties ?? {}) as Record<string, unknown>) };
  const present = first.filter((f) => f in props);
  const alphabetical = quirks.includes("alphabeticalFields");
  const keyFor = (f: string) => (alphabetical && present.includes(f) ? `a${present.indexOf(f)}_${f}` : f);
  const properties: Record<string, unknown> = {};
  for (const f of present) properties[keyFor(f)] = props[f];
  for (const [k, v] of Object.entries(props)) if (!present.includes(k)) properties[k] = v;
  const required = Array.isArray(schema.required) ? (schema.required as string[]).map(keyFor) : undefined;
  return {
    schema: { ...schema, properties, ...(required ? { required } : {}) },
    /** The name the model sees for a canonical field. */
    keyFor,
    /** An answer with canonical field names. */
    fromModel(json: Record<string, any>): Record<string, any> {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(json)) {
        const canonical = present.find((f) => keyFor(f) === k);
        out[canonical ?? k] = v;
      }
      return out;
    },
  };
}

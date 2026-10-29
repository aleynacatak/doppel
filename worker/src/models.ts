import registry from "../../electron/ai/models.json";

// Which models the demo serves, what they cost and the demo's limits come from the desktop app's model registry
// (electron/ai/models.json), so the app and the Worker never disagree. Only enabled models of the provider the demo
// serves, and never one that trains on request data (the -contributor variants).

interface RegistryModel {
  id: string;
  provider: string;
  capabilities: { segmentation?: boolean };
  pricing?: { inputPerM: number; cachedInputPerM?: number; outputPerM: number; perImage?: number };
  dataPolicy: { trainsOnData: boolean };
  enabled: boolean;
}

interface RegistryProvider {
  id: string;
  kind: string;
  serves?: string;
  maxOutputTokens?: number;
  maxCallsPerCreation?: number;
}

const providers = registry.providers as RegistryProvider[];
const models = registry.models as RegistryModel[];
const demo = providers.find((p) => p.kind === "doppl-demo");
const served = models.filter((m) => m.enabled && m.provider === demo?.serves && !m.dataPolicy.trainsOnData);

export const DEMO_LIMITS = {
  maxOutputTokens: demo?.maxOutputTokens ?? 8000,
  maxCallsPerCreation: demo?.maxCallsPerCreation ?? 15,
};

export const CHAT_MODELS = served.filter((m) => !m.capabilities.segmentation).map((m) => m.id);
export const SEGMENT_MODELS = served.filter((m) => m.capabilities.segmentation).map((m) => m.id);

export interface Usage {
  input: number;
  cached: number;
  output: number;
}

/** USD for a chat call at the model's prices. */
export function chatCost(model: string, usage: Usage): number {
  const p = models.find((m) => m.id === model)?.pricing;
  if (!p) return 0;
  const uncached = Math.max(usage.input - usage.cached, 0);
  return (uncached * p.inputPerM + usage.cached * (p.cachedInputPerM ?? p.inputPerM) + usage.output * p.outputPerM) / 1_000_000;
}

/** USD for segmenting images with the model. */
export const segmentCost = (model: string, images: number) => images * (models.find((m) => m.id === model)?.pricing?.perImage ?? 0);

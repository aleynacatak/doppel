import path from "node:path";
import { createFigmaMockAdapter } from "../adapters/figma/figmaMockAdapter";
import { InDesignAdapter } from "../adapters/indesign/indesignAdapter";
import { createIndesignMockAdapter } from "../adapters/indesign/mockIndesignAdapter";
import { AdapterRegistry } from "../adapters/registry";
import { DEFAULT_DEV_FLAGS, DevFlagsStore } from "./mock/devFlags";
import { MockAiService } from "./mock/mockAiService";
import { TEMPLATE_LIBRARY, seedIfNeeded } from "./mock/seed";
import { AiAccessService } from "./services/aiAccessService";
import type { AiService } from "./services/aiService";
import { ModelAiService } from "./services/modelAiService";
import { SecretStore } from "./services/secretStore";
import { switchingAiService } from "./services/switchingAiService";
import { AppStatusService } from "./services/appStatusService";
import { QcService } from "./services/qcService";
import { RoutineService } from "./services/routineService";
import { RoutineExecutor, RunService } from "./services/runService";
import { SettingsService } from "./services/settingsService";
import { JsonStorage, type Storage } from "./services/storage";
import { StyleService } from "./services/styleService";
import type { App, Creation, Run } from "./types";

// THE one place that picks mock vs. real implementations.
//
//   Storage ............ real   (JSON files in userData)
//   InDesign adapter ... real   (AppleScript → ExtendScript). DOPPEL_MOCK_INDESIGN=1 swaps in the mock.
//   Figma adapter ...... mock   (no plugin / WebSocket yet)
//   AI service ......... real   (Muse Spark + SAM 3.1 through the Doppl demo Worker, or the designer's own Meta key).
//                         The dev panel's "Mock AI" (or DOPPEL_MOCK_AI=1) switches to the template-library mock.
//   QC ................. rule level real (through the adapter); object level SAM while creating, mocked otherwise;
//                         visual level by the model
//
// To plug in a real implementation, write a class that implements the same interface
// (AiService, DesignAppAdapter, Storage) and construct it here instead of the mock.

export interface Emitters {
  apps: (apps: App[]) => void;
  run: (run: Run) => void;
  creation: (creation: Creation) => void;
}

export async function createServices(
  paths: { userData: string; temp: string; documents: string },
  emit: Emitters,
  /** Doppl demo Worker base URL (build-time setting). */
  workerUrl: string,
) {
  const { userData, temp: tempRoot } = paths;
  const storage: Storage = new JsonStorage(userData);
  const settings = new SettingsService(storage);
  await settings.load();
  await seedIfNeeded(storage);

  const flags = new DevFlagsStore();

  const indesign =
    process.env.DOPPEL_MOCK_INDESIGN === "1"
      ? createIndesignMockAdapter()
      : new InDesignAdapter({ getTimeoutSec: () => settings.current.scriptTimeoutSec });
  const figma = createFigmaMockAdapter({
    isConnected: () => settings.current.mockFigmaConnected,
    setConnected: async (value) => {
      await settings.save({ mockFigmaConnected: value });
    },
  });
  const registry = new AdapterRegistry([indesign, figma]);

  const secrets = new SecretStore(userData);
  const access = new AiAccessService({
    settings,
    secrets,
    flags,
    workerUrl,
    // Test-only override, e.g. a local fake of Meta's API.
    metaApiBase: process.env.DOPPEL_META_API_BASE,
  });
  const style = new StyleService(storage);
  const realAi = new ModelAiService({ registry, access, style, templates: TEMPLATE_LIBRARY });
  const ai: AiService = switchingAiService(realAi, new MockAiService(TEMPLATE_LIBRARY, flags), flags);
  const qc = new QcService(ai, flags);
  const apps = new AppStatusService(registry, flags, emit.apps);
  const workRoot = path.join(tempRoot, "doppel-work");
  const copiesDir = path.join(paths.documents, "Doppel copies");
  const executor = new RoutineExecutor({ registry, qc, flags, apps, workRoot, copiesDir });
  const runs = new RunService({ storage, executor, registry, qc, flags, access, emit: emit.run });
  const routines = new RoutineService({ storage, registry, ai, access, executor, apps, flags, emit: emit.creation, workRoot });

  /** Dev panel "Reset all data": back to a first launch (seed routines, Connect screen). */
  const reset = async () => {
    await storage.clear();
    await secrets.clear();
    await seedIfNeeded(storage);
    await settings.load();
    flags.set(structuredClone(DEFAULT_DEV_FLAGS));
    await apps.refresh();
  };

  return { storage, settings, flags, registry, apps, runs, routines, style, access, reset };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

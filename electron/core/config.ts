import path from "node:path";
import { FigmaAdapter } from "../adapters/figma/figmaAdapter";
import { FigmaPluginBridge } from "../adapters/figma/pluginBridge";
import { InDesignAdapter } from "../adapters/indesign/indesignAdapter";
import { PhotoshopAdapter } from "../adapters/photoshop/photoshopAdapter";
import { AdapterRegistry } from "../adapters/registry";
import { AiAccessService } from "./services/aiAccessService";
import { AppStatusService } from "./services/appStatusService";
import { FigmaService } from "./services/figmaService";
import { DevService } from "./services/devService";
import { removeLegacyDemoData } from "./services/legacyCleanup";
import { ModelAiService } from "./services/modelAiService";
import { QcService } from "./services/qcService";
import { RoutineService } from "./services/routineService";
import { RoutineExecutor, RunService } from "./services/runService";
import { SecretStore } from "./services/secretStore";
import { SettingsService } from "./services/settingsService";
import { JsonStorage } from "./services/storage";
import { StyleService } from "./services/styleService";
import { StageRunner } from "./stages/stageRunner";
import { EXAMPLE_ROUTINES } from "./templates";
import type { App, Creation, Run } from "./types";

// Builds every service. Everything is real:
//   Storage ........ JSON files in userData; codes, keys and tokens encrypted with the Keychain
//   InDesign ....... AppleScript → ExtendScript on this Mac (shared Adobe bridge, adapters/adobe/)
//   Photoshop ...... the same bridge; stages work on duplicates and never save over the designer's PSD
//   Figma .......... the Doppl plugin (figma-plugin/) runs action lists; files can also be read by link (REST API)
//   AI ............. Muse Spark + SAM 3.1 through the Doppl demo Worker, or the designer's own Meta key
//   Checks ......... each app's own checks (InDesign preflight, Figma frame checks); visual review by the model

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
  const storage = new JsonStorage(paths.userData);
  await removeLegacyDemoData(storage);
  const settings = new SettingsService(storage);
  await settings.load();
  const secrets = new SecretStore(paths.userData);

  const bridge = new FigmaPluginBridge(
    () => settings.current.figmaPairingCode,
    () => settings.current.figmaPort,
  );
  // Adobe apps report when a background probe answers (e.g. after the macOS permission prompt); set below.
  let refreshApps = () => {};
  const indesign = new InDesignAdapter({ getTimeoutSec: () => settings.current.scriptTimeoutSec, onStatusChange: () => refreshApps() });
  const figma = new FigmaAdapter({
    getToken: () => secrets.get("figmaToken"),
    getFiles: () => settings.current.figmaFiles,
    bridge,
    getTimeoutSec: () => settings.current.scriptTimeoutSec,
  });
  const photoshop = new PhotoshopAdapter({ getTimeoutSec: () => settings.current.scriptTimeoutSec, onStatusChange: () => refreshApps() });
  const registry = new AdapterRegistry([indesign, photoshop, figma]);

  const access = new AiAccessService({ settings, secrets, workerUrl });
  const style = new StyleService(storage, registry);
  const ai = new ModelAiService({ registry, access, style, templates: EXAMPLE_ROUTINES });
  const qc = new QcService(ai);
  const apps = new AppStatusService(registry, emit.apps);
  refreshApps = () => void apps.refresh();
  const figmaSetup = new FigmaService({ settings, secrets, bridge, userData: paths.userData, onChange: () => void apps.refresh() });
  await figmaSetup.preparePlugin().catch((err) => console.error("[figma plugin] couldn't prepare the plugin folder:", err));
  bridge.onChange(() => void apps.refresh());

  const workRoot = path.join(paths.temp, "doppl-work");
  const copiesDir = path.join(paths.documents, "Doppl copies");
  const executor = new RoutineExecutor({ registry, qc, apps, workRoot, copiesDir });
  const stageRunner = new StageRunner(registry);
  const runs = new RunService({
    storage,
    executor,
    stageRunner,
    registry,
    apps,
    qc,
    access,
    emit: emit.run,
    runsDir: path.join(paths.userData, "runs"),
    copiesDir,
  });
  const routines = new RoutineService({
    storage,
    registry,
    ai,
    access,
    executor,
    stageRunner,
    qc,
    getStyle: () => style.get(),
    apps,
    emit: emit.creation,
    workRoot,
  });

  const dev = new DevService({ registry, storage, validate: (draft) => routines.validate(draft) });

  return { storage, settings, registry, apps, runs, routines, style, access, figmaSetup, bridge, dev };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

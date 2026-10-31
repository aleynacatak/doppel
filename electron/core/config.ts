import path from "node:path";
import { FigmaAdapter } from "../adapters/figma/figmaAdapter";
import { FigmaPluginBridge } from "../adapters/figma/pluginBridge";
import { InDesignAdapter } from "../adapters/indesign/indesignAdapter";
import { PhotoshopAdapter } from "../adapters/photoshop/photoshopAdapter";
import { filePreview } from "../adapters/previews";
import { AdapterRegistry } from "../adapters/registry";
import { BlockService } from "./blocks/candidates";
import { AutoFixService } from "./services/autoFixService";
import { blocks } from "./blocks/registry";
import { runHelperTests } from "./blocks/testRunner";
import { newId } from "./util";
import { AiAccessService } from "./services/aiAccessService";
import { AppStatusService } from "./services/appStatusService";
import { FigmaService } from "./services/figmaService";
import { DevService } from "./services/devService";
import { FlowService } from "./services/flowService";
import { removeLegacyDemoData } from "./services/legacyCleanup";
import { LibraryService } from "./services/libraryService";
import { ModelAiService } from "./services/modelAiService";
import { QcService } from "./services/qcService";
import { migrateRoutines } from "./services/routineMigration";
import { RoutineService } from "./services/routineService";
import { RunService } from "./services/runService";
import { SecretStore } from "./services/secretStore";
import { SettingsService } from "./services/settingsService";
import { StarterService } from "./services/starterService";
import { JsonStorage } from "./services/storage";
import { StyleService } from "./services/styleService";
import { EXAMPLE_ROUTINES } from "./templates";
import { simulatedApps } from "./flows/mockAdapters";
import type { App, Creation, Run } from "./types";

// Builds every service. Everything is real:
//   Storage ........ JSON files in userData; codes, keys and tokens encrypted with the Keychain
//   InDesign ....... AppleScript → ExtendScript on this Mac (shared Adobe bridge, adapters/adobe/)
//   Photoshop ...... the same bridge; stages work on duplicates and never save over the designer's PSD
//   Figma .......... the Doppl plugin (figma-plugin/) runs action lists; files can also be read by link (REST API)
//   Routines ....... one app each, with typed inputs and outputs; flows connect them (core/flows/)
//   Starters ....... read-only routines shipped in the app's resources (resources/starters/)
//   AI ............. Muse Spark + SAM 3.1 through the Doppl demo Worker, or the designer's own Meta key
//   Checks ......... each app's own checks (InDesign preflight, Figma frame checks); visual review by the model

export interface Emitters {
  apps: (apps: App[]) => void;
  run: (run: Run) => void;
  creation: (creation: Creation) => void;
  /** A save dialog (dev panel: "Export as starter"). */
  chooseSavePath: (defaultName: string) => Promise<string | null>;
}

export async function createServices(
  paths: { userData: string; temp: string; documents: string; starters: string },
  emit: Emitters,
  /** Doppl demo Worker base URL (build-time setting). */
  workerUrl: string,
) {
  const storage = new JsonStorage(paths.userData);
  // Building blocks: the designer's own (promoted) ones live next to the routines.
  blocks.usePersonalDir(path.join(paths.userData, "helpers"));
  await removeLegacyDemoData(storage);
  const migrated = await migrateRoutines(storage).catch((err) => {
    console.error("[migration] couldn't bring routines to routines and flows:", err);
    return null;
  });
  if (migrated?.backup) console.log(`[migration] ${migrated.routines} routines, ${migrated.flows} flows, ${migrated.runs} runs; originals in ${migrated.backup}`);
  const starters = new StarterService(paths.starters);
  await starters.load();
  const library = new LibraryService({ storage, starters });
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
  // DOPPL_SIMULATE_APPS=1 (development): every app is simulated, so screens can be tried without touching the real ones.
  const realApps = new AdapterRegistry([indesign, photoshop, figma]);
  const registry = process.env.DOPPL_SIMULATE_APPS === "1" ? new AdapterRegistry(simulatedApps(realApps).list()) : realApps;

  const access = new AiAccessService({ settings, secrets, workerUrl });
  const style = new StyleService(storage, registry);
  const ai = new ModelAiService({ gateway: access.gateway });
  const qc = new QcService(ai);
  const apps = new AppStatusService(registry, emit.apps);
  refreshApps = () => void apps.refresh();
  const figmaSetup = new FigmaService({ settings, secrets, bridge, userData: paths.userData, onChange: () => void apps.refresh() });
  await figmaSetup.preparePlugin().catch((err) => console.error("[figma plugin] couldn't prepare the plugin folder:", err));
  bridge.onChange(() => void apps.refresh());

  const workRoot = path.join(paths.temp, "doppl-work");
  const copiesDir = path.join(paths.documents, "Doppl copies");
  const flows = new FlowService({ storage, library, starters, registry });
  // Building block candidates grow from saved routines; evidence comes from runs and feedback (never AI on reruns).
  let blockService: BlockService | null = null;
  // Routines that fail on new files: Doppl offers a fix and makes it when the designer says yes (see AutoFixService).
  let autoFix: AutoFixService | null = null;
  const runs = new RunService({
    storage,
    library,
    flows,
    registry,
    apps,
    qc,
    access,
    emit: emit.run,
    runsDir: path.join(paths.userData, "runs"),
    copiesDir,
    onRunFinished: (run, routineOfNode) => {
      void blockService?.recordRun(run, routineOfNode).catch(() => undefined);
      void autoFix?.consider(run).catch(() => undefined);
    },
    onFeedback: (ids, kind) => void blockService?.noteFeedback(ids, kind).catch(() => undefined),
    // Columns the rules can't find, matched with one small AI call before a run.
    matchColumns: async (input) => {
      await access.ensureReady();
      return ai.matchColumns(input, { onAiCall: () => undefined, isCancelled: () => false, creationId: `columns-${newId()}` });
    },
    // Files for items that found none by name, only when the designer asks; pictures of files whose names say nothing.
    matchFiles: async ({ pictures, ...input }) => {
      await access.ensureReady();
      const seen = await Promise.all((pictures ?? []).map(async (p) => ({ name: p.name, src: (await filePreview(p.path, p.name, 384).catch(() => undefined))?.src })));
      return ai.matchFiles(
        { ...input, pictures: seen.flatMap((p) => (p.src ? [{ name: p.name, src: p.src }] : [])) },
        { onAiCall: () => undefined, isCancelled: () => false, creationId: `files-${newId()}` },
      );
    },
  });
  const routines = new RoutineService({
    storage,
    registry,
    library,
    flows,
    ai,
    access,
    qc,
    getStyle: () => style.get(),
    apps,
    emit: emit.creation,
    workRoot,
    templates: EXAMPLE_ROUTINES,
    onSaved: (routine, info, previous) => void blockService?.capture(routine, info, previous).catch((err) => console.error("[blocks]", err)),
    onFeedback: (ids, kind) => void blockService?.noteFeedback(ids, kind).catch(() => undefined),
  });
  const fixes = new AutoFixService({ routines, runs, library, flows, access });
  autoFix = fixes;
  blockService = new BlockService({
    dir: path.join(paths.userData, "helpers", "candidates"),
    registry: blocks,
    ai,
    lint: (app, code) => registry.get(app).lintScript?.(code) ?? [],
    runTests: (def) => runHelperTests([def], { adapters: registry, registry: blocks, statusOf: (app) => apps.statusOf(app), workRoot: path.join(paths.temp, "doppl-block-tests") }),
    autoPromote: () => settings.current.autoPromoteBlocks,
    aiContext: () => ({ onAiCall: () => undefined, isCancelled: () => false, creationId: newId() }),
  });

  const dev = new DevService({
    registry,
    storage,
    library,
    flows,
    runs,
    validate: (draft) => routines.validate(draft),
    chooseSavePath: emit.chooseSavePath,
  });

  return { storage, settings, registry, apps, runs, routines, library, flows, starters, style, access, figmaSetup, bridge, dev, blocks: blockService, autoFix: fixes };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

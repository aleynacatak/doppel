import path from "node:path";
import { BrowserWindow, type OpenDialogOptions, app, dialog, ipcMain, shell } from "electron";
import { filePreviews } from "../adapters/previews";
import { blocks } from "../core/blocks/registry";
import { runHelperTests } from "../core/blocks/testRunner";
import type { Services } from "../core/config";
import { connectionLog } from "../core/services/connectionLog";
import { errorMessage } from "../core/util";
import type { ApiMethods, IpcResult } from "./api";

type Handlers = { [K in keyof ApiMethods]: (...args: Parameters<ApiMethods[K]>) => ReturnType<ApiMethods[K]> };

async function showOpenDialog(options: OpenDialogOptions) {
  const win = BrowserWindow.getFocusedWindow();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

/** Wires every window.doppel method to a core service. Errors come back as plain-language messages. */
export function registerIpc(s: Services) {
  const handlers: Handlers = {
    // Apps
    listApps: () => s.apps.list(),
    checkApp: (appId) => s.apps.checkApp(appId),
    listOpenDocuments: (appId) => s.registry.get(appId).listOpenDocuments(),
    inspectDocument: (appId, docId) => s.registry.get(appId).inspectDocument(docId),
    openDocument: (appId, docId) => s.registry.get(appId).openInApp(docId),
    openAutomationSettings: async () => {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
    },

    // Figma
    getFigmaSetup: () => s.figmaSetup.describe(),
    saveFigmaToken: (token) => s.figmaSetup.saveToken(token),
    clearFigmaToken: () => s.figmaSetup.clearToken(),
    addFigmaLink: (url) => s.figmaSetup.addLink(url),
    removeFigmaFile: (key) => s.figmaSetup.removeFile(key),
    showFigmaPlugin: async () => s.figmaSetup.showPlugin(),

    // Routine creation
    createRoutine: (input) => s.routines.create(input),
    getCreation: async (id) => s.routines.getCreation(id),
    answerQuestion: (id, questionId, optionId) => s.routines.answer(id, questionId, optionId),
    confirmPlan: (id) => s.routines.confirmPlan(id),
    addSamples: (id, samples) => s.routines.addSamples(id, samples),
    pinFlowNodeVersion: (flowId, nodeId, version) => s.flows.pinVersion(flowId, nodeId, version),
    removeSample: (id, p) => s.routines.removeSample(id, p),
    confirmSamples: (id) => s.routines.confirmSamples(id),
    cancelCreation: (id) => s.routines.cancel(id),
    retryCreation: (id) => s.routines.retry(id),
    continueCreation: (id) => s.routines.continue(id),
    saveRoutine: (id, input) => s.routines.save(id, input),
    discardCreation: (id) => s.routines.discard(id),
    repairRoutine: (routineId, runId) => s.routines.repair(routineId, runId),
    getRefineSetup: (routineId, problem, flowLink) => s.routines.refineSetup(routineId, problem, flowLink),
    refineRoutine: (input) => s.routines.refine(input),
    refineFollowUp: (id, instruction) => s.routines.refineFollowUp(id, instruction),
    makeCompatible: (flowId, edgeId, side) => s.routines.makeCompatible(flowId, edgeId, side),

    // Routines
    listRoutines: () => s.library.list(),
    listStarterRoutines: async () => s.library.listStarters(),
    getRoutine: (id) => s.library.get(id),
    getRoutineVersion: (id, version) => s.library.getVersion(id, version),
    duplicateRoutine: (id) => s.library.duplicate(id),
    restoreRoutineVersion: (id, version) => s.library.restore(id, version),
    getRoutineUsage: (id) => s.flows.usage(id),
    updateFlowsToLatest: (id) => s.flows.updateAll(id),
    checkEnvironment: (id) => s.routines.checkEnvironment(id),
    getSettingOptions: (id, key, docId) => s.routines.getSettingOptions(id, key, docId),

    // Flows
    listFlows: () => s.flows.list(),
    getFlow: (id) => s.flows.get(id),
    createFlow: (name) => s.flows.create(name),
    saveFlow: (flow) => s.flows.save(flow),
    deleteFlow: (id) => s.flows.delete(id),
    getFlowContext: (flow) => s.flows.context(flow),
    previewMatch: (flow, edgeId, rule, inputs) => s.flows.previewMatch(flow, edgeId, rule, inputs),
    converterOptions: (flow, edgeId) => s.flows.converterOptions(flow, edgeId),
    insertConverter: (flow, edgeId, routineId) => s.flows.insertConverter(flow, edgeId, routineId),

    // Runs
    getRunSetup: (target) => s.runs.setup(target),
    rememberInputs: (target, inputs) => s.runs.rememberInputs(target, inputs),
    checkReadiness: (target, documents) => s.runs.readiness(target, documents ?? {}),
    preflightRun: (target, request) => s.runs.preflight(target, request),
    suggestPartners: (target, request, ids) => s.runs.suggestPartners(target, request, ids),
    previewFiles: (paths) => filePreviews(paths),
    startRun: (target, request) => s.runs.start(target, request),
    cancelRun: (id) => s.runs.cancel(id),
    getRun: (id) => s.runs.get(id),
    retryFailed: (id) => s.runs.retryFailed(id),
    answerRunFix: async (id, answer) => {
      // A fix takes a while: the run's screen follows it.
      if (answer === "fix") void s.autoFix.start(id).catch((err) => console.error("[fix]", err));
      else await (answer === "keep" ? s.autoFix.keep(id) : s.autoFix.dismiss(id));
    },
    markOutputOk: (runId, outputId) => s.runs.markOutputOk(runId, outputId),
    openOutput: (runId, outputId) => s.runs.openOutput(runId, outputId),
    revealOutput: (runId, outputId) => s.runs.revealOutput(runId, outputId),

    // Native pickers
    pickFiles: (options = {}) => {
      const properties: OpenDialogOptions["properties"] = ["openFile"];
      if (options.multiple) properties.push("multiSelections");
      if (options.allowFolders) properties.push("openDirectory");
      return showOpenDialog({
        properties,
        filters: options.extensions?.length ? [{ name: options.extensions.join(", "), extensions: options.extensions }] : undefined,
      });
    },
    pickFolder: async () => (await showOpenDialog({ properties: ["openDirectory", "createDirectory"] }))[0] ?? null,

    // Style profile
    getStyleProfile: () => s.style.get(),
    addStyleSources: async () => {
      const paths = await showOpenDialog({
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "InDesign documents", extensions: ["indd"] }],
      });
      return paths.length ? s.style.addInDesignFiles(paths) : s.style.get();
    },
    addStyleFigmaLink: (url) => s.style.addFigmaLink(url),
    removeStyleSource: (id) => s.style.removeSource(id),

    // Settings
    getSettings: async () => s.settings.current,
    saveSettings: async (patch) => {
      const port = s.settings.current.figmaPort;
      const next = await s.settings.save(patch);
      if (next.figmaPort !== port) await s.figmaSetup.portChanged();
      void s.apps.refresh();
      return next;
    },

    // AI access
    getAiAccess: () => s.access.describe(),
    setAiProvider: (provider) => s.access.setProvider(provider),
    saveAccessCode: (code) => s.access.saveAccessCode(code),
    refreshDemoSession: () => s.access.refreshSession(),
    clearAccessCode: () => s.access.clearAccessCode(),
    saveApiKey: (key) => s.access.saveApiKey(key),
    clearApiKey: () => s.access.clearApiKey(),
    listBlocks: async () =>
      blocks.latest().map((d) => ({ id: d.id, app: d.app, set: d.set, call: d.call, summary: d.summary, source: d.source, version: d.version, versions: blocks.versions(d.id), tests: d.tests.length })),
    getBlockUpdates: async (routineId) => {
      const routine = await s.library.require(routineId);
      return blocks.updates(routine.appId, routine.helpers);
    },
    getAdoptableBlocks: async (routineId) => s.blocks.adoptable(await s.library.require(routineId)),
    updateRoutineBlocks: (routineId) => s.routines.updateBlocks(routineId),
    runBlockTests: (ids) =>
      runHelperTests(ids?.length ? ids.map((id) => blocks.get(id)).filter((d): d is NonNullable<typeof d> => !!d) : blocks.latest(), {
        adapters: s.registry,
        registry: blocks,
        statusOf: (app) => s.apps.statusOf(app),
        workRoot: path.join(app.getPath("temp"), "doppl-block-tests"),
      }),
    listBlockCandidates: () => s.blocks.list(),
    generalizeBlockCandidate: (id) => s.blocks.generalize(id),
    approveBlockCandidate: (id) => s.blocks.approve(id),
    dismissBlockCandidate: (id) => s.blocks.dismiss(id),
    exportBlockCandidate: async (id) => {
      const defaultPath = app.isPackaged ? path.join(app.getPath("desktop"), "exported.json") : path.join(app.getAppPath(), "electron", "helpers", "exported.json");
      const win = BrowserWindow.getFocusedWindow();
      const res = win ? await dialog.showSaveDialog(win, { defaultPath }) : await dialog.showSaveDialog({ defaultPath });
      return res.canceled || !res.filePath ? null : s.blocks.exportBuiltin(id, res.filePath);
    },
    getAiModels: () => s.access.modelsInfo(),
    setAiRoleOverrides: (overrides) => s.access.setRoleOverrides(overrides),
    saveAiEndpoint: (input) => s.access.saveCustomEndpoint(input),
    removeAiEndpoint: (id) => s.access.removeCustomEndpoint(id),
    setAiProviderLimit: (provider, usd) => s.access.setProviderLimit(provider, usd),
    testAiEndpoint: (id) => s.access.testEndpoint(id),

    // Dev panel
    devRunFigmaActions: (documentId, actionsJson, itemJson) => s.dev.runFigmaActions(documentId, actionsJson, itemJson),
    devRunPhotoshopScript: (documentId, script) => s.dev.runPhotoshopScript(documentId, script),
    devBarcode: async (type, value) => s.dev.barcode(type, value),
    devValidateRoutine: async (json) => s.dev.validateRoutine(json),
    devSaveRoutine: (json) => s.dev.saveRoutine(json),
    getConnectionLog: async () => connectionLog.list(),
    devLastCreationTranscript: async () => s.routines.lastTranscript(),
    clearConnectionLog: async () => connectionLog.clear(),
    devRunFlow: (flowId, request, options) => s.dev.runFlow(flowId, request, options),
    devExecutionPlan: (flowId, inputs) => s.dev.executionPlan(flowId, inputs),
    devExportStarter: (routineId, options) => s.dev.exportStarter(routineId, options),

  };

  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`doppel:${name}`, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      try {
        return { ok: true, data: await (fn as (...a: unknown[]) => unknown)(...args) };
      } catch (err) {
        console.error(`[ipc] ${name} failed:`, err);
        return { ok: false, error: errorMessage(err) };
      }
    });
  }
}

import { BrowserWindow, type OpenDialogOptions, dialog, ipcMain, shell } from "electron";
import type { Services } from "../core/config";
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
    checkApp: (appId) => s.apps.check(appId),
    listOpenDocuments: (appId) => s.registry.get(appId).listOpenDocuments(),
    inspectDocument: (appId, docId) => s.registry.get(appId).inspectDocument(docId),
    openAutomationSettings: async () => {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
    },

    // Routine creation
    createRoutine: (input) => s.routines.create(input),
    getCreation: async (id) => s.routines.getCreation(id),
    answerQuestion: (id, questionId, optionId) => s.routines.answer(id, questionId, optionId),
    cancelCreation: (id) => s.routines.cancel(id),
    retryCreation: (id) => s.routines.retry(id),
    saveRoutine: (id, input) => s.routines.save(id, input),
    discardCreation: (id) => s.routines.discard(id),
    repairRoutine: (routineId, runId) => s.routines.repair(routineId, runId),

    // Routines
    listRoutines: () => s.routines.list(),
    getRoutine: (id) => s.routines.get(id),
    checkEnvironment: (id) => s.routines.checkEnvironment(id),
    getParamOptions: (id, key) => s.routines.getParamOptions(id, key),

    // Runs
    runRoutine: (id, params, qcMode, options) => s.runs.start(id, params, qcMode, options),
    cancelRun: (id) => s.runs.cancel(id),
    getRun: (id) => s.runs.get(id),
    retryFailed: (id) => s.runs.retryFailed(id),
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
        properties: ["openFile", "openDirectory", "multiSelections"],
        filters: [{ name: "Design files", extensions: ["indd", "idml", "fig", "pdf"] }],
      });
      return paths.length ? s.style.addSources(paths) : s.style.get();
    },
    removeStyleSource: (id) => s.style.removeSource(id),

    // Settings
    getSettings: async () => s.settings.current,
    saveSettings: async (patch) => {
      const next = await s.settings.save(patch);
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

    // Dev panel
    getDevFlags: async () => s.flags.get(),
    setDevFlags: async (patch) => s.flags.set(patch),
    resetData: () => s.reset(),
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

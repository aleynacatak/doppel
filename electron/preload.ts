import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DoppelApi } from "./core/types";
import type { ApiMethods, IpcResult } from "./ipc/api";

// Sandboxed preload: it can only require "electron", so channel names are repeated here
// (they must match ipc/api.ts and ipc/handlers.ts). The Record type makes TypeScript
// complain if a method of DoppelApi is missing.
const METHODS: Record<keyof ApiMethods, true> = {
  listApps: true,
  checkApp: true,
  listOpenDocuments: true,
  inspectDocument: true,
  openDocument: true,
  openAutomationSettings: true,
  getFigmaSetup: true,
  saveFigmaToken: true,
  clearFigmaToken: true,
  addFigmaLink: true,
  removeFigmaFile: true,
  showFigmaPlugin: true,
  createRoutine: true,
  getCreation: true,
  answerQuestion: true,
  cancelCreation: true,
  retryCreation: true,
  continueCreation: true,
  saveRoutine: true,
  discardCreation: true,
  repairRoutine: true,
  listRoutines: true,
  getRoutine: true,
  checkEnvironment: true,
  checkReadiness: true,
  getParamOptions: true,
  runRoutine: true,
  cancelRun: true,
  getRun: true,
  retryFailed: true,
  markOutputOk: true,
  openOutput: true,
  revealOutput: true,
  pickFiles: true,
  pickFolder: true,
  getStyleProfile: true,
  addStyleSources: true,
  addStyleFigmaLink: true,
  removeStyleSource: true,
  getSettings: true,
  saveSettings: true,
  getAiAccess: true,
  setAiProvider: true,
  saveAccessCode: true,
  refreshDemoSession: true,
  clearAccessCode: true,
  saveApiKey: true,
  clearApiKey: true,
  devRunFigmaActions: true,
  devRunPhotoshopScript: true,
  devBarcode: true,
  devValidateRoutine: true,
  devSaveRoutine: true,
  getConnectionLog: true,
  devLastCreationTranscript: true,
  clearConnectionLog: true,
};

const api: Record<string, unknown> = {};
for (const name of Object.keys(METHODS)) {
  api[name] = async (...args: unknown[]) => {
    const result = (await ipcRenderer.invoke(`doppel:${name}`, ...args)) as IpcResult<unknown>;
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
}

function subscribe<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

api.onCreationProgress = (cb: Parameters<DoppelApi["onCreationProgress"]>[0]) => subscribe("doppel:event:creation", cb);
api.onRunProgress = (cb: Parameters<DoppelApi["onRunProgress"]>[0]) => subscribe("doppel:event:run", cb);
api.onAppStatusChange = (cb: Parameters<DoppelApi["onAppStatusChange"]>[0]) => subscribe("doppel:event:apps", cb);
api.onConnectionLog = (cb: Parameters<DoppelApi["onConnectionLog"]>[0]) => subscribe("doppel:event:connection-log", cb);

contextBridge.exposeInMainWorld("doppel", api as unknown as DoppelApi);

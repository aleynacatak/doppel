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
  confirmPlan: true,
  addSamples: true,
  pinFlowNodeVersion: true,
  removeSample: true,
  confirmSamples: true,
  cancelCreation: true,
  retryCreation: true,
  continueCreation: true,
  saveRoutine: true,
  discardCreation: true,
  repairRoutine: true,
  getRefineSetup: true,
  refineRoutine: true,
  refineFollowUp: true,
  makeCompatible: true,
  listRoutines: true,
  listStarterRoutines: true,
  getRoutine: true,
  getRoutineVersion: true,
  duplicateRoutine: true,
  restoreRoutineVersion: true,
  getRoutineUsage: true,
  updateFlowsToLatest: true,
  checkEnvironment: true,
  getSettingOptions: true,
  listFlows: true,
  getFlow: true,
  createFlow: true,
  saveFlow: true,
  deleteFlow: true,
  getFlowContext: true,
  previewMatch: true,
  converterOptions: true,
  insertConverter: true,
  getRunSetup: true,
  rememberInputs: true,
  checkReadiness: true,
  preflightRun: true,
  suggestPartners: true,
  previewFiles: true,
  startRun: true,
  cancelRun: true,
  getRun: true,
  retryFailed: true,
  answerRunFix: true,
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
  listBlocks: true,
  getBlockUpdates: true,
  getAdoptableBlocks: true,
  updateRoutineBlocks: true,
  runBlockTests: true,
  listBlockCandidates: true,
  generalizeBlockCandidate: true,
  approveBlockCandidate: true,
  dismissBlockCandidate: true,
  exportBlockCandidate: true,
  getAiModels: true,
  setAiRoleOverrides: true,
  saveAiEndpoint: true,
  removeAiEndpoint: true,
  setAiProviderLimit: true,
  testAiEndpoint: true,
  devRunFigmaActions: true,
  devRunPhotoshopScript: true,
  devBarcode: true,
  devValidateRoutine: true,
  devSaveRoutine: true,
  getConnectionLog: true,
  devLastCreationTranscript: true,
  clearConnectionLog: true,
  devRunFlow: true,
  devExecutionPlan: true,
  devExportStarter: true,
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

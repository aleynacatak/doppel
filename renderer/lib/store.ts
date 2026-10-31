import type { AiAccess, App, NewTaskInput, Settings } from "@core/types";
import { create } from "zustand";

interface ShellState {
  ready: boolean;
  bridgeMissing: boolean;
  apps: App[];
  settings: Settings | null;
  aiAccess: AiAccess | null;
  setBoot: (data: { settings: Settings; aiAccess: AiAccess }) => void;
  setBridgeMissing: () => void;
  setApps: (apps: App[]) => void;
  setSettings: (settings: Settings) => void;
  setAiAccess: (aiAccess: AiAccess) => void;
  /** A request to change on New task (Doppl declined it as it was), taken by the page when it opens. */
  draftTask: NewTaskInput | null;
  setDraftTask: (task: NewTaskInput | null) => void;
}

export const useShell = create<ShellState>((set) => ({
  ready: false,
  bridgeMissing: false,
  apps: [],
  settings: null,
  aiAccess: null,
  setBoot: ({ settings, aiAccess }) => set({ settings, aiAccess, ready: true }),
  setBridgeMissing: () => set({ bridgeMissing: true, ready: true }),
  setApps: (apps) => set({ apps }),
  setSettings: (settings) => set({ settings }),
  setAiAccess: (aiAccess) => set({ aiAccess }),
  draftTask: null,
  setDraftTask: (draftTask) => set({ draftTask }),
}));

export const useApp = (appId: string | undefined) => useShell((s) => s.apps.find((a) => a.id === appId));

/** Reruns can use AI review only with the own key; the demo Worker is for creating routines. */
export const useAiReviewAvailable = () => useShell((s) => s.aiAccess?.provider === "meta-api");

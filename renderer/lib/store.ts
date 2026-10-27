import type { AiAccess, App, DevFlags, Settings } from "@core/types";
import { create } from "zustand";

interface ShellState {
  ready: boolean;
  bridgeMissing: boolean;
  apps: App[];
  settings: Settings | null;
  aiAccess: AiAccess | null;
  devFlags: DevFlags | null;
  /** Bumped when dev flags change, so screens can reload their data. */
  flagsVersion: number;
  devPanelOpen: boolean;
  setBoot: (data: { apps: App[]; settings: Settings; devFlags: DevFlags; aiAccess: AiAccess }) => void;
  setBridgeMissing: () => void;
  setApps: (apps: App[]) => void;
  setSettings: (settings: Settings) => void;
  setAiAccess: (aiAccess: AiAccess) => void;
  setDevFlags: (flags: DevFlags) => void;
  toggleDevPanel: () => void;
}

export const useShell = create<ShellState>((set) => ({
  ready: false,
  bridgeMissing: false,
  apps: [],
  settings: null,
  aiAccess: null,
  devFlags: null,
  flagsVersion: 0,
  devPanelOpen: false,
  setBoot: ({ apps, settings, devFlags, aiAccess }) => set({ apps, settings, devFlags, aiAccess, ready: true }),
  setBridgeMissing: () => set({ bridgeMissing: true, ready: true }),
  setApps: (apps) => set({ apps }),
  setSettings: (settings) => set({ settings }),
  setAiAccess: (aiAccess) => set({ aiAccess }),
  setDevFlags: (devFlags) => set((s) => ({ devFlags, flagsVersion: s.flagsVersion + 1 })),
  toggleDevPanel: () => set((s) => ({ devPanelOpen: !s.devPanelOpen })),
}));

export const useApp = (appId: string | undefined) => useShell((s) => s.apps.find((a) => a.id === appId));

/** Reruns can use AI review only with the own key (or the mock); the demo Worker is for creating routines. */
export const useAiReviewAvailable = () =>
  useShell((s) => !!s.aiAccess && (s.aiAccess.mock || s.aiAccess.provider === "meta-api"));

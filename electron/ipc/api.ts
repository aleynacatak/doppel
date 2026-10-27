import type { DoppelApi } from "../core/types";

/** Request/response methods of window.doppel (everything except event subscriptions). */
export type ApiMethods = Omit<DoppelApi, "onCreationProgress" | "onRunProgress" | "onAppStatusChange">;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const EVENT_CHANNELS = {
  creation: "doppel:event:creation",
  run: "doppel:event:run",
  apps: "doppel:event:apps",
} as const;

import type { DoppelApi } from "@core/types";

declare global {
  interface Window {
    doppel?: DoppelApi;
  }
}

/** True when the UI runs inside the Doppel app (the preload exposed window.doppel). */
export const hasBridge = () => typeof window !== "undefined" && !!window.doppel;

/** The typed API to the main process. The renderer has no Node.js access; everything goes through here. */
export function doppel(): DoppelApi {
  if (!hasBridge()) throw new Error("Doppel's bridge isn't available. Open this UI inside the Doppel app.");
  return window.doppel!;
}

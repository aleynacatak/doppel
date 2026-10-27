import type { DevFlags } from "../types";

export const DEFAULT_DEV_FLAGS: DevFlags = {
  emptyLibrary: false,
  forceStatus: { indesign: "auto", figma: "auto" },
  creationOutcome: "auto",
  runOutcome: "auto",
  qcOutcome: "default",
  envMismatch: false,
  speed: 1,
  mockAi: process.env.DOPPEL_MOCK_AI === "1",
};

/** Dev panel switches (Shift+D). In memory only: a restart returns to normal behavior. */
export class DevFlagsStore {
  private flags: DevFlags = structuredClone(DEFAULT_DEV_FLAGS);
  private listeners = new Set<(flags: DevFlags) => void>();

  get(): DevFlags {
    return this.flags;
  }

  set(patch: Partial<DevFlags>): DevFlags {
    this.flags = {
      ...this.flags,
      ...patch,
      forceStatus: { ...this.flags.forceStatus, ...(patch.forceStatus ?? {}) },
    };
    for (const l of this.listeners) l(this.flags);
    return this.flags;
  }

  onChange(listener: (flags: DevFlags) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

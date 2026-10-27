import type { ConnectionLogEntry } from "../types";

const MAX_ENTRIES = 300;

/**
 * Metadata about traffic with the design apps (AppleScript calls, Figma plugin messages) for the dev panel.
 * Never holds file contents, scripts, params or message bodies: only what, where, how big, how long.
 */
class ConnectionLog {
  private entries: ConnectionLogEntry[] = [];
  private listeners = new Set<(entry: ConnectionLogEntry) => void>();
  private seq = 0;

  add(entry: Omit<ConnectionLogEntry, "id" | "at">) {
    const full: ConnectionLogEntry = { id: ++this.seq, at: new Date().toISOString(), ...entry };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    for (const listener of this.listeners) listener(full);
  }

  list(): ConnectionLogEntry[] {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }

  onEntry(listener: (entry: ConnectionLogEntry) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const connectionLog = new ConnectionLog();

import type { FailureCause } from "../types";

// Why an item failed, for deciding who fixes it: the designer's files, the routine (the AI can fix it), or the app.

const APP = /not connected|isn't connected|isn't running|is not running|start the doppl plugin|plugin isn't|no document is open|document (was |is )?closed|couldn't reach|isn't open/i;
/** Messages apps give for files they can't open: a damaged file, a format they don't read. */
const FILES = /cannot parse the file|not compatible with this version|corrupt|damaged|unsupported (file )?format|isn't a valid (image|file)|is not a valid (image|file)/i;

/** Problems found before the item ran (no partner, an empty value, a format) are the files'; for the rest, the message decides. */
export function failureCause(error: string | undefined, beforeRunning: boolean): FailureCause {
  if (beforeRunning) return "files";
  const e = error ?? "";
  if (APP.test(e)) return "app";
  if (FILES.test(e)) return "files";
  return "routine";
}

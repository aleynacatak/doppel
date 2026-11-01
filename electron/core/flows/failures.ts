import type { FailureCause } from "../types";

// Why an item failed, for deciding who fixes it: the designer's files, the routine (the AI can fix it), or the app.

const APP = /not connected|isn't connected|isn't running|is not running|start the doppl plugin|plugin isn't|plugin in figma was closed|no document is open|document (was |is )?closed|couldn't reach|isn't open|open a document in|didn't finish within|took too long to answer/i;
/** Messages apps give for files they can't open: a damaged file, a format they don't read. */
const FILES = /cannot parse the file|not compatible with this version|corrupt|damaged|unsupported (file )?format|isn't a valid (image|file)|is not a valid (image|file)|open options are incorrect|isn't a readable|couldn't find a subject/i;
/** The designer's Figma file no longer has what the routine was made on: a page, or a layer on the page (renamed, removed). */
const DOCUMENT = /no layer named "[^"]*" on page|no layer "[^"]*" on page|no page named/i;
/** A value in the designer's data that can't be used as it is: a barcode with a typo, an empty barcode. */
const DATA = /check the number for a typo|barcode value is empty|barcode can only contain|barcode needs \d+ or \d+ digits|barcodes can only contain/i;

/** Problems found before the item ran (no partner, an empty value, a format) are the files'; for the rest, the message decides. */
export function failureCause(error: string | undefined, beforeRunning: boolean): FailureCause {
  if (beforeRunning) return "files";
  const e = error ?? "";
  if (APP.test(e)) return "app";
  if (FILES.test(e) || DATA.test(e) || DOCUMENT.test(e)) return "files";
  return "routine";
}

/** Raw errors apps and the system give, and what the designer reads instead. `$app` is the app's name. */
const PLAIN: [RegExp, string][] = [
  [/net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network (connection was lost|error)/i, "The connection dropped while Doppl was working. Check the internet connection and run it again."],
  [/open options are incorrect|cannot parse the file|file-format module|not the right kind of document|could not open .* because/i, "$app couldn't open this file: it may be damaged, or not the kind of file its name says."],
  [/EACCES|EPERM|operation not permitted|permission denied/i, "macOS didn't let Doppl open or save a file there. Choose another folder, or allow Doppl under System Settings › Privacy & Security › Files and Folders."],
  [/ENOSPC|no space left/i, "The disk is full. Free some space and run it again."],
  [/ENOENT|no such file or directory/i, "A file or folder Doppl needed isn't there anymore: it may have been moved or renamed."],
  [/general photoshop error|is not a function|is not an object|undefined is not|null is not|is not defined|object is invalid|illegal argument|invalid object|is not a constructor|cannot read propert|^Error \d{3,}/i, "The routine ran into a problem inside $app."],
];

/**
 * What the designer reads for an error, with the raw text kept as `errorDetail` (shown under "Details", and what the AI
 * gets when it fixes a routine). Doppl's own messages stay as they are; a Figma action's "Action 3 (setText): " prefix
 * and a script's "(script line 12)" go to the details.
 */
export function plainError(raw: string | undefined, app = "The app"): { error?: string; errorDetail?: string } {
  if (!raw) return {};
  const stripped = raw.replace(/^Action \d+ \([^)]*\):\s*/, "").replace(/\s*\(script line \d+\)\s*$/, "").trim();
  const said = PLAIN.find(([pattern]) => pattern.test(stripped))?.[1].replace(/\$app/g, app);
  const text = said ?? stripped.charAt(0).toUpperCase() + stripped.slice(1);
  // Nothing taken out, at most a capital letter put in: no details to show.
  return said || stripped !== raw.trim() ? { error: text, errorDetail: raw } : { error: text };
}

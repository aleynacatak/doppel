import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newId } from "../../core/util";
import { assemble } from "./jsx/scripts";

// AppleScript ↔ ExtendScript bridge. Each call writes the assembled script to a temp .jsx file and
// asks InDesign (by bundle id, so the version folder name doesn't matter) to run it with one JSON
// argument. Arguments are passed to osascript with execFile, never through a shell string.

export const INDESIGN_BUNDLE_ID = "com.adobe.InDesign";

const RUN_JSX = `
on run argv
	set jsxPath to item 1 of argv
	set jsonArgs to item 2 of argv
	set timeoutSecs to (item 3 of argv) as integer
	set jsxFile to POSIX file jsxPath
	with timeout of timeoutSecs seconds
		tell application id "${INDESIGN_BUNDLE_ID}"
			set scriptResult to do script jsxFile language javascript with arguments {jsonArgs}
		end tell
	end timeout
	return scriptResult
end run
`;

export type BridgeErrorKind = "permission-denied" | "not-running" | "timeout" | "script" | "bridge";

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
    readonly detail?: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

function osascript(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (err.killed || err.signal === "SIGTERM") {
            return reject(new BridgeError("timeout", "InDesign didn't answer in time."));
          }
          return reject(mapAppleScriptError(stderr || err.message));
        }
        resolve(stdout.replace(/\n$/, ""));
      },
    );
  });
}

function mapAppleScriptError(stderr: string): BridgeError {
  const code = Number(stderr.match(/\((-?\d+)\)\s*$/m)?.[1]);
  const detail = stderr.trim();
  if (code === -1743) {
    return new BridgeError(
      "permission-denied",
      "Doppel isn't allowed to control InDesign. Turn it on in System Settings → Privacy & Security → Automation.",
      detail,
    );
  }
  if (code === -600 || code === -609) {
    return new BridgeError("not-running", "InDesign isn't running.", detail);
  }
  if (code === -1712) {
    return new BridgeError("timeout", "InDesign didn't answer in time.", detail);
  }
  // Positive codes come from InDesign itself, e.g. "got an error: Illegal use of reserved word 'long' (9)".
  const fromApp = detail.match(/got an error: ([\s\S]*?) \((\d+)\)$/);
  if (fromApp) return new BridgeError("script", fromApp[1].trim(), detail);
  return new BridgeError("bridge", "InDesign couldn't run the script.", detail);
}

/** True if InDesign is running. Never launches it. */
export async function isRunning(): Promise<boolean> {
  try {
    const out = await osascript(["-e", `application id "${INDESIGN_BUNDLE_ID}" is running`], 5000);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function activate(): Promise<void> {
  await osascript(["-e", `tell application id "${INDESIGN_BUNDLE_ID}" to activate`], 10000);
}

/** True if InDesign is installed (Spotlight first, then the usual Applications folders). */
export async function isInstalled(): Promise<boolean> {
  const viaSpotlight = await new Promise<boolean>((resolve) => {
    execFile("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${INDESIGN_BUNDLE_ID}'`], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
  if (viaSpotlight) return true;
  try {
    const entries = await fs.readdir("/Applications");
    return entries.some((e) => e.startsWith("Adobe InDesign"));
  } catch {
    return false;
  }
}

// InDesign runs one script at a time; queue calls so timeouts measure our script, not the wait.
let queue: Promise<unknown> = Promise.resolve();
let busy = false;

export const isBusy = () => busy;

/**
 * Runs `main` (an ExtendScript `function (input) {…}`) in InDesign and returns its data.
 * Throws BridgeError with a plain-language message on failure.
 */
export function runJsx<T>(main: string, input: unknown, timeoutSec: number): Promise<T> {
  const job = queue.then(() => execute<T>(main, input, timeoutSec));
  queue = job.catch(() => undefined);
  return job;
}

async function execute<T>(main: string, input: unknown, timeoutSec: number): Promise<T> {
  busy = true;
  const { source, routineStartLine } = assemble(main);
  const dir = path.join(os.tmpdir(), "doppel-jsx");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${newId()}.jsx`);
  // UTF-8 with BOM, so ExtendScript reads non-ASCII text correctly.
  await fs.writeFile(file, `\ufeff${source}`, "utf8");
  try {
    const raw = await osascript(["-e", RUN_JSX, file, JSON.stringify(input ?? {}), String(timeoutSec)], (timeoutSec + 5) * 1000);
    let parsed: { ok: boolean; data?: T; error?: string; line?: number | null };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BridgeError("bridge", "InDesign returned something Doppel couldn't read.", raw.slice(0, 500));
    }
    if (!parsed.ok) {
      const line = parsed.line && routineStartLine ? parsed.line - routineStartLine + 1 : undefined;
      throw new BridgeError("script", parsed.error || "The script failed.", parsed.error, line && line > 0 ? line : undefined);
    }
    return parsed.data as T;
  } catch (err) {
    if (err instanceof BridgeError && err.kind === "timeout") {
      throw new BridgeError("timeout", `InDesign didn't finish within ${timeoutSec} seconds. You can raise the limit in Settings.`);
    }
    throw err;
  } finally {
    busy = false;
    fs.rm(file, { force: true }).catch(() => undefined);
  }
}

import { BrowserWindow, app, dialog, protocol, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createServices, type Services } from "./core/config";
import { connectionLog } from "./core/services/connectionLog";
import { migrateDoppelData } from "./core/services/migration";
import { EVENT_CHANNELS } from "./ipc/api";
import { registerIpc } from "./ipc/handlers";

// Dev: load the Next dev server (hot reload). Production: serve renderer/out through app://.
const DEV_SERVER_URL = process.env.DOPPL_DEV_SERVER_URL;
const APP_ORIGIN = "app://doppl";
const RENDERER_DIR = path.join(__dirname, "..", "renderer", "out");

if (DEV_SERVER_URL) {
  // Next's dev server needs eval; the warning would only be noise in dev.
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

app.setName("Doppl");
// HTTP/3 (QUIC) connections to the AI service were dropped mid-answer (net::ERR_QUIC_GOAWAY…); HTTP/2 is steadier.
app.commandLine.appendSwitch("disable-quic");
// `npm run eval` and `npm run test:helpers`: no window; run headless and quit (electron/evals/).
const EVAL_MODE = process.argv.includes("--doppl-eval");
const HELPER_TESTS = process.argv.includes("--doppl-test-helpers");
// Optional: keep data somewhere else (e.g. a throwaway folder for testing).
if (process.env.DOPPL_USER_DATA) app.setPath("userData", process.env.DOPPL_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

async function isFile(p: string) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** /routine → routine.html, / → index.html, /_next/... as is. Never leaves RENDERER_DIR. */
async function resolveRendererFile(pathname: string): Promise<string | null> {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const base = path.join(RENDERER_DIR, clean);
  if (!base.startsWith(RENDERER_DIR)) return null;
  const candidates = clean === "" ? [path.join(RENDERER_DIR, "index.html")] : [base, `${base}.html`, path.join(base, "index.html")];
  for (const c of candidates) if (await isFile(c)) return c;
  return null;
}

function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const file = await resolveRendererFile(pathname);
    if (!file) {
      const notFound = await fs.readFile(path.join(RENDERER_DIR, "404.html")).catch(() => Buffer.from("Not found"));
      return new Response(new Uint8Array(notFound), { status: 404, headers: { "content-type": MIME[".html"] } });
    }
    const body = await fs.readFile(file);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "content-security-policy": CSP,
      },
    });
  });
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Doppl",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());

  const allowedOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : APP_ORIGIN;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(allowedOrigin)) event.preventDefault();
  });
  // Surface renderer warnings and errors in the terminal.
  win.webContents.on("console-message", (event) => {
    if (event.level === "warning" || event.level === "error") {
      console.log(`[renderer ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });

  void win.loadURL(DEV_SERVER_URL ?? `${APP_ORIGIN}/`);
  return win;
}

let services: Services | null = null;

/** Doppl demo Worker URL: set at build time (scripts/write-build-config.mjs); DOPPL_API_BASE_URL overrides it for local testing. */
async function workerUrl(): Promise<string> {
  if (process.env.DOPPL_API_BASE_URL) return process.env.DOPPL_API_BASE_URL.replace(/\/$/, "");
  try {
    const config = JSON.parse(await fs.readFile(path.join(__dirname, "build-config.json"), "utf8")) as { apiBaseUrl?: string };
    if (config.apiBaseUrl) return config.apiBaseUrl.replace(/\/$/, "");
  } catch {
    // Not built with a config: use the default.
  }
  return "https://api.doppl.work";
}

app.whenReady().then(async () => {
  if (EVAL_MODE || HELPER_TESTS) {
    app.dock?.hide();
    const paths = { userData: app.getPath("userData"), temp: app.getPath("temp") };
    const run = EVAL_MODE
      ? import("./evals/cli").then(async ({ runEvalCli }) => runEvalCli(process.argv, paths, await workerUrl()))
      : import("./evals/helpersCli").then(({ runHelpersCli }) => runHelpersCli(process.argv, paths));
    const code = await run.catch((err) => {
      console.error(`${EVAL_MODE ? "Eval" : "Building block tests"} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    });
    app.exit(code);
    return;
  }
  if (!DEV_SERVER_URL) registerAppProtocol();

  const emitters = {
    apps: (apps: unknown) => broadcast(EVENT_CHANNELS.apps, apps),
    run: (run: unknown) => broadcast(EVENT_CHANNELS.run, run),
    creation: (creation: unknown) => broadcast(EVENT_CHANNELS.creation, creation),
    chooseSavePath: async (defaultName: string) => {
      const win = BrowserWindow.getFocusedWindow();
      const options = { defaultPath: path.join(app.isPackaged ? app.getPath("desktop") : path.join(app.getAppPath(), "resources", "starters"), defaultName) };
      const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      return res.canceled || !res.filePath ? null : res.filePath;
    },
  };
  if (!process.env.DOPPL_USER_DATA) {
    await migrateDoppelData(app.getPath("appData"), app.getPath("userData")).catch((err) => console.error("[migration]", err));
  }
  // Starter routines ship in the app's resources (resources/starters/ in the repo while developing;
  // DOPPL_STARTERS_DIR points somewhere else for testing).
  const starters =
    process.env.DOPPL_STARTERS_DIR ?? (app.isPackaged ? path.join(process.resourcesPath, "starters") : path.join(app.getAppPath(), "resources", "starters"));
  services = await createServices(
    { userData: app.getPath("userData"), temp: app.getPath("temp"), documents: app.getPath("documents"), starters },
    emitters,
    await workerUrl(),
  );

  registerIpc(services);
  connectionLog.onEntry((entry) => broadcast(EVENT_CHANNELS.connectionLog, entry));
  services.bridge.start();
  services.apps.start();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  services?.apps.stop();
  services?.bridge.stop();
});

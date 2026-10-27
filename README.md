# Doppel

Doppel learns your design routines and runs them in your own apps. Describe a task once; Meta's models turn it into a reusable routine you can rerun with no AI calls. Works across InDesign, Figma and more.

This repo is the desktop app (wireframe styling) plus [`worker/`](worker/README.md), the Cloudflare Worker that gives testers demo access to the AI.

| Part | Status |
| --- | --- |
| InDesign adapter (AppleScript → ExtendScript) | **Real** |
| Rule-level QC for InDesign (overset text, links, fonts, image resolution) | **Real** |
| AI: writing, clarifying question, fixing, repairing routines (Muse Spark 1.3) | **Real**, through the demo Worker (access code) or the designer's own Meta API key |
| Visual QC (Muse Spark) and key-object checks (SAM 3.1) while creating | **Real** |
| Storage (JSON in `userData`), encrypted code/key (Keychain), native pickers | **Real** |
| Figma adapter (plugin + WebSocket) | Mock |
| Style profile extraction, object-level QC on reruns | Mock |
| Mock AI (template library, no network) | Dev panel → "Mock AI" or `DOPPEL_MOCK_AI=1` |

## Try it

1. Download `Doppel-<version>-arm64.dmg` and drag Doppel to Applications.
2. The first time, right-click Doppel → **Open** (the app isn't notarized). If macOS only offers "Move to Trash", go to System Settings → Privacy & Security and click **Open Anyway**.
3. On the Connect screen, click **Check again** under Figma (simulated for now). If you have InDesign, open it with a document and Doppel connects on its own.
4. Go to **Settings → AI access**, paste your access code (`DOPPL-…`) and click **Check code**. It shows how many routine creations you have left.
5. First run: **New task** → "Resize this campaign visual into all social formats" (Figma) → **Create routine** → answer the question → **Save routine** → **Run**. The rerun uses 0 AI calls.
6. With InDesign: open a document, then **New task** → "Export every page as a PNG at 150 ppi" → create, save, run on a copy.

Creating or repairing a routine uses AI and one creation from your code. Rerunning saved routines never does, even offline.

## Run it

Requirements: macOS on Apple Silicon, Node **22.12+** (`nvm use` picks it up from `.nvmrc`).

```bash
nvm use
npm install
npm run dev        # Next dev server + main-process watcher + Electron, with hot reload
```

```bash
npm run dist       # unsigned .dmg and .app in release/
npm start          # production build, run without packaging
npm run typecheck
```

If `npm install` ran under an older Node, the Electron binary may be missing; run `node node_modules/electron/install.js` with Node 22.

### Opening the unsigned app

`npm run dist` writes `release/Doppel-<version>-arm64.dmg` (and `release/mac-arm64/Doppel.app`). The app is ad-hoc signed, not notarized. The first time, right-click Doppel.app → **Open**. If macOS only offers "Move to Trash", open **System Settings → Privacy & Security** and click **Open Anyway** next to the Doppel message (or run `xattr -dr com.apple.quarantine /Applications/Doppel.app`).

## InDesign (real)

With InDesign open and a document active, Doppel shows InDesign as connected, lists open documents, and can run every InDesign routine for real.

- **Bridge**: each call writes a temp `.jsx` (UTF-8 with BOM), and runs it with `osascript` via `execFile` (never a shell string): `tell application id "com.adobe.InDesign" to do script … language javascript with arguments {json}`. A bundled JSON polyfill is prepended; every script returns `{ ok, data }` or `{ ok: false, error }`.
- **Status**: installed via Spotlight (`mdfind` on the bundle id), running via `application id … is running`, polled every 3 s without launching InDesign. Closing InDesign shows "Not running"; reopening it reconnects on its own.
- **Permission**: the first script triggers macOS's "Doppel wants to control Adobe InDesign" prompt (`NSAppleEventsUsageDescription` is set in Info.plist). In `npm run dev` the prompt names your **terminal app** instead of Doppel, because it launched Electron. If you clicked "Don't Allow": System Settings → Privacy & Security → Automation → enable InDesign under Doppel (or your terminal). The Connect screen shows this state with a button that opens the right settings page.
- **Safety**: runs go on a copy by default: `<name>_doppel.indd` (then `_doppel-2`, …) saved next to the original and opened. Unsaved documents are copied to `~/Documents/Doppel copies`. Copies of read-only routines (exports, preflight) are closed after the run so your original stays in front; "Open in app" reopens them. The Run and New task screens preselect the original even when a Doppel copy is frontmost. "Run on the original" is an explicit option. Every routine is wrapped in `app.doScript(…, UndoModes.ENTIRE_SCRIPT, "Doppel: <name>")`, so one Cmd+Z reverts it. Scripts time out after 120 s (Settings → Script timeout).
- **Previews**: pages are exported as PNG (72 ppi) into a temp folder and sent to the UI as data URLs; exported PNGs and PDFs (Quick Look thumbnail) are previewed directly.
- **QC (rule level)**, after every InDesign run with "Automatic check": overset text, missing/modified links, missing fonts, images below a minimum effective resolution (300 ppi print / 150 ppi web, editable on the Run screen), reported per page.
- **Creation**: the model writes the routine; the "Running" and "Checking result" stages run it for real on a hidden temporary copy (closed and deleted afterwards), so the preview and QC you see while creating are real.

Seed routines (real ExtendScript, no hardcoded paths): Export pages as PNG · Export print and web PDFs · Preflight report · Rename layers by pattern (with dry run) · Place text into template (experimental).

Cancelling an InDesign run stops after the current step; InDesign can't interrupt a script that is already running.

## AI access

Settings → AI access has three options (`Settings.aiProvider`):

- **Demo access code** (`"doppl-demo"`): requests go to the Doppl demo Worker (`worker/`, default `https://api.doppl.work`) with the code and an `X-Doppl-Creation-Id` per routine creation. The Worker holds the Meta key and enforces the code's limits; the creation screen shows "Demo: 17 of 20 creations left". AI review on reruns isn't offered: reruns never call the Worker.
- **My own Meta API key** (`"meta-api"`): requests go straight to `https://api.meta.ai/v1`. The app estimates spend from token counts and stops at the monthly limit you set.
- **Muse Glimmer (local)**: shown, not available yet.

The code and key are encrypted with Electron `safeStorage` (macOS Keychain) in `secrets.json` and never reach the renderer. Every AI error comes with a plain message and the next step: Settings, "Use your own API key", "Try again" or "Start over".

How a routine gets written (`core/services/modelAiService.ts`, prompts in `aiPrompts.ts`):
1. Muse Spark gets the request, the document summary, the app's scripting guide (`adapters/*/modelGuide`) and two example routines. It answers with structured JSON: one clarifying question, or a routine (steps, params, script).
2. Doppl checks the script before it runs (`adapters/indesign/lint.ts`). It rejects syntax errors, code ExtendScript doesn't support, and anything unsafe: deleting files, running programs or other scripts, network access, `eval`, dialogs. Absolute paths are rejected too. Problems go back to the model to fix, up to twice.
3. The trial run happens on a temporary copy. If InDesign reports an error, it goes back to the model with the line number.
4. Muse Spark reviews the previews, and SAM 3.1 checks that key objects (e.g. "product") don't touch the edges.

The Worker URL is set at build time: `DOPPEL_API_BASE_URL=https://… npm run dist` (default `https://api.doppl.work`).

## Dev panel

Press **Shift+D** anywhere (outside text fields) to force states for design: mock AI (no network, no quota), empty library, each app's status (connected / not running / not installed / needs permission), creation failure / always ask a question / absolute path in the script, run failure (cleared by a repair) / partial failure, QC all pass / some flagged, version and font mismatch on the Run screen, mock speed, back to first launch, reset all data.

Environment variables:

- `DOPPEL_USER_DATA=/some/folder`: keep data elsewhere (handy for testing).
- `DOPPEL_MOCK_INDESIGN=1`: use a mock InDesign (for designing without InDesign installed).
- `DOPPEL_MOCK_AI=1`: start with the mock AI switched on.
- `DOPPEL_API_BASE_URL=http://127.0.0.1:8787`: use another Worker at run time (e.g. `wrangler dev`).
- `DOPPEL_META_API_BASE`: testing only; another base URL for own-key requests (e.g. a local fake of Meta's API).
- `DOPPEL_DEV_SERVER_URL`: set by `npm run dev`; without it Electron serves the static export through `app://doppel/`.

## Structure

```
electron/
  main.ts              window, app:// protocol (serves renderer/out), IPC wiring
  preload.ts           contextBridge → window.doppel (typed by DoppelApi)
  ipc/                 handlers: window.doppel method → core service
  core/
    types.ts           domain types + DoppelApi, shared with the renderer (import type only)
    config.ts          THE one place that picks mock vs real implementations
    services/          routineService (create/repair/save/list), runService (runs, previews, QC),
                       qcService, aiService (interface), modelAiService + aiPrompts (real AI),
                       aiTransport (demo Worker / Meta), aiAccessService + secretStore (Settings → AI access),
                       storage, settings, appStatus, style, portability
    mock/              mock AI, seed data + template library, dev flags
  adapters/
    types.ts           DesignAppAdapter interface
    indesign/          real adapter: bridge.ts (osascript), jsx/ (ExtendScript), templates.ts (seed routines),
                       modelGuide.ts (what the model is told), lint.ts (safety check)
    figma/             mock Figma adapter + templates
    mock/              generic mock adapter (placeholder previews, fake progress)
    registry.ts
renderer/              Next.js (App Router, static export)
  app/                 one folder per screen; IDs travel as query params (/routine?id=…)
  components/          one component per UI block, grouped by screen; ui/ holds primitives
  lib/doppel.ts        typed access to window.doppel
  lib/store.ts         small Zustand store (apps, settings, dev flags)
  copy.ts              all UI strings
  app/globals.css      all visual styling (.ui-* classes); Tailwind is used for layout only
worker/                Cloudflare Worker for demo access codes (own package; see worker/README.md)
```

Data lives in `~/Library/Application Support/Doppel/`: `routines/<id>.json` (one file per routine, with a stable id, `version` and `updatedAt`), `runs/<id>.json`, `settings.json`, `style-profile.json`, and `secrets.json` (access code and own key, encrypted with the Keychain).

## Where real implementations plug in

Everything the UI touches goes through interfaces; swap the construction in `electron/core/config.ts`:

- **AI**: `ModelAiService` implements `AiService` on top of an `AiTransport` (demo Worker or Meta). Another provider is a new transport; the dev panel switches to `MockAiService`.
- **Figma**: implement `DesignAppAdapter` with a local WebSocket server that the Doppel Figma plugin connects to; replace `createFigmaMockAdapter`.
- **More apps**: add an adapter folder and register it in `config.ts`; the Connect screen, sidebar chips and app pickers pick it up from the registry.
- **QC**: rule level comes from each adapter's `ruleChecks`; while creating, the model and SAM add visual and key-object checks; object-level checks on reruns are still mocked in `qcService.ts`.
- **Local model** (Muse Glimmer): `aiProvider` already has `"local"`; add a transport that talks to Ollama / LM Studio and enable the option in Settings.

## Routine portability

Routines will sync across devices, so: scripts never contain absolute paths (every file or folder is a param picked at run time; `/Users/`, `~/`, `/Volumes/`, drive letters and `file://` are flagged when saving). Each routine records `appVersion` and `requiredFonts`; the Run screen warns on a version or font mismatch and offers "Run anyway" or "Repair with AI".

## Restyling

The UI is deliberately wireframe-grade. Visual styling is only in `renderer/app/globals.css` (`.ui-*` classes and CSS variables); components use Tailwind for layout only; strings are in `renderer/copy.ts`. No component library, no theme.

# Doppel

Doppel learns your design routines and runs them in your own apps. Describe a task once; Meta's models turn it into a reusable routine you can rerun with no AI calls. Works across InDesign, Figma and more.

This repo holds the desktop app (wireframe styling), the Doppel Figma plugin ([`figma-plugin/`](figma-plugin/)) and [`worker/`](worker/README.md), the Cloudflare Worker that gives testers demo access to the AI. There is no mock data: every app connection, AI call and check is real.

| Part | How |
| --- | --- |
| InDesign | AppleScript → ExtendScript on this Mac |
| Figma | Files connected by link (Figma REST API, personal access token); routines run in the Doppel plugin |
| AI (writing, clarifying question, fixing, repairing routines) | Muse Spark 1.3 through the demo Worker (access code) or your own Meta API key |
| Checks | Each app's own checks; Muse Spark looks at previews; SAM 3.1 checks key objects against the edges |
| Style profile | Read from your InDesign files and Figma links |
| Storage | JSON in `userData`; codes, keys and tokens encrypted with the macOS Keychain |

## Try it

1. Download `Doppel-<version>-arm64.dmg` and drag Doppel to Applications.
2. The first time, right-click Doppel → **Open** (the app isn't notarized). If macOS only offers "Move to Trash", go to System Settings → Privacy & Security and click **Open Anyway**.
3. **Connect apps.**
   - **InDesign:** open it with a document; Doppel connects on its own.
   - **Figma:** see [Figma setup](#figma-setup) below (about 5 minutes, once).
4. Go to **Settings → AI access**, paste your access code (`DOPPL-…`) and click **Check code**. It shows how many routine creations you have left.
5. **New task** → describe what you want → **Create routine** → answer the question if Doppel asks one → **Save routine** → **Run**. Reruns use 0 AI calls.

Creating or repairing a routine uses AI and one creation from your code. Rerunning saved routines never does, even offline.

## Figma setup

Doppel reads Figma files through their links, and runs routines inside Figma through the Doppel plugin.

1. **Access token** (lets Doppel read your files): in Figma, open the account menu → **Settings** → **Security** → **Personal access tokens** → **Generate new token**. Give it the scopes `file_content:read` and `current_user:read`. Paste it in Doppel → **Connect apps** → Figma → **Check token**.
2. **Add files:** in Figma, **Share** → **Copy link**; paste the link in Doppel → Connect apps → Figma → **Add file**.
3. **Plugin** (once, in the Figma desktop app):
   1. In Doppel, click **Show plugin files**.
   2. In Figma, go to **Plugins** → **Development** → **Import plugin from manifest…** and choose that `manifest.json`.
   3. Open your file and run **Plugins** → **Development** → **Doppel**.
   4. Type the **pairing code** shown in Doppel.

   Keep the small Doppel window open in Figma while routines run.

How runs work in Figma:
- **On a copy of the page (default):** a routine duplicates the open page and works there. "Run on the page itself" is an option, and Cmd+Z in Figma undoes it.
- **While creating a routine,** the trial run happens on a temporary copy of the page, which is removed afterwards.
- **Checks on every frame a routine makes:** text cut off by its frame, missing fonts, and images shown larger than their pixels (blurry).
- **Files** a routine exports (PNG, JPG, SVG, PDF) can only be saved into folders you pick on the Run screen.

The plugin connects to Doppel on `ws://localhost:17433`. Doppel listens only on this Mac, refuses web pages, and requires the pairing code. Figma's plugin docs don't say whether plugins may run code they receive (Doppel's routines are run with `new Function`); Figma's own Scripter plugin works the same way. If a Figma version blocks it, the plugin reports a clear error.

## InDesign

With InDesign open and a document active, Doppel shows InDesign as connected, lists open documents, and runs routines for real.

- **Bridge:** each call writes a temp `.jsx` (UTF-8 with BOM) and runs it with `osascript` via `execFile` (never a shell string). A bundled JSON polyfill is prepended; every script returns `{ ok, data }` or `{ ok: false, error }`.
- **Status:** installed via Spotlight, running via `application id … is running`, polled every 3 s without launching InDesign.
- **Permission:** the first script triggers macOS's "Doppel wants to control Adobe InDesign" prompt. In `npm run dev` the prompt names your terminal app instead of Doppel. If you clicked "Don't Allow": System Settings → Privacy & Security → Automation.
- **Safety:**
  - **Runs go on a copy by default:** `<name>_doppel.indd` is saved next to the original. Unsaved documents are copied to `~/Documents/Doppel copies`.
  - **Undo:** every routine is one undo step ("Doppel: <name>").
  - **Timeout:** scripts give up after 120 s (Settings).
  - **Unsafe code is refused:** model-written scripts are checked before they run (no deleting files, no running programs, no network, no dialogs).
- **Checks after a run:**
  - **Rules:** overset text, missing or modified links, missing fonts, images below a minimum resolution (300 ppi print / 150 ppi web).
  - **Objects:** text frames that run past the page edge, and images that cross the page edge but stop before the bleed.
  - All reported per page.

Example routines (real ExtendScript, shown to the model as examples): Export pages as PNG · Export print and web PDFs · Preflight report · Rename layers by pattern · Place text into template.

## AI access

Settings → AI access:
- **Demo access code:** requests go to the Doppl demo Worker (`worker/`, default `https://api.doppl.work`) with an `X-Doppl-Creation-Id` per routine creation. The creation screen shows "Demo: 17 of 20 creations left".
- **My own Meta API key:** requests go straight to Meta's Model API. Doppel estimates spend and stops at your monthly limit.
- **Muse Glimmer (local):** shown, not available yet.

How a routine gets written:
1. **Draft:** Muse Spark gets the request, the document summary, the app's scripting guide, two example routines and your house style. It may ask one question.
2. **Safety check:** Doppel checks the script before it runs (syntax, unsupported or unsafe calls, fixed file locations).
3. **Trial run:** the routine runs on a temporary copy, so the preview and checks you see while creating are real.
4. **Fixes:** problems from the check or the trial run go back to the model, up to twice.
5. **Review:** the model reviews the previews, and SAM 3.1 checks that key objects (e.g. "product") don't touch the edges.

The Worker URL is set at build time: `DOPPEL_API_BASE_URL=https://… npm run dist`.

## Run it (developers)

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

Environment variables:
- `DOPPEL_USER_DATA=/some/folder`: keep data elsewhere (handy for testing).
- `DOPPEL_API_BASE_URL=http://127.0.0.1:8787`: use another Worker at run time (e.g. `wrangler dev`).
- `DOPPEL_DEV_SERVER_URL`: set by `npm run dev`. Without it, Electron serves the static export through `app://doppel/`.

## Structure

```
electron/
  main.ts              window, app:// protocol (serves renderer/out), IPC wiring
  preload.ts           contextBridge → window.doppel (typed by DoppelApi)
  ipc/                 handlers: window.doppel method → core service
  core/
    types.ts           domain types + DoppelApi, shared with the renderer (import type only)
    config.ts          builds every service
    templates.ts       example routines shown to the model
    services/          routineService (create/repair/save/list), runService (runs, previews, checks),
                       qcService, modelAiService + aiPrompts, aiTransport (demo Worker / Meta),
                       aiAccessService + secretStore, figmaService, styleService, storage, settings, appStatus
  adapters/
    types.ts           DesignAppAdapter interface
    indesign/          bridge.ts (osascript), jsx/ (ExtendScript), templates.ts, modelGuide.ts, lint.ts
    figma/             figmaRest.ts (links), pluginBridge.ts (local connection), figmaAdapter.ts,
                       templates.ts, modelGuide.ts, lint.ts
    registry.ts
figma-plugin/          the Doppel plugin for Figma (manifest.json, code.js, ui.html)
renderer/              Next.js (App Router, static export)
  app/                 one folder per screen; IDs travel as query params (/routine?id=…)
  components/          one component per UI block, grouped by screen; ui/ holds primitives
  lib/doppel.ts        typed access to window.doppel
  copy.ts              all UI strings
  app/globals.css      all visual styling (.ui-* classes); Tailwind is used for layout only
worker/                Cloudflare Worker for demo access codes (own package; see worker/README.md)
```

Data lives in `~/Library/Application Support/Doppel/`:
- `routines/<id>.json`: one file per routine, with a stable id, `version` and `updatedAt`.
- `runs/<id>.json`, `settings.json` (including connected Figma files), `style-profile.json`.
- `secrets.json`: access code, Meta key and Figma token, encrypted with the Keychain.

## Adding more

- **Another app:** implement `DesignAppAdapter` (status, documents, running scripts, previews, checks, a model guide and example routines) and register it in `core/config.ts`. The Connect screen, sidebar and pickers pick it up from the registry.
- **Local model (Muse Glimmer):** `aiProvider` already has `"local"`. Add a transport that talks to Ollama / LM Studio and enable the option in Settings.

## Routine portability

Routines will sync across devices:
- **No fixed locations:** scripts never contain absolute paths. Every file or folder is a param picked at run time, and fixed locations are sent back to the model to fix.
- **Environment check:** each routine records `appVersion` and `requiredFonts`. The Run screen warns on a version or font mismatch and offers "Run anyway" or "Repair with AI".

## Restyling

The UI is deliberately wireframe-grade:
- Visual styling lives only in `renderer/app/globals.css` (`.ui-*` classes and CSS variables).
- Components use Tailwind for layout only.
- Strings are in `renderer/copy.ts`.
- No component library, no theme.

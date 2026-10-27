# Doppl

Doppl learns your design routines and runs them in your own apps. Describe a task once; Meta's models turn it into a reusable routine you can rerun with no AI calls. One routine can work across several apps: for example, labels made in Figma from a spreadsheet, then put on mockups in Photoshop.

This repo holds:
- the desktop app (wireframe styling);
- the Doppl Figma plugin ([`figma-plugin/`](figma-plugin/));
- [`worker/`](worker/README.md), the Cloudflare Worker that gives testers demo access to the AI.

There is no mock data and there are no sample routines: every app connection, AI call and check is real, and you create routines yourself with New task.

| Part | How |
| --- | --- |
| InDesign | AppleScript → ExtendScript on this Mac (shared Adobe bridge) |
| Photoshop | The same bridge; works on duplicates and never saves over your PSD |
| Figma | The Doppl plugin runs declarative action lists; files can also be connected by link (REST API) |
| Multi-app routines | Stages in order, handing files to each other, once per data row or file |
| AI (writing, previews, fixing, repairing routines) | Muse Spark 1.3 through the demo Worker (access code) or your own Meta API key |
| Checks | Each app's own rule and object checks; optional visual review and object checks (SAM 3.1) |
| Storage | JSON in `userData`; codes, keys and tokens encrypted with the macOS Keychain |

## Try it

1. Download `Doppl-<version>-arm64.dmg` and drag Doppl to Applications.
2. The first time, right-click Doppl → **Open** (the app isn't notarized). If macOS only offers "Move to Trash", go to System Settings → Privacy & Security and click **Open Anyway**.
3. If macOS asks for your password so Doppl can use "Doppl Safe Storage", type your Mac password and click **Always Allow**.
4. **Connect apps.**
   - **InDesign, Photoshop:** open them; Doppl connects on its own. The first time, macOS asks whether Doppl may control each app; click **OK**.
   - **Figma:** see [Figma setup](#figma-setup) below (about 3 minutes, once).
5. Go to **Settings → AI access**, paste your access code (`DOPPL-…`) and click **Check code**.
6. **New task:**
   1. Describe what you want.
   2. Attach sample data (CSV, JSON or Excel) or folders if the routine uses them.
   3. Tick every app the routine uses, then click **Create routine**.
   4. Then **Save routine** → **Run**. Reruns use 0 AI calls.

Coming from "Doppel" (the earlier name)? Your routines, runs and settings are copied over on the first launch. The access code, API key and Figma token were encrypted under the old name, so enter them again once.

## Figma setup

Routines run inside Figma through the Doppl plugin, a development plugin you import once into the **Figma desktop app**.

1. In Doppl, go to **Connect apps** → Figma → **Show plugin files**. Finder shows a `manifest.json`.
2. In Figma, open the main menu → **Plugins** → **Development** → **Import plugin from manifest…** and choose that `manifest.json`.
3. Open your file and run **Plugins** → **Development** → **Doppl**. The first time, type the **pairing code** shown in Doppl.

Keep the small Doppl window open in Figma while routines run. Each file with the plugin running shows up in Doppl (Connect apps lists them); routines pick the file to work on. The window shows what it is doing and has a **Cancel** button.

**Optional: files by link.** With a Figma personal access token (scopes `file_content:read` and `current_user:read`), you can add file links: Doppl opens them in Figma with one click and reads them for the Style profile without the plugin.

### How the plugin connects
- **Connection:** the plugin's window opens a WebSocket to Doppl at `ws://localhost:47810`. The port can be changed in Settings; Doppl then rewrites the plugin copy in its data folder, so import it again.
- **Handshake:** the plugin says hello with the file's name (and key), its version and the pairing code; Doppl answers with a session id. Several open files are several sessions, and messages are routed by session.
- **Who may connect:** Doppl listens on this Mac only and refuses web pages (they send a real `Origin`). It also requires the pairing code, because sandboxed web pages share the plugin window's origin `null`.
- **Reconnects and closing:** the window reconnects every 2 s. If it closes during a run, the run fails with a clear message instead of hanging.
- **Large payloads** (images, exports) travel in 512 KB chunks in both directions.

### Open questions (Figma's docs, checked October 2026)
- **`ws://` in `devAllowedDomains`:** the [manifest docs](https://developers.figma.com/docs/plugins/manifest/) list `ws`/`wss` as allowed schemes but show only `http(s)://localhost` examples for `devAllowedDomains`. Doppl declares `ws://localhost:<port>`. If a Figma version rejects it, the plugin window can't connect.
- **Wildcard ports:** the docs don't say whether they are allowed. That's why the port is written into the manifest copy.
- **Message sizes:** the docs give no size limit for `figma.ui.postMessage` or plugin WebSockets. Doppl chunks large messages anyway; between the plugin window and its code, messages pass whole.
- **`figma.fileKey`:** it's only for private plugins. Doppl sets `enablePrivatePluginApi` (which the docs say enables it during development) and falls back to matching files by name.
- **Images:** `figma.createImage` takes PNG, JPEG or GIF up to 4096 px. Doppl checks this before sending.

## Routines with stages

A routine has **params** (picked at each run) and one or more **stages**. Each stage runs in one app:

| Field | What it is |
| --- | --- |
| `appId`, `kind` | Figma stages are `"actions"` (an action list); InDesign and Photoshop stages are `"script"` (ExtendScript). |
| `repeat.over` | Optional: run once per item of a list: `{{params.<dataFile>.rows}}`, `{{params.<folder>.files}}` or `{{stage.<id>.outputs.<key>}}`. |
| `inputs` | The placeholders the stage reads. |
| `outputs` | Named outputs, e.g. `{ "key": "files", "type": "fileList" }`, that later stages use. |
| `document` | `"open"` (works on a document the designer picks) or `"none"` (opens its own files). |

**Placeholders** are expanded per item, right before a stage runs:
- `{{params.<key>}}`; a data file param also has `.rows` and `.columns`, and a folder param has `.files`.
- `{{item.<field>}}`: the data row, or for files `path`, `name`, `stem`, `ext`.
- `{{itemIndex}}`: 1-based.
- `{{stage.<id>.outputs.<key>}}`: an earlier stage's outputs.

A value that is exactly one placeholder keeps its type.

**Runs:**
- **Working folders:** each run gets `userData/runs/<runId>/<stageId>/` per stage; files handed to later stages go there. Final deliverables go to a folder param the designer picks.
- **Order and partial failure:** stages run in order and items one after another. A failed item (a data row with an empty required value, a wrong barcode check digit, a missing image) is recorded, and later stages skip it. Results show both, grouped by stage.
- **Readiness:** before a run, every stage's app must be connected with the right document; otherwise the Run screen says what to open.
- **Progress:** shown per stage and per item ("Figma · item 3 of 6"), with Cancel.

**Saving requires the validator to pass** (`electron/core/stages/validator.ts`):
- action lists match the catalog, and scripts pass the safety check;
- there are no absolute paths and no values copied from the sample data used while creating;
- every placeholder resolves to a param or an earlier stage's output;
- every app has an adapter.

Errors are structured (`path`, `code`, `message`), so the creation flow sends them back to the model.

Older single-app routines have no stages and run exactly as before.

### Figma action catalog

Defined once with zod in [`electron/shared/figmaActions.ts`](electron/shared/figmaActions.ts). The same schemas:
- validate routines in Doppl;
- validate requests again in the plugin;
- become the JSON Schema the model gets.

No code strings run in Figma.

| Group | Actions |
| --- | --- |
| Reading | `getSelection`, `findNodes { query, within? }`, `inspectNode { node, depth }` |
| Structure | `createPage`, `duplicateNode`, `deleteNode`, `renameNode`, `arrangeInGrid` |
| Text | `setText` (loads every font first; missing fonts are reported, not fatal), `setTextStyleRanges` (by position or matching text) |
| Repetition | `repeatChild { container, templateChild, items, bindings }` for lists and tables |
| Media | `setImageFill` (from a picked folder by file name, or a file), `placeSvg` (SVG or a barcode, scaled and centered) |
| Properties | `setProperties` (visible, opacity, fills, corner radius, auto-layout padding/gap, size, position) |
| Output | `exportNode` (PNG, JPG, SVG, PDF → a file in the stage folder or a folder param) |
| Checks | `measure` (bounds, text that doesn't fit, layers outside a boundary → findings) |

Node references are an id, a name, a path (`Card/Title`), `page:<name>`, `$<id>` (an earlier result) or `$<id>.#<descendant>` (chainable), so one action list works on every copy it makes.

**Helpers in Doppl** (not in the plugin):
- **Barcodes:** EAN-13, EAN-8, UPC-A and Code 128 as SVG, with check-digit validation.
- **Data files:** CSV (papaparse; values stay text so leading zeros survive), JSON and XLSX, with errors per row.
- **Images:** read from a folder by name, with format and size checks.

### Photoshop helper library

Every Photoshop stage script runs as `function (doc, params, ctx)`:
- **`doc`:** a duplicate of the picked document, or null.
- **`ctx`:** `ctx.item`, `ctx.stages`, `ctx.output(key, value)`, `ctx.workDir`, `ctx.log` and more.

It can use these helpers:

| Helper | What it does |
| --- | --- |
| `openDocument(path)` | Reuses documents Doppl opened in this stage; if you have the file open, it works on a duplicate. |
| `findLayer(nameOrPath)` | Finds a layer by name or path. |
| `replaceSmartObject(layer, file)` | Replaces a Smart Object's contents (`placedLayerReplaceContents`). |
| `setTextLayer(layer, text)` | Sets text and reports missing fonts. |
| `setLayerVisible(layer, bool)` | Shows or hides a layer. |
| `exportImage(path, format, quality)` | Exports PNG, JPG or TIFF, only into picked folders or the stage folder. |
| `saveCopy(folder?)` | Saves a PSD copy named `_doppl.psd` that never overwrites anything; only when a stage asks to save. |
| `closeWithoutSaving(doc?)` | Closes a document; only documents Doppl opened. |

Documents stay open across a stage's items and are closed without saving when the stage ends. The script check refuses `doc.save`, `saveAs`, `close`, `app.open` and direct file writes, so routines go through these helpers.

## How a routine gets written

InDesign-only tasks use the single-script flow:
1. **Draft:** Muse Spark gets the request, the document summary, InDesign's scripting guide, two example routines and your house style. It may ask one question.
2. **Safety check:** the script is checked (syntax, unsupported or unsafe calls, fixed locations).
3. **Trial:** the routine runs on a hidden copy, so the preview and checks are real.
4. **Fixes:** problems go back to the model, up to twice.
5. **Review:** the model reviews the previews, and SAM checks key objects.

Tasks with Figma, Photoshop or several apps use stages. The model gets:
- each app's capability manifest: the Figma action catalog as JSON Schema with usage notes, and the Photoshop and InDesign guides with their helper libraries;
- inspections of the documents you picked;
- sample rows from attached data files;
- only file names from folders.

It works in turns, each one AI call. The Worker forwards structured JSON output but not native tool calls, so the tools are part of the answer schema:
- `inspect`: a deeper look at a document or node.
- `preview_stage`: runs a stage on one sample item in a scratch copy (a temporary Figma page that is deleted after; a Photoshop duplicate that is never saved) and returns results, errors and a preview image.
- `propose_routine`: Doppl validates it and runs a trial on the first sample item. Validation errors and trial errors go back to the model.
- `ask_question`: at most once, at the start.

At most 15 AI calls per creation (the Worker's limit). The creation screen shows the live count and what the AI tried. Saving and rerunning never call AI.

## Checks

Available to every routine's quality check (no AI):
- text that doesn't fit its box or frame (Figma `measure`; InDesign overset text);
- layers outside a boundary;
- missing images or data files;
- missing fonts and font styles;
- invalid barcode check digits;
- InDesign's preflight checks (links, resolution, bleed).

With **Automatic check + AI review** (own Meta key), the model also looks at each output, and routines can define object checks ("product is inside the label"), done with SAM. Each of these calls is counted.

## Run it (developers)

Requirements: macOS on Apple Silicon, Node **22.12+** (`nvm use` picks it up from `.nvmrc`).

```bash
nvm use
npm install
npm run dev        # builds the Figma plugin, then Next dev server + main-process watcher + Electron
```

```bash
npm test           # vitest: action schemas and interpreter (fake Figma), node references, placeholders, validator,
                   # stage handoff and partial failure, data files, barcodes, the Adobe bridge, the built plugin bundle
npm run typecheck  # main process, renderer and plugin
npm run dist       # unsigned .dmg and .app in release/
npm start          # production build, run without packaging
```

**Dev panel:** press **Cmd+Shift+D**. It has:
- a Figma action runner (paste an action list, optional sample item);
- a Photoshop script runner (with the helper library);
- a barcode tester;
- a routine builder (validate and save a routine by hand);
- a live connection log (AppleScript and WebSocket traffic: metadata only, never file contents).

Environment variables:
- `DOPPL_USER_DATA=/some/folder`: keep data elsewhere (handy for testing).
- `DOPPL_API_BASE_URL=http://127.0.0.1:8787`: use another Worker at run time (e.g. `wrangler dev`).
- `DOPPL_DEV_SERVER_URL`: set by `npm run dev`. Without it, Electron serves the static export through `app://doppl/`.

## Structure

```
electron/
  main.ts              window, app:// protocol (serves renderer/out), IPC wiring, data migration from "Doppel"
  preload.ts           contextBridge → window.doppel (typed by DoppelApi)
  ipc/                 handlers: window.doppel method → core service
  shared/
    figmaActions.ts    the Figma action catalog (zod), shared with the plugin
  core/
    types.ts           domain types + DoppelApi, shared with the renderer (import type only)
    config.ts          builds every service
    stages/            placeholders, validator, stage runner, readiness
    helpers/           barcodes, data files
    services/          routineService (creation loop, save), runService (runs, QC), qcService, modelAiService +
                       aiPrompts, aiTransport (demo Worker / Meta), aiAccessService + secretStore, figmaService,
                       devService, connectionLog, styleService, storage, settings, appStatus
  adapters/
    types.ts           DesignAppAdapter interface (incl. beginStage / runStageItem / endStage)
    adobe/             shared bridge: osascript via execFile, temp .jsx + JSON polyfill, status, lint
    indesign/          InDesign scripts, model guide, example routines
    photoshop/         Photoshop scripts, helper library, model guide, lint
    figma/             plugin connection (sessions), adapter, action preparation, REST (links), model guide
figma-plugin/          src/code.ts (sandbox), src/interpreter.ts (actions), src/ui.ts (window); built with esbuild
renderer/              Next.js (App Router, static export); app/dev is the hidden dev panel
tests/                 vitest
worker/                Cloudflare Worker for demo access codes (own package; see worker/README.md)
```

Data lives in `~/Library/Application Support/Doppl/`:
- **Routines:** `routines/<id>.json`, one per routine.
- **Runs:** `runs/<id>.json`, plus `runs/<id>/<stageId>/` for multi-app runs.
- **Settings and style:** `settings.json` and `style-profile.json`.
- **Secrets:** `secrets.json` (access code, Meta key, Figma token), encrypted with the Keychain.
- **Plugin:** `Figma plugin/`, the copy you import into Figma.

## Adding more

- **Another app:** implement `DesignAppAdapter` and register it in `core/config.ts`. That means status, documents, stages (`beginStage` / `runStageItem` / `endStage`), previews, checks and a capability manifest. The Connect screen, pickers, validator and creation flow pick it up from the registry.
- **Local model (Muse Glimmer):** `aiProvider` already has `"local"`. Add a transport that talks to Ollama / LM Studio and enable the option in Settings.

## Restyling

The UI is deliberately wireframe-grade:
- Visual styling lives only in `renderer/app/globals.css` (`.ui-*` classes and CSS variables).
- Components use Tailwind for layout only.
- Strings are in `renderer/copy.ts`.
- No component library, no theme.

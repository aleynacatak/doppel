# Doppl

> **Judges:** access codes for trying Doppl are in the project submission, under "Project Description" and "Describe your use of Meta products". Everyone else can use their own Meta API key (Settings → AI access).

Doppl learns your design routines and runs them in your own apps. Describe a task once; Meta's models turn it into a reusable routine you can rerun with no AI calls. A routine works in one app. A flow connects routines across apps: for example, labels made in Figma from a spreadsheet, then put on mockups in Photoshop.

**[Watch the 3-minute demo video](https://www.youtube.com/watch?v=qmbX_xrCovY)**

This repo holds:
- the desktop app (shadcn/ui, on the theme preset `b7BrAOFkW`);
- the Doppl Figma plugin ([`figma-plugin/`](figma-plugin/));
- [`worker/`](worker/README.md), the Cloudflare Worker that gives testers demo access to the AI.

There is no mock data and there are no sample routines: every app connection, AI call and check is real, and you create routines yourself with New task.

| Part | How |
| --- | --- |
| InDesign | AppleScript → ExtendScript on this Mac (shared Adobe bridge) |
| Photoshop | The same bridge; works on duplicates and never saves over your PSD |
| Figma | The Doppl plugin runs declarative action lists; files can also be connected by link (REST API) |
| Flows | Routines connected on a canvas: one routine's output files or rows feed the next, once per data row or file |
| AI (planning, writing, previews, fixing routines) | Muse Spark 1.3, with Muse Wonder 1.0 writing the code when trials keep failing, through the demo Worker (access code) or your own Meta API key |
| Checks | Each app's own rule checks; SAM 3.1 looks for cut-off objects during creation; optional visual review and object checks on reruns |
| Storage | JSON in `userData`; codes, keys and tokens encrypted with the macOS Keychain |

## Try it

You need a Mac with Apple Silicon or Intel (macOS 13 or later), at least one of InDesign, Photoshop or the Figma desktop app, and an access code or your own Meta API key.

1. Download the DMG for your Mac from [Releases](https://github.com/aleynacatak/doppel/releases/latest): `Doppl-<version>-arm64.dmg` for Apple Silicon, `Doppl-<version>-intel.dmg` for Intel. Apple menu → **About This Mac** shows which you have. Open it and drag Doppl to Applications.
2. Open Doppl. The first time, macOS stops it because the app isn't notarized:
   1. Click **Done**, not Move to Trash.

      <img src="https://github.com/aleynacatak/doppel/releases/download/v0.1.0/install-1-not-opened.png" width="302" alt="The &quot;Doppl&quot; Not Opened dialog, with Move to Trash and Done buttons">

   2. Go to System Settings → **Privacy & Security** and scroll down to **Security**. Next to "Doppl was blocked to protect your Mac", click **Open Anyway**.

      <img src="https://github.com/aleynacatak/doppel/releases/download/v0.1.0/install-2-open-anyway.png" width="600" alt="Privacy &amp; Security settings showing Doppl was blocked, with an Open Anyway button">

   3. In the dialog that appears, click **Open Anyway** and confirm with your password or Touch ID. After that, Doppl opens normally.

      <img src="https://github.com/aleynacatak/doppel/releases/download/v0.1.0/install-3-confirm.png" width="243" alt="The Open &quot;Doppl&quot;? dialog, with Move to Trash, Open Anyway and Done buttons">

3. If macOS asks for your password so Doppl can use "Doppl Safe Storage", type your Mac password and click **Always Allow**. This can happen after you install a new version, the first time Doppl needs a saved code, key or token.
4. **Connect your apps.** Doppl starts on this page; later, click **View** in the Apps card at the bottom of the sidebar.
   - **InDesign, Photoshop:** open them; Doppl connects on its own. The first time, macOS asks whether Doppl may control each app; click **OK**.
   - **Figma:** see [Figma setup](#figma-setup) below (about 3 minutes, once).
5. Go to **Settings → AI access**, paste your access code (`DOPPL-…`) and click **Check code**, or choose **My own Meta API key**.
6. **New task:**
   1. Describe what you want.
   2. Attach sample data (CSV, JSON or Excel) or folders if the routine uses them.
   3. Tick one app to make a routine, or several to make a flow, then click **Create routine**. For a flow, Doppl shows its plan first; click **Create these routines** to go on.
   4. Doppl tries the result on a sample, in scratch copies. Then **Save routine** → **Run**. A flow is saved once its last routine is made.

Reruns use 0 AI calls ([the exceptions](#what-a-rerun-costs)). With an access code, each routine counts as one creation, so a flow of three routines uses three.

Coming from "Doppel" (the earlier name)? Your routines, runs and settings are copied over on the first launch. The access code, API key and Figma token were encrypted under the old name, so enter them again once.

## Figma setup

Routines run inside Figma through the Doppl plugin, a development plugin you import once into the **Figma desktop app**.

1. In Doppl, on **Connect your apps**, click **Show plugin files** under Figma. Finder shows a `manifest.json`.
2. In Figma, open the main menu → **Plugins** → **Development** → **Import plugin from manifest…** and choose that `manifest.json`.
3. Open your file and run **Plugins** → **Development** → **Doppl**. The first time, type the **pairing code** shown in Doppl.

Keep the small Doppl window open in Figma while routines run. Each file with the plugin running shows up on **Connect your apps**; routines pick the file to work on. The window shows what it is doing and has a **Cancel** button.

**Optional: files by link.** With a Figma personal access token (scopes `file_content:read` and `current_user:read`), you can add file links: Doppl opens them in Figma with one click.

### How the plugin connects
- **Connection:** the plugin's window opens a WebSocket to Doppl at `ws://localhost:47810`. The port can be changed in Settings; Doppl then rewrites the plugin copy in its data folder, so import it again.
- **Handshake:** the plugin says hello with the file's name (and key), its version and the pairing code; Doppl answers with a session id. Several open files are several sessions, and messages are routed by session.
- **Who may connect:** Doppl listens on this Mac only and refuses web pages (they send a real `Origin`). It also requires the pairing code, because sandboxed web pages share the plugin window's origin `null`.
- **Reconnects and closing:** the window reconnects every 2 s. If it closes during a run, the run fails with a clear message instead of hanging.
- **Large payloads** (images, exports) travel in 512 KB chunks in both directions.
- **Time limit** (Settings → Script timeout, 120 s by default): it covers one step, not a whole job. Each step the plugin reports, and each chunk of a long answer, starts it again. A step that hangs still ends, and the error names it. Copying the page reports no steps, so the copy has one limit.

### Open questions (Figma's docs, checked October 2026)
- **`ws://` in `devAllowedDomains`:** the [manifest docs](https://developers.figma.com/docs/plugins/manifest/) list `ws`/`wss` as allowed schemes but show only `http(s)://localhost` examples for `devAllowedDomains`. Doppl declares `ws://localhost:<port>`. If a Figma version rejects it, the plugin window can't connect.
- **Wildcard ports:** the docs don't say whether they are allowed. That's why the port is written into the manifest copy.
- **Message sizes:** the docs give no size limit for `figma.ui.postMessage` or plugin WebSockets. Doppl chunks large messages anyway; between the plugin window and its code, messages pass whole.
- **`figma.fileKey`:** it's only for private plugins. Doppl sets `enablePrivatePluginApi` (which the docs say enables it during development) and falls back to matching files by name.
- **Images:** `figma.createImage` takes PNG, JPEG or GIF up to 4096 px. Doppl checks this before sending.

## Routines

A routine works in one app and declares what it takes and makes:

| Field | What it is |
| --- | --- |
| `inputs` | What it gets at each run, typed: `file`, `fileList`, `folder`, `rows` (from a CSV, JSON or Excel file, or another routine), `document` (open in the routine's app), `text`, `number`, `boolean`. |
| `outputs` | What it makes, typed the same way. The next routine takes them, or they're saved where you pick. |
| `settings` | Options that are set, not connected: text, number, boolean, select, formatList. |
| `iterate` | Optional: run once per item of a `rows` or `fileList` input. A second list input is paired with each item. |
| `kind` | Figma routines are `"actions"` (an action list); InDesign and Photoshop routines are `"script"` (ExtendScript). |

**Placeholders** in an action list are expanded per item, right before it runs:
- `{{inputs.<key>}}`; a data file also has `.rows` and `.columns`, and a folder has `.files`.
- `{{settings.<key>}}`.
- `{{item.<field>}}`: the data row, or for files `path`, `name`, `stem`, `ext`.
- `{{itemIndex}}`: 1-based.
- `{{matched.<input>}}`: the item of a second list that pairs with this one.

A value that is exactly one placeholder keeps its type. Scripts read the same values from `params` and `ctx`.

**Saving requires the validator to pass** (`electron/core/routines/contract.ts`):
- action lists match the catalog, and scripts pass the safety check;
- there are no absolute paths and no values copied from the sample data used while creating;
- the routine uses only what it declares and makes every output it declares;
- the routine runs in one app that Doppl has an adapter for.

Errors are structured (`path`, `code`, `message`), so the creation flow sends them back to the model.

**Versions:** every saved change is a new version, and earlier ones stay restorable. A flow pins the version it uses and shows when a newer one is available.

**Building blocks** are small, tested functions routines are built from: ExtendScript functions in the library added to every Photoshop and InDesign script, and named groups of actions in Figma. A routine version pins the block versions it uses, so its reruns stay the same. Blocks ship with Doppl, and new ones can grow from your own routines.

### Figma action catalog

Defined once with zod in [`electron/shared/figmaActions.ts`](electron/shared/figmaActions.ts). The same schemas:
- validate routines in Doppl;
- validate requests again in the plugin;
- become the JSON Schema the model gets.

No code strings run in Figma.

| Group | Actions |
| --- | --- |
| Reading | `getSelection`, `findNodes { query, within?, limit? }`, `inspectNode { node, depth }` |
| Structure | `createPage`, `duplicateNode`, `deleteNode`, `renameNode`, `arrangeInGrid` |
| Text | `setText` (loads every font first; missing fonts are reported, not fatal), `setTextStyleRanges` (by position or matching text) |
| Repetition | `repeatChild { container, templateChild, items, bindings }` for lists and tables |
| Media | `setImageFill` (from a picked folder by file name, or a file), `placeSvg` (SVG or a barcode, scaled and centered) |
| Properties | `setProperties` (visible, opacity, fills, corner radius, auto-layout padding/gap, size, position) |
| Output | `exportNode` (PNG, JPG, SVG, PDF → a file in the routine's working folder) |
| Checks | `measure` (bounds, text that doesn't fit, layers outside a boundary → findings) |

Node references are an id, a name, a path (`Card/Title`), `page:<name>`, `$<id>` (an earlier result) or `$<id>.#<descendant>` (chainable), so one action list works on every copy it makes.

**Helpers in Doppl** (not in the plugin):
- **Barcodes:** EAN-13, EAN-8, UPC-A and Code 128 as SVG, with check-digit validation.
- **Data files:** CSV (papaparse; values stay text so leading zeros survive), JSON and XLSX, with errors per row.
- **Images:** read from a folder by name, with format and size checks.

### Photoshop helper library

Every Photoshop script runs as `function (doc, params, ctx)`:
- **`doc`:** a working copy of the picked document, or null.
- **`params`:** every input and setting by key.
- **`ctx`:** `ctx.item`, `ctx.itemIndex`, `ctx.matched`, `ctx.output(key, value)`, `ctx.workDir`, `ctx.log` and more.

It can use these helpers:

| Helper | What it does |
| --- | --- |
| `openDocument(path)` | Reuses documents Doppl opened in this run; if you have the file open, it works on a duplicate. |
| `findLayer(nameOrPath)` | Finds a layer by name or path. |
| `replaceSmartObject(layer, file)` | Replaces a Smart Object's contents (`placedLayerReplaceContents`). |
| `setTextLayer(layer, text)` | Sets text and reports missing fonts. |
| `setLayerVisible(layer, bool)` | Shows or hides a layer. |
| `exportImage(path, format, quality)` | Exports PNG, JPG or TIFF, only into the routine's working folder. |
| `saveCopy(folder?, fileName?)` | Saves a PSD copy that never overwrites anything (by default `<name>_doppl.psd` next to the source). |
| `closeWithoutSaving(doc?)` | Closes a document; only documents Doppl opened. |
| `removeWhiteBackground(doc?, tolerance?)` | Makes a plain white background that touches the corners transparent; white inside the subject stays. |
| `maskWhiteBackground(layer?, options?)` | Hides a white background with an editable layer mask. |
| `maskSubject(layer?)` | Cuts out the main subject on any background with Photoshop's Select Subject, as an editable layer mask. No AI. Returns `{ bounds, kept }`, and flags a cutout that keeps under 10% or over 95% of the picture. |
| `cropToBounds(doc, bounds, padding?)` | Crops to pixel bounds. |
| `trimTransparent(doc?)` | Crops to the visible content. |
| `dominantColor(docOrPath, { ignoreWhite? })` | The most common color, ignoring transparent pixels: `{ hex, r, g, b, share }`. |
| `setSolidColor(layer, color)` | Sets a Solid Color fill layer's color (`"#RRGGBB"` or `{ r, g, b }`). |

Documents stay open across a routine's items and are closed without saving when it finishes. The script check refuses `doc.save`, `saveAs`, `close`, `app.open` and direct file writes, so routines go through these helpers.

## Flows

A flow connects routines on a canvas (**Library → Flows**): inputs you pick at each run, routines, and folders for the results. There are two ways to make one:
- tick several apps in **New task**: Doppl plans the routines, shows you the plan, creates each one in order and connects them;
- click **New flow** and connect routines you've already saved.

**Runs:**
- **Where it runs:** on a copy by default. InDesign saves `<name>_doppl.indd` next to your file, Figma duplicates the page, and Photoshop works on a duplicate. In InDesign and Figma you can choose to run on the original instead, and undo it with Cmd+Z.
- **Working folders:** each run gets `userData/runs/<runId>/<nodeId>/` per routine; files handed to later routines go there. Results go to a folder you pick.
- **Pairing:** a second list pairs with each item through the connection's rule: the same row, the file named in a column, matching columns or the same file name. You can also pick partners by hand.
- **Order and partial failure:** routines run in order and items one after another. A failed item (a data row with an empty required value, a wrong barcode check digit, a missing image) is recorded, the others go on, and later routines skip it. Results show both.
- **Readiness:** before a run, every routine's app must be connected with the right document; otherwise the Run screen says what to open.
- **Progress:** shown per routine and per item ("Figma · item 3 of 6"), with Cancel.

### What a rerun costs

No AI calls, with these exceptions:
- a data file's columns differ from what the routine expects and the rules can't place them: one small call before the run;
- you ask Doppl to suggest which file goes with an item that found none by name;
- you turn on **Automatic check + AI review** (needs your own Meta key): one call per output;
- you OK a fix.

### When a routine needs to change

- **Fixes:** when items fail because of the routine itself (not your files or an app), Doppl offers to fix it and waits for your OK; no AI is spent until you say so. A fix uses at most 5 AI calls and is tried on the failed items and one that worked. You read what changed, then keep it or discard it.
- **Refine:** describe a change to a saved routine. Doppl tries it on test items and shows the results before and after. Keeping it saves a new version.
- **Repair with AI:** when a routine doesn't fit new content, Doppl can rewrite it for that content. That uses a few AI calls; later reruns still use 0.

## How a routine gets written

Every app uses the same creation loop. The model gets:
- the app's capability manifest: the Figma action catalog as JSON Schema with usage notes, and the Photoshop and InDesign guides with their building blocks;
- inspections of the documents you picked (for InDesign, with their text);
- sample rows from attached data files;
- the text of an attached InDesign template;
- only file names from folders (and the columns of data files in them).

The model reads the request first. When the work may need files it hasn't got, it asks for them before it plans anything, and you can go on without them. If it proposes a routine anyway, Doppl asks for the missing files before the code is written. Either way the model sees what they hold, so the routine fits what's really in the file. That can add one AI call.

It works in turns, each one AI call. The Worker forwards structured JSON output but not native tool calls, so the tools are part of the answer schema:
- `ask_for_files`: only at the start, when the work may need files the model hasn't got.
- `inspect`: a deeper look at a document or node.
- `preview_routine`: runs a draft on one sample item in a scratch copy (a temporary Figma page that is deleted after, a Photoshop duplicate that is never saved, a hidden InDesign copy) and returns results, errors and a preview image.
- `propose_routine`: Doppl validates it and runs a trial on a sample item. Validation errors and trial errors go back to the model.
- `ask_question`: only at the start, when a wrong guess would make the routine useless.
- `decline`: only at the start, when the request isn't design work to automate.
- `search_helpers`, `get_helper_docs`: find building blocks and read their docs.

**Trials stay short.** A routine that iterates is tried on one item. A new Figma routine also makes only the first and last export of each kind (same output, format and scale); for the others it only checks that the node exists. The result screen says how many it tried, and the routine itself keeps every export. Changing or fixing a routine tries all of them, since the change may be about any of them.

**Review:** the model looks at the trial's previews and SAM looks for key objects that are cut off. What the model finds goes back to be fixed once, if there's room; what SAM finds is flagged for you.

At most 15 AI calls per routine (the Worker's limit). The creation screen shows the live count and what the AI tried. Saving never calls AI.

After two failed trials of one routine, Muse Wonder writes its code for the rest of that creation (`escalation` in `electron/ai/roles.json`); Muse Spark keeps planning. You can't pick Wonder in Settings because it's only a backup (`backupOnly` in `electron/ai/models.json`). It costs more per token ($4 in and $20 out per million tokens, against Spark's $1.25 and $4.25), and most routines never need it. On the list, a single choice could raise the cost of every creation, on your own key or against the demo's spending cap, so Doppl calls it only when Spark keeps failing. If it can't answer (no access to it, an outage), Spark carries on. A model picked by hand for writing code stays, and the routine's Details show which models served each role.

## Checks

Available to every routine's quality check (no AI), depending on the app:
- text that doesn't fit its box or frame, or runs off the page;
- layers outside a boundary;
- missing images or data files;
- fonts that are missing or don't have every letter, and missing font styles;
- images shown larger than their pixels (Figma);
- images that don't reach the bleed, and links that are missing or out of date (InDesign);
- a Photoshop cutout that keeps under 10% or over 95% of the picture (listed only when it happens);
- invalid barcode check digits.

With **Automatic check + AI review** (own Meta key), the model also looks at each output, and routines can define object checks ("product is inside the label"), done with SAM. Each of these calls is counted.

## Known limits

- **Figma routines have no loop over frames.** They iterate over rows or files. Without those, a routine that exports many frames names each one, often by node id, so it's tied to that file and won't pick up frames you add later.
- **The first full run can find what a trial didn't,** since a trial covers a sample.
- **The script check reads the script's text.** It guards against mistakes; it isn't a sandbox, and scripts run with your rights in InDesign and Photoshop.
- **macOS only,** and the app isn't notarized. The Intel version has only been opened under Rosetta, not tried on a real Intel Mac.

See [ROADMAP.md](ROADMAP.md) for what may come later.

## Run it (developers)

Requirements: macOS on Apple Silicon, Node **22.12+** (`nvm use` picks it up from `.nvmrc`).

```bash
nvm use
npm install
npm run dev        # builds the Figma plugin, then Next dev server + main-process watcher + Electron
```

```bash
npm test           # vitest: action schemas and interpreter (fake Figma), placeholders, validator, flow runs and
                   # partial failure, creation with a scripted AI, data files, barcodes, the Adobe bridge, the plugin bundle
npm run typecheck  # main process, renderer and plugin
npm run dist       # unsigned .dmg and .app in release/
npx electron-builder --mac dmg:x64  # the same for Intel, after npm run build
npm start          # production build, run without packaging
npm run eval       # real creations with real AI and apps; spends AI access (see evals/README.md)
```

**Dev panel:** press **Cmd+Shift+D**. It has:
- a Figma action runner (paste an action list, optional sample item);
- a Photoshop script runner (with the helper library);
- a barcode tester;
- a flow runner;
- a routine builder (validate and save a routine by hand), and export as starter;
- the AI's answers from the last creation;
- a live connection log (AppleScript and WebSocket traffic: metadata only, never file contents);
- the building blocks and their tests.

Environment variables:
- `DOPPL_USER_DATA=/some/folder`: keep data elsewhere (handy for testing).
- `DOPPL_API_BASE_URL=http://127.0.0.1:8787`: use another Worker at run time (e.g. `wrangler dev`).
- `DOPPL_SIMULATE_APPS=1`: simulate every app, so screens can be tried without touching the real ones.
- `DOPPL_DEV_SERVER_URL`: set by `npm run dev`. Without it, Electron serves the static export through `app://doppl/`.

## Structure

```
electron/
  main.ts              window, app:// protocol (serves renderer/out), IPC wiring, data migration from "Doppel"
  preload.ts           contextBridge → window.doppel (typed by DoppelApi)
  ipc/                 handlers: window.doppel method → core service
  ai/                  models.json, roles.json: which model serves each role
  shared/
    figmaActions.ts    the Figma action catalog (zod), shared with the plugin
    flowGraph.ts       flow order and layout; ports.ts, names.ts, routineDiff.ts
  core/
    types.ts           domain types + DoppelApi, shared with the renderer (import type only)
    config.ts          builds every service
    routines/          contract (the validator), placeholders, the model's answers, trial sampling
    flows/             flow and node runners, pairing, readiness, failure causes
    inputs/            checks on your files before creating and running
    blocks/            building blocks: registry, selection, tests, candidates
    ai/                gateway, providers, model registry
    helpers/           barcodes, data files, image info
    services/          routineService (creation loop, refine, repair), runService (runs, QC), flowService,
                       autoFixService, libraryService, qcService, modelAiService + aiPrompts, aiTransport (demo Worker /
                       Meta), aiAccessService + secretStore, figmaService, devService, connectionLog, storage, settings,
                       appStatus
  adapters/
    types.ts           DesignAppAdapter interface (incl. beginStage / runStageItem / endStage)
    adobe/             shared bridge: osascript via execFile, temp .jsx + JSON polyfill, status, lint
    indesign/          InDesign scripts, helper library, model guide
    photoshop/         Photoshop scripts, helper library, model guide, lint
    figma/             plugin connection (sessions), adapter, action preparation, blocks, REST (links), model guide
  evals/               the evals' runner and checks
evals/                 eval tasks, fixtures and reports
figma-plugin/          src/code.ts (sandbox), src/interpreter.ts (actions), src/ui.ts (window); built with esbuild
renderer/              Next.js (App Router, static export); app/dev is the hidden dev panel
tests/                 vitest
worker/                Cloudflare Worker for demo access codes (own package; see worker/README.md)
```

Data lives in `~/Library/Application Support/Doppl/`:
- **Routines:** `routines/<id>.json`, one per routine, and `routine-versions/` for earlier versions.
- **Flows:** `flows/<id>.json`.
- **Runs:** `runs/<id>.json`, plus `runs/<id>/<nodeId>/` for each routine's files.
- **Building blocks:** `helpers/`.
- **Settings:** `settings.json`.
- **Secrets:** `secrets.json` (access code, Meta key, Figma token), encrypted with the Keychain.
- **Plugin:** `Figma plugin/`, the copy you import into Figma.

## Adding more

- **Another app:** implement `DesignAppAdapter` and register it in `core/config.ts`. That means status, documents, stages (`beginStage` / `runStageItem` / `endStage`), previews, checks and a capability manifest. The Connect screen, pickers, validator and creation flow pick it up from the registry.
- **Local model (Muse Glimmer):** `aiProvider` already has `"local"`. Add a transport that talks to Ollama / LM Studio and enable the option in Settings.

## Restyling

The UI uses [shadcn/ui](https://ui.shadcn.com) with the theme preset `b7BrAOFkW`, and nothing styled beyond it for now.
- `renderer/components/ui/` holds the shadcn components (style `base-maia`, built on Base UI; settings in `renderer/components.json`). The font is Inter, packaged with the app so nothing is fetched from Google.
- `renderer/components/common/` holds Doppl's small wrappers around them, such as notices, tags, fields and page headers.
- The theme is CSS variables in `renderer/app/globals.css`, which also holds the flow canvas's own `.ui-flow*` styles. Everything else uses Tailwind.
- Strings are in `renderer/copy.ts`.

## License

Copyright (C) 2026 Aleyna Catak. Doppl is licensed under the [GNU Affero General Public License v3.0](LICENSE).

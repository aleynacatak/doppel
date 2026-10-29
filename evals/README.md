# Doppl evals

Measures how well Doppl creates routines. Each attempt runs the real creation loop (real AI, real apps), saves the
routine, reruns it on the task's fixtures without AI, and checks the outputs. An attempt passes only when the
creation succeeds **and** every check passes on the rerun.

## Run

Open the apps the tasks need first (Photoshop, InDesign; Figma tasks marked `"mode": "simulated"` don't need Figma).

```bash
npm run eval -- --profile spark-current,spark-fixed --tasks all --repeat 3
```

- `--profile`: one or more ids from `profiles.json` (several give a comparison table).
- `--tasks`: `all`, or a comma list of task ids and tags.
- `--repeat`: attempts per task and profile.
- `--note "…"`: a line for the report's notes.

AI access is the one saved in Doppl (Settings → AI access). The first run asks macOS to allow access to "Doppl Safe
Storage" and to control the apps: allow both. To skip the Keychain, set `DOPPL_EVAL_ACCESS_CODE` (demo code) or
`DOPPL_EVAL_META_KEY` (own key) for the command. With demo access, each attempt uses one demo creation.

Reports go to `reports/<date>-<profile>.md` and `.csv` (and `<date>-compare-….md` with several profiles): pass rate,
failure category (validation, script-error, trial-failed, check-failed, call-limit, declined, ai-error, needs-input,
timeout), AI calls, tokens, estimated cost, wall time, previews, proposals, the size of the capability context, and
AI calls during the rerun (always 0). Work folders stay in the temp folder (printed at the end); each attempt's
folder has its outputs, `transcript.json` (the creation's conversation) and `ai-calls.json` (every raw AI answer: role,
reasoning effort, why it ended, tokens, text). An attempt that stops on AI access (no creations left, a key problem)
ends the run; a rate-limited one waits a minute and runs again.

## Tasks

`tasks/<id>/task.json` plus a `fixtures/` folder:

```json
{
  "id": "ps-cutout-white-bg",
  "app": "photoshop",
  "request": "Remove the white background from each product image and save transparent PNGs.",
  "attachments": { "inputs": { "images": "fixtures/images" } },
  "checks": [
    { "type": "outputCount", "port": "pngs", "equals": "inputCount:images" },
    { "type": "hasTransparency", "port": "pngs" }
  ],
  "tags": ["photoshop", "masking"]
}
```

- `attachments.inputs`: name → file or folder; folders and files go to the creation as references, and are mapped onto
  the saved routine's inputs for the rerun (by name, then by kind: data file → rows, folder → file list).
- `"mode": "simulated"`: the AI loop is real, the app is simulated (no app needed); `attachments.inspection` is a JSON
  file the model gets when it inspects the document.
- `port` names a routine output loosely: its key, its label, the file type a check asks for, or the only file output.

Checks: `outputCount` (`equals`: a number or `"inputCount:<input>"`: files in that attachment or its data rows),
`fileExtension` (`is`), `imageSize` (`width`, `height`, `maxWidth`, `maxHeight`, `tolerance`; or `scaleOf` +
`scale`), `hasTransparency`, `cornerPixelsTransparent` (only for subjects that don't fill their trimmed canvas),
`outerWhiteRemoved` (`maxShare`, default 0.01: the rough work of a cutout, white around the subject gone; white
enclosed by it may stay), `noOpaqueWhite` (`maxShare`, default 0.02: stricter, white left anywhere, also inside enclosed
areas), `textContains` (`text`, in output details or text files),
`fileNamePattern` (`pattern` regex and/or `stemsFrom: "<input>"`), `noRunErrors`.

`node evals/make-fixtures.mjs` redraws the synthetic fixtures of the sample tasks.

## Profiles

`profiles.json`: a named model and creation setup.

- `roles`: role → model profile (`planner`, `coder`, `reviewer`, `segmenter`; a registry model id and `reasoningEffort`).
- `creation`:
  - `codeFormat`: `"separate"` (code in its own plain-text answer) or `"inline"` (inside the JSON, as before);
  - `planField`: the plan is written first;
  - `workedExamples`: the app guides include worked examples;
  - `helperDocs`: `"full"` helper catalog, or `"index"` (ranked index plus `search_helpers` / `get_helper_docs`).

`spark-current` reproduces Doppl before the code-quality fixes; `spark-fixed` adds them; `spark-blocks` is the current
default with building blocks retrieved on demand.

## Building block tests

```bash
npm run test:helpers
```

Runs every built-in building block's tests in the open apps (others are skipped). Add `--app photoshop`,
`--ids ps.maskWhiteBackground`, `--all-versions` or `--include-mine`.

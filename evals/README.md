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
- `--variants all` (or ids: `names`, `squashed`, `spreadsheet`, `stray`, `everything`): after a routine passes, rerun
  it on messy versions of its fixtures (no AI): the same files renamed (other case and separators, one-word names,
  copy and version suffixes), data saved the way Excel in Turkish saves it (semicolons, UTF-16, uppercase headers,
  blank rows), extra files in the folders. The report adds a "Messy versions" column and section.

A messy copy of your own files, to try Doppl on them (for example in a demo), without running an eval:

```bash
npm run eval -- --messy path/to/products.csv --messy "path/to/flavor pics" --variant everything --out ~/Desktop/messy
```

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
areas), `colorAt` (`x`, `y` as fractions, `expect`: output name → RGB, `tolerance`: each output named after an item
has its color there, e.g. the right picture; JPEGs are read through macOS's sips), `outputNames` (`names`, `only`),
`textContains` (`text`, in output details or text files),
`fileNamePattern` (`pattern` regex and/or `stemsFrom: "<input>"`), `noRunErrors` (`allow`: a regex for expected
errors, like items the designer chose to skip).

Checks on the creation itself: `askedAbout` (`pattern`, `kind`: `"inputs"` for Doppl's own questions about the
attached files, `"ai"` for the AI's), `noQuestions` (`kind`: the inputs were clear, so nothing should be asked), and
`pairedWith` (`pairs`: item name → the partner file it should get, or null when it should be skipped; simulated apps
report each output's partner).

`answers` says how the designer answers: `[{ "question": "<regex>", "choose": "<regex for the option's label or
id>" }]`. Without a matching rule, the recommended (first) option is picked. The report lists every question and
answer.

The tasks cover different setups on purpose, from clear to error-prone: a list and pictures named loosely, in mixed
formats, with a row that has no picture and a stray picture (`figma-flavor-labels-sim`, `ps-flavor-cards`); the same
named exactly, where nothing should be asked (`figma-flavor-labels-clean-sim`); two folders, photos and a logo
(`ps-logo-two-folders`); cutouts, resizing and text fills. Add tasks for setups designers get wrong: they're cheap as
`"mode": "simulated"`.

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

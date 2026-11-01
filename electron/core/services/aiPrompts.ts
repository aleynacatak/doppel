import type { DesignAppAdapter, RoutineTemplate } from "../../adapters/types";
import { paramsToContract } from "../routines/legacy";
import type { AppId, FlowPlanRoutine } from "../types";

// Prompts and structured-output schemas for Muse Spark (response_format json_schema, not strict).
//
// Meta's structured output makes the model write the fields of every object the schema defines in alphabetical
// order; a field it reaches too late comes out under a mangled name ("actions_O"). So: the schemas define only
// the answer's top-level fields, the examples list them alphabetically, and the routine and plan are free
// objects (their fields can come in the order that reads naturally). Doppl's validators check their structure.

/** Which column of a file holds each column a routine expects. Fields in alphabetical order (see the top of this file). */
export const COLUMNS_SCHEMA = {
  type: "object",
  properties: {
    pairs: {
      type: "array",
      items: {
        type: "object",
        properties: { column: { type: "string", description: "The file's column, exactly as written, or \"\" when none holds it" }, expected: { type: "string" } },
        required: ["column", "expected"],
      },
    },
  },
  required: ["pairs"],
};

export const COLUMNS_SYSTEM = `A design routine reads columns of a data file by name, and a designer picked a file whose columns are
named differently: another language, abbreviations, other words ("Ürün Adı" for "Flavor", "Fiyat" for "Price"). For
each expected column, give the file's column that holds the same information, judging by the names, the routine and
the sample values. Use "" when no column holds it; don't guess. Never give one file column for two expected columns.`;

export const FILES_SCHEMA = {
  type: "object",
  properties: {
    pairs: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string", description: "One of the files, exactly as written, or \"\" when none goes with the item" }, item: { type: "string" } },
        required: ["file", "item"],
      },
    },
  },
  required: ["pairs"],
};

export const FILES_SYSTEM = `A design routine pairs each item (a row of a data file, or a file) with one of a designer's files by name,
and some items found no file because the names are written differently: squashed, in another word order, abbreviated,
another language, typos ("pearcaramelsalt.png" for "Salted Caramel Pear"). For each item, give the file that is clearly
meant for it. Some files come with their picture ("Picture of IMG_4032.jpg:"): when its name says nothing, go by what the
picture clearly shows (a pear and caramel jam for "Salted Caramel Pear"). Use "" when neither the name nor a picture
says; don't guess. Never give one file to two items.`;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: { type: "object", properties: { outputId: { type: "string" }, reason: { type: "string" } }, required: ["outputId", "reason"] },
    },
    passed: { type: "boolean" },
  },
  required: ["issues", "passed"],
};

export const REVIEW_SYSTEM = `You check the result of a design automation for a designer. You get the request and one image
per output. Flag only clear problems a designer would fix before sending the files: important objects cut off at an
edge, text overflowing or overlapping images, empty or blank outputs, a result that doesn't match the request.
Write each reason as one short sentence in plain language, e.g. "Product is cut off at the right edge".
Transparent areas are shown on a dark gray checkerboard: white specks, patches or a white fringe on it are background
that wasn't removed, a problem when the request asks for a cut-out or a removed background.
Answer with JSON only, matching the schema. Use the output ids you were given. Write "issues" before "passed".`;

const QUESTION_FIELD = {
  type: "object",
  description: 'ask_question: {"options":[{"id":"a","label":"…"},…],"text":"…"}',
};

/** One turn while creating a routine. Fields are listed (and must be written) in alphabetical order. */
export const ROUTINE_TURN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["ask_question", "decline", "inspect", "preview_routine", "propose_routine"] },
    app: { type: "string" },
    depth: { type: "number" },
    document: { type: "string" },
    nodes: { type: "array", items: { type: "string" }, description: "inspect: layers by name, path or id" },
    question: QUESTION_FIELD,
    reason: { type: "string", description: "One short sentence for the designer: what you are doing (decline: why)" },
    routine: { type: "object", description: "preview_routine, propose_routine: the complete routine (see the format)" },
    sampleItemIndex: { type: "number" },
  },
  required: ["action"],
};

/** One turn while refining an existing routine. Fields are listed (and must be written) in alphabetical order. */
export const REVISION_TURN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["ask_question", "decline", "inspect", "preview_routine", "propose_revision"] },
    app: { type: "string" },
    changeSummary: { type: "string", description: "propose_revision: one sentence for the designer: what changed" },
    depth: { type: "number" },
    document: { type: "string" },
    nodes: { type: "array", items: { type: "string" }, description: "inspect: layers by name, path or id" },
    question: QUESTION_FIELD,
    reason: { type: "string", description: "One short sentence for the designer: what you are doing (decline: why)" },
    routine: { type: "object", description: "preview_routine, propose_revision: the complete revised routine (see the format)" },
    sampleItemIndex: { type: "number" },
  },
  required: ["action"],
};

/**
 * How a routine turn is written:
 * - codeFormat "inline": the code inside the JSON answer, as a string (before the code-quality fixes);
 *   "separate": the JSON carries "@code:1" and the code comes as plain text in a second answer.
 * - planField: a "plan" field written first (what the routine does, which helpers, edge cases).
 */
export interface TurnFormat {
  codeFormat: "inline" | "separate";
  planField: boolean;
  /** The guide has an index of building blocks: the model can search them and ask for their docs. */
  helperTools?: boolean;
}

export const LEGACY_TURN_FORMAT: TurnFormat = { codeFormat: "inline", planField: false };

const PLAN_FIELD = {
  type: "string",
  description:
    "Write this first, 2–4 short sentences: what the routine will do, which helpers it uses, and which edge cases it handles (inspect, ask_question: what you want to learn).",
};

/** The schema of a creation or refine turn in the given format (canonical field names; see orderFields). */
export function routineTurnSchema(revision: boolean, format: TurnFormat): Record<string, unknown> {
  const base = (revision ? REVISION_TURN_SCHEMA : ROUTINE_TURN_SCHEMA) as { properties: Record<string, unknown>; required: string[] };
  const properties: Record<string, unknown> = { ...(format.planField ? { plan: PLAN_FIELD } : {}), ...base.properties };
  if (format.helperTools) {
    const action = properties.action as { type: string; enum: string[] };
    properties.action = { ...action, enum: [...action.enum, "get_helper_docs", "search_helpers"].sort() };
    properties.ids = { type: "array", items: { type: "string" }, description: "get_helper_docs: building block ids" };
    properties.query = { type: "string", description: "search_helpers: what the block should do" };
  }
  if (format.codeFormat === "separate") {
    properties.routine = {
      type: "object",
      description: `preview_routine, ${revision ? "propose_revision" : "propose_routine"}: the complete ${revision ? "revised " : ""}routine (see the format) with "@code:1" as its "script" (Figma: "actions"); Doppl asks for the code next`,
    };
  }
  return { type: "object", properties, required: format.planField ? ["plan", ...base.required] : base.required };
}

/** One turn while planning a flow. Fields are listed (and must be written) in alphabetical order. */
export const PLAN_TURN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["ask_question", "decline", "inspect", "propose_plan"] },
    app: { type: "string" },
    depth: { type: "number" },
    document: { type: "string" },
    nodes: { type: "array", items: { type: "string" }, description: "inspect: layers by name, path or id" },
    plan: { type: "object", description: "propose_plan: the complete plan (see the format)" },
    question: QUESTION_FIELD,
    reason: { type: "string", description: "One short sentence for the designer: what you are doing (decline: why)" },
  },
  required: ["action"],
};

/** The shape of a routine, per kind of app (shown to the model; checked by tests/promptExample.test.ts). */
export const ROUTINE_FORMAT_EXAMPLES: Record<"figma" | "photoshop" | "indesign", Record<string, unknown>> = {
  figma: {
    name: "Fill product cards",
    description: "Fills a copy of the Card frame for every product and exports it as a PNG.",
    app: "figma",
    inputs: [
      { key: "file", label: "Figma file", type: "document", required: true },
      { key: "products", label: "Products", type: "rows", required: true, columns: ["title", "photo"] },
      { key: "photos", label: "Product photos", type: "fileList", required: true, extensions: ["png", "jpg"] },
    ],
    settings: [{ key: "scale", label: "Export scale", type: "number", required: false, default: 2 }],
    iterate: { input: "products" },
    outputs: [{ key: "cards", label: "Cards", type: "fileList", required: true, extensions: ["png"] }],
    steps: ["Copies the Card frame for each product", "Fills in its title and photo", "Exports each card as a PNG"],
    modifiesDocument: true,
    qcProfile: "web",
    keyObjects: [],
    actions: JSON.stringify([
      { action: "duplicateNode", id: "card", node: "Card" },
      { action: "setText", node: "$card.#Title", text: "{{item.title}}" },
      { action: "setImageFill", node: "$card.#Photo", image: { file: "{{matched.photos}}" } },
      { action: "exportNode", node: "$card", format: "PNG", scale: "{{settings.scale}}", fileName: "{{item.title}}", output: "cards" },
    ]),
  },
  photoshop: {
    name: "Cut out product photos",
    description: "Removes the white background of every photo and saves it as a PNG.",
    app: "photoshop",
    inputs: [{ key: "photos", label: "Product photos", type: "fileList", required: true, extensions: ["jpg", "png"] }],
    settings: [{ key: "tolerance", label: "Background tolerance", type: "number", required: false, default: 24 }],
    iterate: { input: "photos" },
    outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
    steps: ["Opens each photo", "Removes the white background", "Saves it as a PNG"],
    modifiesDocument: false,
    qcProfile: "web",
    keyObjects: ["product"],
    script:
      'var img = openDocument(ctx.item.path);\nremoveWhiteBackground(img, params.tolerance);\ntrimTransparent(img);\nctx.output("cutouts", exportImage(ctx.join(ctx.workDir, ctx.item.stem + ".png"), "png"));',
  },
  indesign: {
    name: "Export print PDF",
    description: "Exports the open document as a PDF with the chosen preset.",
    app: "indesign",
    inputs: [{ key: "document", label: "Document", type: "document", required: true }],
    settings: [{ key: "preset", label: "PDF preset", type: "select", required: true, optionsSource: "pdfExportPresets" }],
    outputs: [{ key: "pdf", label: "PDF", type: "file", required: true, extensions: ["pdf"] }],
    steps: ["Exports the whole document as a PDF", "Uses the PDF preset you pick"],
    modifiesDocument: false,
    qcProfile: "print",
    keyObjects: [],
    script:
      'var file = ctx.exportPdf(doc, ctx.workDir + "/" + ctx.safeFileName(ctx.docName) + ".pdf", { preset: params.preset });\nctx.output({ key: "pdf", label: file.displayName, filePath: file.fsName });',
  },
};

/** The shape of a flow plan (shown to the model; checked by tests/promptExample.test.ts). */
export const PLAN_FORMAT_EXAMPLE = {
  name: "Product labels",
  description: "Cuts out the product photos, then fills a label per product.",
  inputs: [
    { key: "products", label: "Product data", type: "rows", required: true, columns: ["title", "photo"] },
    { key: "photos", label: "Product photos", type: "fileList", required: true, extensions: ["jpg"] },
  ],
  routines: [
    {
      id: "cutouts",
      name: "Cut out photos",
      app: "photoshop",
      purpose: "Removes the white background of each photo.",
      inputs: [{ key: "photos", label: "Photos", type: "fileList", required: true, extensions: ["jpg"] }],
      iterate: { input: "photos" },
      outputs: [{ key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] }],
    },
    {
      id: "labels",
      name: "Fill labels",
      app: "figma",
      purpose: "Fills a copy of the label frame per product with its title and cutout, and exports it.",
      inputs: [
        { key: "file", label: "Figma file", type: "document", required: true },
        { key: "products", label: "Products", type: "rows", required: true, columns: ["title", "photo"] },
        { key: "cutouts", label: "Cutouts", type: "fileList", required: true, extensions: ["png"] },
      ],
      iterate: { input: "products" },
      outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true, extensions: ["png"] }],
    },
  ],
  connections: [
    { from: "input.photos", to: "cutouts.photos" },
    { from: "input.products", to: "labels.products" },
    { from: "cutouts.cutouts", to: "labels.cutouts", match: { by: "fileNameEqualsColumn", column: "photo", ignoreExtension: true } },
    { from: "labels.labels", to: "output.labels" },
  ],
  outputs: [{ key: "labels", label: "Labels", type: "fileList", required: true }],
};

/** What each app's routines can do, for planning (the full guides come when each routine is written). */
const APP_ABILITIES: Record<string, string> = {
  figma:
    "Figma: works on a Figma file open with the Doppl plugin, with an action list: duplicate template frames, set texts, images, colors and barcodes from data, arrange, export frames as PNG, JPG, SVG or PDF.",
  photoshop:
    "Photoshop: scripts on images and PSDs: open images, cut out subjects on white or any other background, trim, replace Smart Objects, set text layers, find dominant colors, export PNG, JPG or TIFF, save PSD copies. Never changes the designer's PSD.",
  indesign: "InDesign: scripts on an open InDesign document: place text and images, apply styles, add pages, preflight, export PDF or PNG pages.",
};

const APP_NAMES: Record<string, string> = { indesign: "InDesign", figma: "Figma", photoshop: "Photoshop" };
const appName = (id: AppId) => APP_NAMES[id] ?? id;

const CONTRACT_RULES = `A routine declares its contract:
- inputs: what it gets at each run, each { key, label, type, required }. Types: file (one file; give "extensions",
  e.g. ["psd"]), fileList (several files; "extensions"), folder, rows (data rows from a CSV, JSON or Excel file, or
  from another routine; give the "columns" it uses), document (a document open in the routine's app, picked when it
  runs; at most one), text, number, boolean.
- outputs: what it produces, typed the same way (usually fileList with "extensions", or rows). Output files go into
  the routine's working folder (ctx.workDir; Figma: exportNode). Doppl hands them to the next routine, or saves them
  where the designer picks. Don't add an output folder as an input.
- settings: options that are set, not connected, each { key, label, type, required, default }: text, number,
  boolean, select (with "options" [{ value, label }] or "optionsSource"), formatList (with "options").
- iterate: { "input": "<key>" } runs the routine once per item of a rows or fileList input; its outputs are
  collected over the items. A second rows or fileList input of an iterating routine is paired with each item by
  Doppl (the file named in the row, the same row); read the partner with {{matched.<input>}} (Figma) or
  ctx.matched.<input> (scripts).
Keys are identifiers (letters, digits, _), unique across inputs and settings. Use only what you declare, and produce
every output you declare.`;

function answerFormat(fields: string[]) {
  return `Answer with ONE JSON object per turn. Write its fields in alphabetical order (${fields.join(", ")}), leaving out
the ones you don't use: Doppl's AI service only accepts them in that order.`;
}

/** The answer-format line for a routine turn: fields as the model sees them, the plan first. */
function routineAnswerFormat(fields: string[], planKey?: string) {
  if (!planKey) return answerFormat(fields);
  return `Answer with ONE JSON object per turn, fields in this order: ${fields.join(", ")} (leave out the ones you don't use).
Always start with "${planKey}": think the routine through before writing anything else.`;
}

/** Real InDesign routines as examples of how InDesign scripts are written (their params as inputs and settings). */
function indesignExamples(examples: RoutineTemplate[]) {
  if (!examples.length) return "";
  return `\nWorking InDesign scripts for reference:\n${examples
    .map((t) => {
      const c = paramsToContract(t.params, "indesign");
      return `### ${t.name}\ninputs: ${JSON.stringify(c.inputs)}\nsettings: ${JSON.stringify(c.settings)}\nscript:\n${t.script}`;
    })
    .join("\n\n")}`;
}

const HELPER_TOOLS = `- "search_helpers": finds building blocks by what they should do ("query"); "get_helper_docs": the full docs of
  blocks by id ("ids"). The guide lists every block in one line; use them instead of writing that code yourself.
`;

const CREATE_ACTIONS = (maxTurns: number, planKey?: string, tools = false) => `"action" is one of:${tools ? `\n${HELPER_TOOLS.trimEnd()}` : ""}
- "inspect": a deeper look at the document: app, document (its id below), nodes (layers by name, path or id, several
  at once) and depth. At most 3 inspections in total; the document below already includes its structure.
- "preview_routine": runs your draft "routine" once on one sample item (sampleItemIndex, 0-based) in a scratch copy
  (Figma: a temporary page; Photoshop: never saved; InDesign: a hidden copy). You get results, errors and a preview.
- "propose_routine": the complete "routine". Doppl validates it (contract, action schemas or script checks, no
  absolute paths, no values copied from the sample data) and runs it once on a sample item (one that has its
  partners). Problems come back to you; fix them and propose again.
- "ask_question": one "question" with 2–4 short options, the best first, only when a wrong guess would make the
  routine useless, and only as your first answer (a second question right after, only when the designer's answer
  left it open). The designer can also answer in their own words. Designers aren't technical and often leave out something that
  matters (which file belongs to which row, what to do when something is missing, the size or format they need):
  ask about that in plain words, without jargon. Don't ask what "Inputs Doppl checked" already settles.
- "decline": only as your first answer, when the request isn't design work to automate in the app (a greeting, a
  question, small talk, nothing to make or change). In "reason", say so in one plain sentence. Never invent a task.
Examples of answers:
{${planKey ? `"${planKey}":"See which layers the card has.",` : ""}"action":"inspect","app":"<app>","depth":3,"document":"<document id>","nodes":["Card"],"reason":"Look at the card template"}
{${planKey ? `"${planKey}":"Duplicates the card per row, fills title and photo with the helpers, exports PNG; rows without a photo fail with a clear error.",` : ""}"action":"propose_routine","reason":"Propose the routine","routine":{…}}
You have at most ${maxTurns} answers; every reply from Doppl starts with how many are left. Propose a complete routine
early (by your 2nd or 3rd answer) and improve it from the feedback.`;

const REVISION_ACTIONS = (maxTurns: number, planKey?: string, tools = false) => `${tools ? HELPER_TOOLS : ""}You are changing an EXISTING routine that the designer already uses. Make the smallest change that
does what they ask; keep everything else as it is (inputs, outputs, settings, steps and code that still apply). Don't
rename inputs, outputs or settings (their keys or labels) unless asked: flows connect to them. Update the steps so
they describe the routine after the change.
"action" is one of:
- "inspect": a deeper look at the document, as in creation (at most 3).
- "preview_routine": runs your revised "routine" on the test items the designer picked, in scratch copies. You get
  results, errors and previews.
- "propose_revision": the complete revised "routine" plus "changeSummary" (one plain sentence: what changed). Doppl
  validates it and runs it on the test items; problems come back to you.
- "decline": the change needs another app (a routine works in ONE app). Don't change the routine; in "reason", say
  which app and suggest adding a routine for it in a flow. Also decline when the request says an item's own file or
  data is wrong; in "reason", say what's wrong with it.
- "ask_question": one "question" with 2–4 short options, only as your first answer and only when a wrong guess would
  make the change useless.
Examples of answers:
{${planKey ? `"${planKey}":"Keeps the steps, adds a layer mask with the masking helper before the export.",` : ""}"action":"preview_routine","reason":"Try the change on the problem item","routine":{…}}
{${planKey ? `"${planKey}":"…",` : ""}"action":"propose_revision","changeSummary":"Also saves a PSD with a layer mask.","reason":"Propose the change","routine":{…}}
You have at most ${maxTurns} answers; every reply from Doppl starts with how many are left. Propose early.`;

/** The routine prompt's format: how code is written, and the turn's fields as this model sees them (in order). */
export interface PromptFormat extends TurnFormat {
  fields: string[];
  /** The plan field's name for this model (e.g. "a0_plan"). */
  planKey?: string;
}

export function routineSystemPrompt(
  app: { adapter: DesignAppAdapter; manifest: string },
  maxTurns: number,
  examples: RoutineTemplate[] = [],
  revision = false,
  format?: PromptFormat,
) {
  const id = app.adapter.id as keyof typeof ROUTINE_FORMAT_EXAMPLES;
  const separate = format?.codeFormat === "separate";
  const actionsKind = app.adapter.stageKind === "actions";
  const raw = ROUTINE_FORMAT_EXAMPLES[id] ?? ROUTINE_FORMAT_EXAMPLES.photoshop;
  const codeField = actionsKind ? "actions" : "script";
  const example = separate ? { ...raw, [codeField]: "@code:1" } : raw;
  const exampleCode = separate
    ? `
Its code, which you write when Doppl asks for it:
\`\`\`${actionsKind ? "json" : "javascript"}
${actionsKind ? JSON.stringify(JSON.parse(String(raw.actions)), null, 1) : raw.script}
\`\`\``
    : "";
  const body = actionsKind
    ? separate
      ? `A ${appName(id)} routine runs "actions": a list of actions from the catalog below. Don't write the list inside your JSON
answer: set the routine's "actions" to "@code:1". Doppl then asks you for the list, and you answer with it as plain JSON
in one \`\`\`json block.`
      : `A ${appName(id)} routine runs "actions": the action list from the catalog below, written as JSON text (a string
containing the array, quotes escaped).`
    : separate
      ? `A ${appName(id)} routine runs "script": an ExtendScript body as described in the guide below. It reads inputs and
settings as params.<key>. Don't write the script inside your JSON answer: set the routine's "script" to "@code:1". Doppl
then asks you for the script, and you answer with it as plain code in one \`\`\`javascript block.`
      : `A ${appName(id)} routine runs "script": an ExtendScript body as described in the guide below. It reads inputs and
settings as params.<key>.`;
  const defaultFields = revision
    ? ["action", "app", "changeSummary", "depth", "document", "nodes", "question", "reason", "routine", "sampleItemIndex"]
    : ["action", "app", "depth", "document", "nodes", "question", "reason", "routine", "sampleItemIndex"];
  return `You are the routine author inside Doppl, a desktop app for designers. Doppl turns a designer's request into a
reusable routine that runs in ONE app: ${app.adapter.name}. The routine is reused many times WITHOUT AI, so it must be
complete, deterministic and parameterized. Routines connect into flows: one routine's output feeds another's input.

${CONTRACT_RULES}

${body}

${routineAnswerFormat(format?.fields ?? defaultFields, format?.planField ? format.planKey : undefined)}
${(revision
  ? REVISION_ACTIONS(maxTurns, format?.planField ? format.planKey : undefined, !!format?.helperTools)
  : CREATE_ACTIONS(maxTurns, format?.planField ? format.planKey : undefined, !!format?.helperTools)
).replace("<app>", id)}

Writing the routine:
- name: max 6 words; description: one sentence; steps: 2–5 plain-language sentences (no code terms).
- Never put absolute paths in a routine, and never copy values from the sample rows or file names into it: use
  inputs, settings and {{item.<column>}} / ctx.item.
- A row's cell can be empty (null), e.g. no allergens: the row still runs, so leave that text empty or skip that part
  instead of failing.
- People's names: when the sample rows have double first names ("Ayşe Nur"), hyphenated surnames, or names typed in
  lowercase or capitals, don't pick a rule silently. Ask (ask_question) or make it a setting with the usual choice as
  default (e.g. initials from "first and last name" or "every part"; "fix capitals" yes/no), and say the rule in
  the steps. In scripts, capitals of Turkish names need i→İ and ı→I: map those letters yourself, since toUpperCase
  turns i into I.
- The designer's own files and folders are read-only: a routine never saves over, changes or deletes them. When the
  request asks to overwrite or delete files, the routine saves new files instead (they go where the designer picks),
  and its description says so, e.g. "Saves the cutouts as new PNGs; your original photos stay as they are." or
  "Copies the images that are at least 500 px; Doppl doesn't delete files." When there's more than one safe way
  (copy the ones to keep, or list the ones to delete), ask first (ask_question): "Doppl doesn't delete files. Should
  it copy the images that are 500 px or bigger to a new folder, or list the small ones?"
- modifiesDocument: true if it changes the document; qcProfile "print" or "web"; keyObjects: up to 2 things that
  must stay fully visible in outputs ([] otherwise); objectChecks: optional { object, region } pairs.
- Keep the answer short: no comments in scripts, no repeated explanations. The whole answer must fit in one reply.

The routine's format (an illustration only; use your own names, steps and body; inside "routine" the fields may come
in this order):
${JSON.stringify(example)}${exampleCode}

=== ${app.adapter.name} (app id "${app.adapter.id}") ===
${app.manifest}${id === "indesign" ? indesignExamples(examples) : ""}`;
}

export function planSystemPrompt(apps: AppId[], maxTurns: number) {
  return `You plan flows inside Doppl, a desktop app for designers. The designer's request needs several apps
(${apps.map(appName).join(", ")}). Each routine works in ONE app; a flow connects routines so one routine's output feeds
another routine's input. Plan the flow: as few routines as the work needs (usually one per app), each routine's
contract, and the connections. Doppl shows the plan to the designer, then writes and tries each routine in order.
Reruns of the flow use no AI.

${CONTRACT_RULES}

The plan:
- inputs: what the designer picks when the flow runs (data files, image files or folders).
- outputs: results saved to a folder the designer picks.
- routines: { id, name, app, purpose (one or two plain sentences: what it does), inputs, iterate, outputs }.
  A routine that works on a document open in its app has an input of type document; it isn't connected (the
  designer picks the document when the flow runs).
- connections: { from, to, match? }. "from" is "input.<key>" or "<routine id>.<output key>"; "to" is
  "<routine id>.<input key>" or "output.<key>". Every required input (except documents) gets one connection.
  An iterating routine's outputs are lists (a file per item becomes a fileList). When an iterating routine gets a
  second list, its connection needs "match": {"by":"index"} (the same item, e.g. the same data row),
  {"by":"fileNameEqualsColumn","column":"<column>","ignoreExtension":true} (the file named in that column), or
  {"by":"columnEquals","leftColumn":"<column of the iterated rows>","rightColumn":"<column of the other rows>"}, or
  {"by":"sameFileName"} (files with files of a similar name, e.g. photo.jpg with photo_mask.png). Add
  "optional":true when an item without a partner should still be made (without it). Names match loosely (case,
  spaces, dashes, accents). Follow the pairing in "Inputs Doppl checked" when there is one.

${answerFormat(["action", "app", "depth", "document", "nodes", "plan", "question", "reason"])}
"action" is "inspect" (a deeper look at a document: app, document, nodes, depth; at most 3), "propose_plan" (with the
complete "plan"; Doppl checks that it connects and sends problems back), "ask_question" (one "question" with 2–4
options, only as your first answer) or "decline" (only as your first answer, when the request isn't design work to
automate: a greeting, a question, small talk; say so in "reason", never invent a task). Example answers:
{"action":"inspect","app":"figma","depth":3,"document":"<document id>","nodes":["Label"],"reason":"Look at the label template"}
{"action":"propose_plan","plan":{…},"reason":"Plan the flow"}
You have at most ${maxTurns} answers. Propose the plan early.

The plan's format (an illustration only):
${JSON.stringify(PLAN_FORMAT_EXAMPLE)}

What each app can do:
${apps.map((a) => `- ${APP_ABILITIES[a] ?? a}`).join("\n")}`;
}

/** Asks for the code of the routine the model just proposed (codeFormat "separate"). */
export function codeRequestMessage(kind: "script" | "actions", action: string) {
  return kind === "actions"
    ? `Now write the "actions" of the routine you just ${action === "preview_routine" ? "sent to preview" : "proposed"}: the complete action list as plain JSON in ONE \`\`\`json block, and nothing else. Use only actions from the catalog.`
    : `Now write the "script" of the routine you just ${action === "preview_routine" ? "sent to preview" : "proposed"}: the complete ExtendScript body as plain code in ONE \`\`\`javascript block, and nothing else. Start the code of each step with a line "// step <n>" (n: the step's number in "steps"). ES3 only; use the building blocks; no other comments; no try/catch that hides a failing step.`;
}

/** Refine: the routine as it is, what the designer wants changed, and the item that went wrong. */
export interface RefineFacts {
  request: string;
  current: unknown;
  version: number;
  history: string[];
  problem?: { item: string; input?: string; output: string; checks: string[]; error?: string };
  testItems: string[];
  /** File names of the images the designer attached (sent as images after the text). */
  attachments: string[];
}

export function refineTaskMessage(f: TaskFacts, r: RefineFacts) {
  return [
    `The designer wants this routine changed: "${r.request}"`,
    `Current routine (version ${r.version}): ${clip(r.current, 14000)}`,
    `Version history: ${r.history.join(" | ") || "none"}`,
    ...(r.problem
      ? [
          `The item that isn't right: ${r.problem.item}${r.problem.input ? ` (input: ${r.problem.input})` : ""}. Its output: ${r.problem.output}.` +
            `${r.problem.error ? ` Error: ${r.problem.error}.` : ""}${r.problem.checks.length ? ` Checks that flagged it: ${r.problem.checks.join("; ")}.` : ""}` +
            " Its output preview is attached.",
        ]
      : []),
    ...(r.attachments.length ? [`The designer attached ${r.attachments.length === 1 ? "an image" : `${r.attachments.length} images`}: ${r.attachments.join(", ")} (shown below).`] : []),
    `Test items Doppl tries your revision on: ${r.testItems.join(", ") || "the first sample item"}.`,
    ...factLines({ ...f, request: r.request }, 14000).slice(1),
  ].join("\n");
}

export interface TaskFacts {
  request: string;
  references: string[];
  folders: { path: string; files: string[] }[];
  samples: { file: string; columns: string[]; rows: Record<string, unknown>[]; totalRows: number; errors: string[] }[];
  documents: { appId: string; id: string; name: string; inspection: unknown }[];
  /** The input check: what was attached, how it pairs and what the designer decided (see inputs/inputCheck). */
  inputs?: string[];
}

const clip = (value: unknown, max: number) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
};

function factLines(f: TaskFacts, inspectionChars: number) {
  return [
    `Request: "${f.request}"`,
    `Reference files (names only): ${f.references.length ? f.references.map((r) => r.split("/").pop()).join(", ") : "none"}`,
    ...f.samples.map(
      (s) =>
        `Sample data ${s.file} (${s.totalRows} rows; columns: ${s.columns.join(", ")})${s.rows.length ? `. First rows: ${clip(s.rows, 3000)}` : " (in a folder: only its columns are shared)"}${s.errors.length ? `. Row problems: ${s.errors.slice(0, 5).join(" | ")}` : ""}`,
    ),
    ...f.folders.map((d) => `Folder ${d.path.split("/").pop()} (file names only): ${d.files.slice(0, 40).join(", ") || "empty"}`),
    ...(f.inputs?.length ? ["Inputs Doppl checked (follow these; the designer confirmed the choices marked so):", ...f.inputs.map((l) => `- ${l}`)] : []),
    "Open documents:",
    ...(f.documents.length
      ? f.documents.map((d) => (d.id ? `- ${d.appId} document id "${d.id}" (${d.name}): ${clip(d.inspection, inspectionChars)}` : `- ${d.appId}: ${String(d.inspection)}`))
      : ["- none"]),
  ];
}

/** What the model gets to start a routine: the request, samples, the app's document, and its place in a flow or repair. */
export function routineTaskMessage(
  f: TaskFacts,
  extra: {
    /** Flow creation: the plan and the contract this routine must keep. */
    flow?: { plan: string; routine: FlowPlanRoutine; upstream: string[] };
    /** Repair or "Make compatible": the routine as it is and what to change. */
    current?: { routine: unknown; problems: string[] };
  } = {},
) {
  const lines = factLines(f, 14000);
  if (extra.flow) {
    const r = extra.flow.routine;
    lines.push(
      `This routine is "${r.id}" of a flow: ${extra.flow.plan}`,
      `Its job: ${r.purpose}`,
      `Its contract is fixed (keep these keys and types; you may add settings and optional inputs): ${JSON.stringify({ name: r.name, app: r.appId, inputs: r.inputs, ...(r.iterate ? { iterate: r.iterate } : {}), outputs: r.outputs })}`,
      ...extra.flow.upstream,
    );
  }
  if (extra.current) {
    lines.push(`Current routine: ${clip(extra.current.routine, 12000)}`, `What to change: ${extra.current.problems.join(" | ")}`, "Fix it and propose the complete corrected routine.");
  }
  return lines.join("\n");
}

/** What the model gets to plan a flow. */
export function planTaskMessage(f: TaskFacts) {
  return factLines(f, 8000).join("\n");
}

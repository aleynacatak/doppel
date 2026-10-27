import type { DesignAppAdapter, RoutineTemplate } from "../../adapters/types";
import type { DocumentSummary, RoutineDraft, StyleProfile, Task } from "../types";

// Prompts and structured-output schemas for Muse Spark (response_format json_schema).
// Schemas avoid strict mode, so optional fields are simply left out of "required".

const PARAM_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string", description: "camelCase identifier used in the script as params.<key>" },
    label: { type: "string" },
    type: { type: "string", enum: ["text", "number", "boolean", "select", "formatList", "file", "folder", "dataFile"] },
    required: { type: "boolean" },
    default: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] },
    help: { type: "string" },
    options: {
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] },
    },
    optionsSource: { type: "string" },
    extensions: { type: "array", items: { type: "string" } },
    columns: { type: "array", items: { type: "string" }, description: "dataFile: columns every row must have" },
    role: { type: "string", enum: ["input", "output"], description: "folder: read files from it, or save results into it" },
    min: { type: "number" },
    max: { type: "number" },
  },
  required: ["key", "label", "type", "required"],
};

export const ROUTINE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    params: { type: "array", items: PARAM_SCHEMA },
    script: { type: "string" },
    requiredFonts: { type: "array", items: { type: "string" } },
    modifiesDocument: { type: "boolean" },
    qcProfile: { type: "string", enum: ["print", "web"] },
    keyObjects: { type: "array", items: { type: "string" } },
  },
  required: ["name", "description", "steps", "params", "script", "requiredFonts", "modifiesDocument", "qcProfile", "keyObjects"],
};

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["question", "routine"] },
    question: {
      type: "object",
      properties: {
        text: { type: "string" },
        options: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] },
        },
      },
      required: ["text", "options"],
    },
    routine: ROUTINE_SCHEMA,
  },
  required: ["kind"],
};

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    issues: {
      type: "array",
      items: { type: "object", properties: { outputId: { type: "string" }, reason: { type: "string" } }, required: ["outputId", "reason"] },
    },
  },
  required: ["passed", "issues"],
};

export const EXPLANATION_SCHEMA = {
  type: "object",
  properties: { explanation: { type: "string" } },
  required: ["explanation"],
};

const PARAM_SOURCES: Record<string, string> = {
  indesign: '"pdfExportPresets" (the PDF export presets installed in InDesign)',
  figma: '"frames" (top-level frames in the open file)',
};

function exampleBlock(t: RoutineTemplate) {
  return [
    `### Example: ${t.name}`,
    `steps: ${JSON.stringify(t.steps)}`,
    `params: ${JSON.stringify(t.params)}`,
    `modifiesDocument: ${t.modifiesDocument}, qcProfile: ${t.qcProfile}`,
    "script:",
    t.script,
  ].join("\n");
}

export function systemPrompt(adapter: DesignAppAdapter, examples: RoutineTemplate[]) {
  return `You are the routine author inside Doppl, a desktop app for designers. Doppl turns a designer's plain-language
request into a reusable routine that runs inside ${adapter.name}. The routine is reused many times WITHOUT AI, so it must
be complete, deterministic and parameterized.

Target app: ${adapter.name} · scripting: ${adapter.scriptLanguage}
${adapter.modelGuide}

How to write the routine:
- Never put absolute paths, user names or machine-specific locations in the script. Every file, folder, template or
  export location is a param of type "file" or "folder" that the designer picks at run time.
- Make anything a designer may change between runs a param (naming patterns, resolution, page ranges, formats, presets),
  with sensible defaults. Use "select" with optionsSource ${PARAM_SOURCES[adapter.id] ?? "(none for this app)"} when the
  choices come from the app; otherwise give "options". "formatList" is a multi-select list with options.
- steps: 3–6 short sentences a designer understands, no code terms.
- name: short and specific (max 6 words). description: one sentence.
- modifiesDocument: true if the script changes the document, false if it only reads or exports.
- qcProfile: "print" or "web" (sets the image-resolution check).
- keyObjects: up to 2 short noun phrases ("product", "logo") for things that must stay fully visible in every output;
  use [] when that doesn't apply (e.g. exports of whole pages).
- requiredFonts: font families the routine sets explicitly; [] otherwise.

Ask a clarifying question only when a wrong guess would make the routine useless. At most one question, with 2–4 short
answer options. Otherwise answer with kind "routine".

Answer with JSON only, matching the schema.

${examples.map(exampleBlock).join("\n\n")}`;
}

function compactSummary(summary: DocumentSummary | null) {
  if (!summary) return "(not read)";
  return JSON.stringify({
    name: summary.ref.name,
    pages: summary.pageCount,
    pageSize: summary.pageSize,
    layers: summary.layers.slice(0, 30),
    paragraphStyles: summary.paragraphStyles.slice(0, 40),
    characterStyles: summary.characterStyles.slice(0, 20),
    textFrames: summary.textFrameCount,
    links: summary.links.slice(0, 20).map((l) => ({ name: l.name, status: l.status, page: l.page })),
    fonts: summary.fonts.slice(0, 20).map((f) => f.name),
    frames: summary.frames,
    appVersion: summary.appVersion,
  });
}

export function taskMessage(task: Task, summary: DocumentSummary | null, style: StyleProfile | null) {
  const refs = task.references.length ? task.references.map((r) => r.split("/").pop()).join(", ") : "none";
  const rules = style?.rules.length ? style.rules.map((r) => `${r.label}: ${r.value}`).join("; ") : "none";
  return `Request: "${task.request}"
Reference files (names only): ${refs}
House style: ${rules}
Open document: ${compactSummary(summary)}`;
}

export function fixMessage(task: Task, summary: DocumentSummary | null, draft: RoutineDraft, problems: string[], kind: "lint" | "run") {
  const what =
    kind === "run"
      ? "The routine failed when Doppl ran it once on a temporary copy of the document."
      : "The routine can't run yet: Doppl's checks found problems in the script.";
  return `${what} Fix it and answer with the complete corrected routine (same JSON shape).
Problems:
${problems.map((p) => `- ${p}`).join("\n")}

${taskMessage(task, summary, null)}

Current routine:
${JSON.stringify({ ...draft, steps: draft.steps.map((s) => s.plainLanguage) })}`;
}

export const REVIEW_SYSTEM = `You check the result of a design automation for a designer. You get the request and one image
per output. Flag only clear problems a designer would fix before sending the files: important objects cut off at an
edge, text overflowing or overlapping images, empty or blank outputs, a result that doesn't match the request.
Write each reason as one short sentence in plain language, e.g. "Product is cut off at the right edge".
Answer with JSON only, matching the schema. Use the output ids you were given.`;

export const EXPLAIN_SYSTEM = `You explain to a designer, in one or two plain sentences without code terms, why an
automation routine stopped working. Answer with JSON only, matching the schema.`;

// ---------- Multi-app creation (stages) ----------

const STAGE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: 'Short id used in placeholders, e.g. "s1"' },
    name: { type: "string" },
    app: { type: "string" },
    kind: { type: "string", enum: ["actions", "script"] },
    document: { type: "string", enum: ["open", "none"] },
    repeat: { type: "object", properties: { over: { type: "string" } }, required: ["over"] },
    inputs: { type: "array", items: { type: "string" } },
    outputs: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, type: { type: "string", enum: ["fileList", "file", "nodeList", "data"] }, label: { type: "string" } },
        required: ["key", "type"],
      },
    },
    steps: { type: "array", items: { type: "string" } },
    // Text, not an array: an array of objects without listed properties can only be filled with empty objects
    // when the AI service enforces the schema, which is how Figma stages arrived without actions.
    actions: { type: "string", description: 'Figma stages: the action list as JSON text, e.g. "[{\\"action\\":\\"duplicateNode\\",…}]"' },
    script: { type: "string", description: "InDesign/Photoshop stages: the ExtendScript body" },
    modifiesDocument: { type: "boolean" },
  },
  required: ["id", "name", "app", "kind", "outputs", "steps"],
};

export const STAGED_ROUTINE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    params: { type: "array", items: PARAM_SCHEMA },
    stages: { type: "array", items: STAGE_SCHEMA },
    qcProfile: { type: "string", enum: ["print", "web"] },
    requiredFonts: { type: "array", items: { type: "string" } },
    keyObjects: { type: "array", items: { type: "string" } },
    objectChecks: {
      type: "array",
      items: { type: "object", properties: { object: { type: "string" }, region: { type: "string" } }, required: ["object", "region"] },
    },
  },
  required: ["name", "description", "params", "stages"],
};

export const STAGE_TURN_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["inspect", "preview_stage", "propose_routine", "ask_question"] },
    reason: { type: "string", description: "One short sentence for the designer: what you are doing" },
    app: { type: "string" },
    document: { type: "string" },
    node: { type: "string" },
    nodes: { type: "array", items: { type: "string" }, description: "inspect: several layers at once (names, paths or ids)" },
    depth: { type: "number" },
    stageId: { type: "string" },
    sampleItemIndex: { type: "number" },
    routine: STAGED_ROUTINE_SCHEMA,
    question: {
      type: "object",
      properties: {
        text: { type: "string" },
        options: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] },
        },
      },
      required: ["text", "options"],
    },
  },
  required: ["action"],
};

/** The routine format, shown to the model (and checked by tests/promptExample.test.ts). */
export const ROUTINE_FORMAT_EXAMPLE = {
  name: "Cards and previews",
  description: "…",
  qcProfile: "web",
  keyObjects: [],
  objectChecks: [],
  params: [
    { key: "rows", label: "Data", type: "dataFile", required: true, columns: ["title", "photo"] },
    { key: "photos", label: "Photos", type: "folder", required: true, role: "input" },
    { key: "out", label: "Output folder", type: "folder", required: true, role: "output" },
  ],
  stages: [
    {
      id: "s1",
      name: "Prepare photos",
      app: "photoshop",
      kind: "script",
      document: "none",
      repeat: { over: "{{params.rows.rows}}" },
      inputs: ["{{params.photos}}"],
      outputs: [{ key: "files", type: "fileList" }],
      steps: ["…"],
      script:
        'var img = openDocument(ctx.join(params.photos, ctx.item.photo));\nexportImage(ctx.join(ctx.workDir, ctx.baseName(ctx.item.photo) + ".png"), "png");',
    },
    {
      id: "s2",
      name: "Fill cards",
      app: "figma",
      kind: "actions",
      document: "open",
      repeat: { over: "{{params.rows.rows}}" },
      inputs: ["{{stage.s1.outputs.files}}"],
      outputs: [{ key: "files", type: "fileList" }],
      steps: ["…"],
      actions: JSON.stringify([
        { action: "duplicateNode", id: "card", node: "Card" },
        { action: "setText", node: "$card.#Title", text: "{{item.title}}" },
        { action: "setImageFill", node: "$card.#Photo", image: { files: "{{stage.s1.outputs.files}}", name: "{{item.photo}}" } },
        { action: "exportNode", node: "$card", format: "PNG", folder: "{{params.out}}", fileName: "{{item.title}}", output: "files" },
      ]),
    },
  ],
};

export interface StageAppContext {
  adapter: DesignAppAdapter;
  manifest: string;
}

export function stageSystemPrompt(apps: StageAppContext[], maxTurns: number) {
  return `You are the routine author inside Doppl, a desktop app for designers. Doppl turns a designer's request into a
reusable routine that runs across their design apps. The routine is reused many times WITHOUT AI, so it must be
complete, deterministic and parameterized.

A routine has params (picked by the designer at each run) and one or more stages. Each stage runs in ONE app;
stages run in order and pass results to each other through placeholders:
  {{params.<key>}}, {{params.<dataFile>.rows}}, {{params.<folder>.files}}, {{item.<field>}}, {{itemIndex}},
  {{stage.<stageId>.outputs.<key>}}
A stage with repeat.over (a list placeholder) runs once per item: per data row, per file, or per output of an
earlier stage. Files a stage hands to later stages go to its working folder and into a declared output
(type "fileList"); final deliverables go into a folder param with role "output".

Answer with ONE JSON object per turn, matching the schema. "action" is one of:
- "inspect": a deeper look at a document: app, document (id from the list below), optional "nodes" (several
  layers at once, by name, path or id) and depth. At most 3 inspections in total: ask for every layer you need
  in one go. The documents below already include their structure (and, in Figma, the designer's selection).
- "preview_stage": runs stageId of your draft "routine" on one sample item (sampleItemIndex, 0-based) in a
  scratch copy (Figma: a temporary page that is deleted after; Photoshop: never saved; InDesign: a hidden copy).
  Earlier stages run first on the same item. You get results, errors and a preview image.
- "propose_routine": the complete routine. Doppl validates it (action schemas, script checks, every placeholder
  resolves, no absolute paths, no literal values copied from the sample data) and runs a trial on the first
  sample item. Problems come back to you as structured errors; fix them and propose again.
- "ask_question": one clarifying question with 2–4 short options, only when a wrong guess would make the routine
  useless. At most once, and only as your first answer.
You have at most ${maxTurns} answers in total; every reply from Doppl starts with how many are left. Propose a
complete routine early (by your 3rd or 4th answer) and improve it from the feedback; previews are optional.

Writing the routine:
- name: max 6 words; description: one sentence; each stage has 2–5 plain-language steps (no code terms).
- params: every file, folder, data file or option the designer may change is a param. Types: text, number,
  boolean, select (with options), formatList, file (with extensions), folder (role "input" or "output"),
  dataFile (a CSV, JSON or Excel file; give the columns the stages use). Never put absolute paths in a routine.
- Never copy values from the sample rows or sample file names into actions or scripts; use {{item.<column>}}.
- Stage ids: short identifiers (s1, s2, …). Each stage declares outputs it hands on (key + type) and inputs
  (the placeholders it reads).
- document: "open" when the stage works on a document the designer has open in that app (picked at run time),
  "none" when it only opens files from params.
- Figma stages: kind "actions" with "actions": the action list from the catalog, written as JSON text (a string
  containing the array, quotes escaped). InDesign and Photoshop stages:
  kind "script" with "script" (an ExtendScript body as described in that app's guide).
- qcProfile "print" or "web"; keyObjects: up to 2 things that must stay fully visible in outputs ([] otherwise);
  objectChecks: optional { object, region } pairs checked with an image model on reruns with AI review.
- When stages repeat over the same data rows, items stay matched across stages (a row that failed is skipped
  later). A script stage finds files that earlier stages made for the same row with ctx.findFile.

The shape of a routine (an illustration of the format only; use your own names, steps and actions):
${JSON.stringify(ROUTINE_FORMAT_EXAMPLE)}
A Figma stage's action list goes in its "actions" text; a script goes in "script". Keep scripts short and without
comments: the whole answer must fit in one reply.

Apps in this task:
${apps.map((a) => `\n=== ${a.adapter.name} (app id "${a.adapter.id}", stage kind "${a.adapter.stageKind}") ===\n${a.manifest}`).join("\n")}`;
}

export interface StageTaskFacts {
  request: string;
  references: string[];
  folders: { path: string; files: string[] }[];
  samples: { file: string; columns: string[]; rows: Record<string, unknown>[]; totalRows: number; errors: string[] }[];
  documents: { appId: string; id: string; name: string; inspection: unknown }[];
  style: StyleProfile | null;
  /** Repair: the routine as it is and what went wrong. */
  current?: { routine: unknown; problems: string[] };
}

const clip = (value: unknown, max: number) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
};

export function stageTaskMessage(f: StageTaskFacts) {
  const rules = f.style?.rules.length ? f.style.rules.map((r) => `${r.label}: ${r.value}`).join("; ") : "none";
  return [
    `Request: "${f.request}"`,
    `Reference files (names only): ${f.references.length ? f.references.map((r) => r.split("/").pop()).join(", ") : "none"}`,
    ...f.samples.map(
      (s) =>
        `Sample data ${s.file} (${s.totalRows} rows; columns: ${s.columns.join(", ")})${s.rows.length ? `. First rows: ${clip(s.rows, 3000)}` : " (in a folder: only its columns are shared)"}${s.errors.length ? `. Row problems: ${s.errors.slice(0, 5).join(" | ")}` : ""}`,
    ),
    ...f.folders.map((d) => `Folder ${d.path.split("/").pop()} (file names only): ${d.files.slice(0, 40).join(", ") || "empty"}`),
    `House style: ${rules}`,
    "Open documents:",
    ...f.documents.map((d) =>
      d.id ? `- ${d.appId} document id "${d.id}" (${d.name}): ${clip(d.inspection, 14000)}` : `- ${d.appId}: ${String(d.inspection)}`,
    ),
    ...(f.current ? [`Current routine: ${clip(f.current.routine, 12000)}`, `What went wrong: ${f.current.problems.join(" | ")}`, "Fix it and propose the complete corrected routine."] : []),
  ].join("\n");
}

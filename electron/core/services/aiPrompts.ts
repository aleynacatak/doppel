import type { DesignAppAdapter, RoutineTemplate } from "../../adapters/types";
import type { DocumentSummary, RoutineDraft, StyleProfile, Task } from "../types";

// Prompts and structured-output schemas for Muse Spark (response_format json_schema).
// Schemas avoid strict mode, so optional fields are simply left out of "required".

const PARAM_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string", description: "camelCase identifier used in the script as params.<key>" },
    label: { type: "string" },
    type: { type: "string", enum: ["text", "number", "boolean", "select", "formatList", "file", "folder"] },
    required: { type: "boolean" },
    default: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] },
    help: { type: "string" },
    options: {
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] },
    },
    optionsSource: { type: "string" },
    extensions: { type: "array", items: { type: "string" } },
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

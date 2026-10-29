import fs from "node:fs/promises";
import path from "node:path";
import type { AppId } from "../core/types";

// Eval tasks: /evals/tasks/<id>/task.json plus a fixtures/ folder. A task is a request Doppl must turn into a
// routine; it passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.

export type CheckDef =
  /** How many files a port produced: a number, or "inputCount:<input>" (files in that attachment, or its data rows). */
  | { type: "outputCount"; port: string; equals: number | string }
  | { type: "fileExtension"; port: string; is: string }
  /** Exact or maximum size in px; or scale: each output's width = its input's (same file name) × scale. */
  | { type: "imageSize"; port: string; width?: number; height?: number; maxWidth?: number; maxHeight?: number; scaleOf?: string; scale?: number; tolerance?: number }
  | { type: "hasTransparency"; port: string }
  | { type: "cornerPixelsTransparent"; port: string }
  /** White background removed everywhere, also inside enclosed areas: at most maxShare (default 0.02) of the pixels are opaque near-white. */
  | { type: "noOpaqueWhite"; port: string; maxShare?: number }
  /** The rough work of a cutout: white connected to the image's edges is gone (at most maxShare, default 0.01, of the pixels); white enclosed by the subject may stay. */
  | { type: "outerWhiteRemoved"; port: string; maxShare?: number }
  /** Text in an output's details (a Figma text node, a text layer the app reported) or in a text-like output file. */
  | { type: "textContains"; port?: string; text: string }
  /** Every file name matches the regex; with stemsFrom, each name (without extension) is an input file's name. */
  | { type: "fileNamePattern"; port: string; pattern?: string; stemsFrom?: string }
  /** allow: a regex for errors that are expected (items the designer chose to skip). */
  | { type: "noRunErrors"; allow?: string }
  /** Doppl (kind "inputs") or the AI asked a question matching the regex. */
  | { type: "askedAbout"; pattern: string; kind?: "inputs" | "ai" }
  /** No question was asked (of that kind): the inputs were clear enough. */
  | { type: "noQuestions"; kind?: "inputs" | "ai" }
  /** Each item (by name) was made with this partner file (by name); null: the item was skipped. Needs output details (simulated apps report them). */
  | { type: "pairedWith"; pairs: Record<string, string | null> }
  /** Each output named after a key has that color at (x, y) (fractions of its size); every key needs an output. */
  | { type: "colorAt"; port: string; x: number; y: number; expect: Record<string, [number, number, number]>; tolerance?: number }
  /** Every name has an output whose file name contains it (loosely); only: no other outputs. */
  | { type: "outputNames"; port: string; names: string[]; only?: boolean };

export interface EvalTask {
  id: string;
  app: AppId;
  request: string;
  /** "real" needs the app open; "simulated" runs the creation loop for real but simulates the app. */
  mode: "real" | "simulated";
  attachments: {
    /** Name → file or folder (relative to the task folder), used for the creation and mapped onto the routine's inputs for the rerun. */
    inputs?: Record<string, string>;
    /** Simulated tasks: what the model gets when it inspects the document (a JSON file). */
    inspection?: string;
  };
  checks: CheckDef[];
  /** How the designer answers Doppl's questions: the first option whose label or id matches "choose", for a question matching "question". Otherwise the recommended (first) option. */
  answers: { question: string; choose: string }[];
  tags: string[];
  /** The task's folder (absolute). */
  dir: string;
}

const CHECK_TYPES = new Set([
  "outputCount",
  "fileExtension",
  "imageSize",
  "hasTransparency",
  "cornerPixelsTransparent",
  "noOpaqueWhite",
  "outerWhiteRemoved",
  "textContains",
  "fileNamePattern",
  "noRunErrors",
  "askedAbout",
  "noQuestions",
  "pairedWith",
  "colorAt",
  "outputNames",
]);
const NO_PORT = new Set(["noRunErrors", "textContains", "askedAbout", "noQuestions", "pairedWith"]);
const APPS = new Set(["photoshop", "indesign", "figma"]);

/** Reads and checks one task.json; throws with what's wrong. */
export function parseTask(raw: unknown, dir: string): EvalTask {
  const t = raw as Record<string, any>;
  const where = `${path.basename(dir)}/task.json`;
  if (!t || typeof t !== "object") throw new Error(`${where}: not a JSON object.`);
  if (typeof t.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) throw new Error(`${where}: "id" must be lowercase letters, digits and dashes.`);
  if (!APPS.has(t.app)) throw new Error(`${where}: "app" must be photoshop, indesign or figma.`);
  if (typeof t.request !== "string" || !t.request.trim()) throw new Error(`${where}: "request" is missing.`);
  if (!Array.isArray(t.checks) || t.checks.length === 0) throw new Error(`${where}: give at least one check.`);
  for (const [i, c] of t.checks.entries()) {
    if (!c || !CHECK_TYPES.has(c.type)) throw new Error(`${where}: check ${i + 1} has an unknown type "${c?.type}".`);
    if (!NO_PORT.has(c.type) && typeof c.port !== "string") throw new Error(`${where}: check ${i + 1} (${c.type}) needs a "port".`);
  }
  const answers = t.answers ?? [];
  if (!Array.isArray(answers) || answers.some((a: any) => typeof a?.question !== "string" || typeof a?.choose !== "string")) {
    throw new Error(`${where}: "answers" is a list of { "question": "<regex>", "choose": "<regex for the option>" }.`);
  }
  const inputs = t.attachments?.inputs ?? {};
  if (typeof inputs !== "object" || Object.values(inputs).some((v) => typeof v !== "string")) throw new Error(`${where}: attachments.inputs maps names to paths.`);
  return {
    id: t.id,
    app: t.app,
    request: t.request.trim(),
    mode: t.mode === "simulated" ? "simulated" : "real",
    attachments: { inputs, ...(typeof t.attachments?.inspection === "string" ? { inspection: t.attachments.inspection } : {}) },
    checks: t.checks,
    answers,
    tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
    dir,
  };
}

/** Every task in the folder. */
export async function loadTasks(tasksDir: string): Promise<EvalTask[]> {
  const names = (await fs.readdir(tasksDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const tasks: EvalTask[] = [];
  for (const name of names) {
    const dir = path.join(tasksDir, name);
    const file = path.join(dir, "task.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`${name}/task.json isn't valid JSON: ${(err as Error).message}`);
    }
    tasks.push(parseTask(raw, dir));
  }
  return tasks;
}

/** "all", or a comma list of task ids and tags. */
export function selectTasks(tasks: EvalTask[], selector: string): EvalTask[] {
  if (!selector || selector === "all") return tasks;
  const wanted = selector.split(",").map((s) => s.trim()).filter(Boolean);
  const picked = tasks.filter((t) => wanted.some((w) => w === t.id || t.tags.includes(w)));
  const unknown = wanted.filter((w) => !tasks.some((t) => t.id === w || t.tags.includes(w)));
  if (unknown.length) throw new Error(`No task or tag named ${unknown.map((u) => `"${u}"`).join(", ")}.`);
  return picked;
}

/** An attachment as a path, and what it holds: the files of a folder, or one file. */
export async function resolveAttachment(task: EvalTask, name: string): Promise<{ path: string; isFolder: boolean; files: string[] }> {
  const rel = task.attachments.inputs?.[name];
  if (!rel) throw new Error(`Task ${task.id} has no attachment "${name}".`);
  const abs = path.resolve(task.dir, rel);
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) return { path: abs, isFolder: false, files: [abs] };
  const files = (await fs.readdir(abs)).filter((n) => !n.startsWith(".")).sort().map((n) => path.join(abs, n));
  return { path: abs, isFolder: true, files };
}

import { compatible, inputSpec, isListType, outputSpec } from "../../shared/ports";
import { topoOrder } from "../../shared/flowGraph";
import type { AppId, FigmaActionStep, FlowPlan, FlowPlanRoutine, MatchRule, ParamValue, PortDef, Routine, RoutineDraft, SettingDef, StageKind, ValidationError } from "../types";
import { newId } from "../util";
import { SETTING_TYPES, cleanPort } from "./contract";
import { ruleProblem } from "../flows/match";

// Reads what the AI wrote (a routine, or a flow plan) into Doppl's types. Structure is checked afterwards by the
// validators, which explain problems in the model's own terms.
//
// Meta's structured output makes the model write the fields of schema-defined objects in alphabetical order. A
// field it reaches too late comes out under a near-miss name ("actions_O", "depth hints"); those are recovered here.

/** The model answered, but not with a routine or plan Doppl can read. */
export class RoutineFormatError extends Error {}

/**
 * A copy of an object with known keys recovered from near-miss names: when "actions" is missing but "actions_O"
 * (or "actions2", "actionsTEST") is there, its value is used. With several candidates the fullest one wins.
 */
export function recoverKeys<T extends Record<string, any>>(obj: T, known: readonly string[]): T {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out: Record<string, any> = { ...obj };
  const keys = Object.keys(obj);
  for (const k of known) {
    if (out[k] !== undefined) continue;
    const want = k.toLowerCase();
    const candidates = keys.filter((x) => !known.includes(x) && x.trim().toLowerCase().startsWith(want) && !known.some((o) => o !== k && o.length > k.length && x.trim().toLowerCase().startsWith(o.toLowerCase())));
    if (!candidates.length) continue;
    const size = (v: unknown) => (v === null || v === undefined ? 0 : (JSON.stringify(v)?.length ?? 0));
    out[k] = candidates.map((c) => obj[c]).sort((a, b) => size(b) - size(a))[0];
  }
  return out as T;
}

export const TURN_KEYS = ["action", "app", "changeSummary", "depth", "document", "ids", "nodes", "plan", "query", "question", "reason", "routine", "sampleItemIndex"] as const;
const ROUTINE_KEYS = [
  "actions",
  "app",
  "description",
  "inputs",
  "iterate",
  "keyObjects",
  "modifiesDocument",
  "name",
  "objectChecks",
  "outputs",
  "qcProfile",
  "requiredFonts",
  "script",
  "settings",
  "steps",
] as const;
const PORT_KEYS = ["columns", "description", "extensions", "key", "label", "required", "type"] as const;
const SETTING_KEYS = ["default", "help", "key", "label", "max", "min", "options", "optionsSource", "required", "type"] as const;
const PLAN_KEYS = ["connections", "description", "inputs", "name", "outputs", "routines"] as const;
const PLAN_ROUTINE_KEYS = ["app", "id", "inputs", "iterate", "name", "outputs", "purpose"] as const;

const strings = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, max) : [];
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ---------- Figma action lists (written as JSON text) ----------

type ActionsRead = { actions: FigmaActionStep[] } | { problem: string };

/** An action list from parsed JSON: the list, { actions: [...] }, one action, or a list of JSON strings. */
function actionsFrom(value: unknown): FigmaActionStep[] | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { actions?: unknown; action?: unknown };
    if (Array.isArray(v.actions)) return actionsFrom(v.actions);
    if (typeof v.action === "string") return [value as FigmaActionStep];
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.map((a) => {
    if (typeof a !== "string") return a;
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  });
  return items.every((a) => a && typeof a === "object" && !Array.isArray(a)) ? (items as FigmaActionStep[]) : null;
}

/** Where JSON text breaks, in words the model can act on. */
function describeJsonError(text: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const at = message.match(/position (\d+)/);
  const pos = at ? Number(at[1]) : text.length;
  const reason = message.replace(/\s*in JSON at position \d+.*$/, "").replace(/\s*\(line \d+ column \d+\)/, "");
  if (pos >= text.length - 1 || /end of JSON input/i.test(message)) {
    return (
      `its "actions" text isn't a complete JSON list: it is ${text.length} characters long and stops at ` +
      `"…${text.slice(-60)}". It may have been cut short, or a quote inside it wasn't escaped (inside the text, every " is written \\").`
    );
  }
  return (
    `its "actions" text isn't valid JSON (${reason}) at character ${pos + 1} of ${text.length}, right after ` +
    `"…${text.slice(Math.max(0, pos - 60), pos)}" and before "${text.slice(pos, pos + 30)}…".`
  );
}

/**
 * Reads the action list the model wrote as JSON text. Small slips are repaired here (code fences, trailing commas,
 * text encoded twice); anything else comes back as a problem that says where the text breaks.
 */
export function readActionsText(raw: string): ActionsRead {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!text) return { problem: 'its "actions" text is empty.' };
  for (let depth = 0; depth < 2; depth++) {
    let parsed: unknown;
    let firstError: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      firstError = err;
      try {
        parsed = JSON.parse(text.replace(/,(\s*[\]}])/g, "$1"));
        firstError = undefined;
      } catch {
        // Report the original error: it points at the first slip.
      }
    }
    if (firstError) return { problem: describeJsonError(text, firstError) };
    if (typeof parsed === "string") {
      text = parsed.trim();
      continue;
    }
    const actions = actionsFrom(parsed);
    if (actions) return { actions };
    return {
      problem: Array.isArray(parsed)
        ? parsed.length === 0
          ? 'its "actions" text is an empty list.'
          : 'its "actions" text is a list, but not of actions (each action is an object like {"action":"setText",…}).'
        : 'its "actions" text is JSON, but not a list of actions.',
    };
  }
  return { problem: 'its "actions" text is JSON text inside JSON text; write the list once.' };
}

/** A Figma routine's action list, wherever the model put it ("actions" text or list, "body", a script by mistake). */
function routineActions(r: Record<string, any>): ActionsRead {
  let problem: string | undefined;
  for (const c of [r.actions, r.body?.actions, r.body, r.script]) {
    if (typeof c === "string") {
      if (!c.trim()) continue;
      const read = readActionsText(c);
      if ("actions" in read) return read;
      if (c === r.actions) problem ??= read.problem;
      else if (c === r.script && !problem) problem = 'it has a "script", but Figma routines run an action list from the catalog, written as JSON text in "actions".';
      continue;
    }
    const actions = actionsFrom(c);
    if (actions) return { actions };
  }
  return { problem: problem ?? 'its "actions" text is missing or empty.' };
}

/** Why a Figma routine's action list couldn't be read, for the message back to the model (never saved). */
const actionProblems = new WeakMap<RoutineDraft, string>();
export const actionsProblem = (draft: RoutineDraft) => actionProblems.get(draft);

// ---------- Routines ----------

const OPTION_SOURCES: Record<string, string[]> = { indesign: ["pdfExportPresets"], figma: ["frames"], photoshop: ["layers", "smartObjects"] };

/** A setting as the model or an older param wrote it; null when its key or type is unusable. */
export function toSetting(raw: Record<string, any>, appId: AppId): SettingDef | null {
  const s = recoverKeys(raw, SETTING_KEYS);
  const key = String(s?.key ?? "").trim();
  const type = s?.type as SettingDef["type"];
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !SETTING_TYPES.includes(type)) return null;
  const options = Array.isArray(s.options)
    ? s.options
        .filter((o: any) => o && (typeof o.value === "string" || typeof o === "string"))
        .map((o: any) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: typeof o.label === "string" && o.label ? o.label : o.value }))
    : undefined;
  let def: ParamValue | undefined = s.default;
  if (type === "number") def = Number.isFinite(Number(def)) && def !== "" && def !== null ? Number(def) : undefined;
  else if (type === "boolean") def = def === undefined ? undefined : def === true || def === "true";
  else if (type === "formatList") def = Array.isArray(def) ? strings(def) : options?.map((o: { value: string }) => o.value);
  else if (def !== undefined && def !== null) def = String(def);
  const source = typeof s.optionsSource === "string" && OPTION_SOURCES[appId]?.includes(s.optionsSource) ? s.optionsSource : undefined;
  return {
    key,
    label: String(s.label || key).slice(0, 80),
    type,
    required: s.required === true,
    ...(def !== undefined && def !== null ? { default: def as SettingDef["default"] } : {}),
    ...(typeof s.help === "string" && s.help ? { help: s.help } : {}),
    ...(options?.length ? { options } : {}),
    ...(source ? { optionsSource: source } : {}),
    ...(Number.isFinite(s.min) ? { min: s.min } : {}),
    ...(Number.isFinite(s.max) ? { max: s.max } : {}),
  };
}

function ports(raw: unknown, field: "inputs" | "outputs"): PortDef[] {
  return list(raw).map((p, i) => {
    const port = cleanPort(recoverKeys(p, PORT_KEYS));
    if (!port) {
      throw new RoutineFormatError(
        `${field}[${i}] needs a "key" and a "type" (file, fileList, folder, rows, document, text, number or boolean); got ${JSON.stringify(p).slice(0, 120)}.`,
      );
    }
    return port;
  });
}

/** Turns the model's routine JSON into a draft for one app. The validator checks it afterwards. */
export function toRoutineDraft(raw: Record<string, any> | undefined, appId: AppId, kind: StageKind, appVersion: string): RoutineDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoutineFormatError('The answer didn\'t contain a routine (put it in "routine").');
  const r = recoverKeys(raw, ROUTINE_KEYS);
  const inputs = ports(r.inputs, "inputs");
  const outputs = ports(r.outputs, "outputs");
  const settings = list(r.settings).map((s, i) => {
    const setting = toSetting(s, appId);
    if (!setting) throw new RoutineFormatError(`settings[${i}] needs a "key" and a "type" (text, number, boolean, select or formatList); files, folders and data are inputs.`);
    return setting;
  });
  const iterateInput = typeof r.iterate === "string" ? r.iterate : typeof r.iterate?.input === "string" ? r.iterate.input : "";
  const iterate = iterateInput.trim() ? { input: iterateInput.trim() } : undefined;
  if (iterate) for (const p of inputs) if (p.key === iterate.input) p.required = true;
  const read = kind === "actions" ? routineActions(r) : null;
  const draft: RoutineDraft = {
    name: String(r.name || "New routine").slice(0, 80),
    description: String(r.description || "").slice(0, 400),
    appId: String(r.app || appId),
    steps: strings(r.steps, 8).map((text) => ({ id: newId(), plainLanguage: text })),
    inputs,
    outputs,
    settings,
    ...(iterate ? { iterate } : {}),
    kind,
    script: kind === "script" ? (typeof r.script === "string" ? r.script : typeof r.body === "string" ? r.body : "").trim() : "",
    ...(read ? { actions: "actions" in read ? read.actions : [] } : {}),
    appVersion,
    requiredFonts: strings(r.requiredFonts, 10),
    modifiesDocument: r.modifiesDocument === true,
    qcProfile: r.qcProfile === "print" ? "print" : "web",
    keyObjects: strings(r.keyObjects, 2),
    objectChecks: list(r.objectChecks)
      .filter((c: any) => c && typeof c.object === "string" && typeof c.region === "string")
      .slice(0, 4)
      .map((c: any) => ({ object: c.object, region: c.region })),
  };
  if (read && "problem" in read) actionProblems.set(draft, read.problem);
  return draft;
}

/** A Figma action list as the model writes it: JSON text inside the routine's JSON. */
const ACTIONS_TEXT_EXAMPLE = JSON.stringify(JSON.stringify([{ action: "duplicateNode", id: "label", node: "Label" }]));

/** Validation errors in the model's terms (an unreadable action list explained, not "too small"). */
export function errorsForModel(errors: ValidationError[], draft: RoutineDraft): ValidationError[] {
  return errors.map((e) => {
    if (e.path === "actions" && draft.kind === "actions" && !draft.actions?.length) {
      const problem = actionsProblem(draft) ?? 'its "actions" text is missing or empty.';
      return {
        ...e,
        message: `The routine has no readable actions: ${problem} "actions" is the action list written as JSON text (a string), e.g. "actions": ${ACTIONS_TEXT_EXAMPLE}.`,
      };
    }
    return e;
  });
}

/** A routine (or draft) the way the model writes one, for repairs and flow context. */
export function routineForModel(r: Pick<Routine, "name" | "description" | "appId" | "inputs" | "outputs" | "settings" | "iterate" | "steps" | "kind" | "script" | "actions" | "modifiesDocument" | "qcProfile" | "keyObjects" | "objectChecks">) {
  return {
    name: r.name,
    description: r.description,
    app: r.appId,
    inputs: r.inputs,
    settings: r.settings,
    ...(r.iterate ? { iterate: r.iterate } : {}),
    outputs: r.outputs,
    steps: r.steps.map((s) => s.plainLanguage),
    modifiesDocument: r.modifiesDocument,
    qcProfile: r.qcProfile,
    keyObjects: r.keyObjects ?? [],
    objectChecks: r.objectChecks ?? [],
    ...(r.kind === "actions" ? { actions: JSON.stringify(r.actions ?? []) } : { script: r.script }),
  };
}

// ---------- Flow plans ----------

function planRoutine(raw: Record<string, any>, i: number): FlowPlanRoutine {
  const r = recoverKeys(raw, PLAN_ROUTINE_KEYS);
  const id = String(r?.id ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) throw new RoutineFormatError(`routines[${i}] needs an "id" (letters, digits and _), e.g. "cutouts".`);
  const iterateInput = typeof r.iterate === "string" ? r.iterate : typeof r.iterate?.input === "string" ? r.iterate.input : "";
  const inputs = ports(r.inputs, "inputs");
  if (iterateInput) for (const p of inputs) if (p.key === iterateInput) p.required = true;
  return {
    id,
    name: String(r.name || id).slice(0, 80),
    appId: String(r.app ?? r.appId ?? ""),
    purpose: String(r.purpose || "").slice(0, 400),
    inputs,
    outputs: ports(r.outputs, "outputs"),
    ...(iterateInput ? { iterate: { input: iterateInput } } : {}),
  };
}

function toMatch(raw: any): MatchRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const optional = raw.optional === true ? { optional: true } : {};
  if (raw.by === "index") return { by: "index", ...optional };
  // Names in designers' files are rarely exact: the model's rules match loosely.
  if (raw.by === "fileNameEqualsColumn" && typeof raw.column === "string") return { by: "fileNameEqualsColumn", column: raw.column, ignoreExtension: raw.ignoreExtension !== false, loose: true, ...optional };
  if (raw.by === "columnEquals" && typeof raw.leftColumn === "string" && typeof raw.rightColumn === "string") {
    return { by: "columnEquals", leftColumn: raw.leftColumn, rightColumn: raw.rightColumn, ...optional };
  }
  if (raw.by === "sameFileName") return { by: "sameFileName", ...optional };
  return undefined;
}

/** Turns the model's flow plan into a FlowPlan. The plan validator checks how it connects. */
export function toFlowPlan(raw: Record<string, any> | undefined): FlowPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoutineFormatError('The answer didn\'t contain a plan (put it in "plan").');
  const p = recoverKeys(raw, PLAN_KEYS);
  const routines = list(p.routines).map(planRoutine);
  if (routines.length === 0) throw new RoutineFormatError("The plan has no routines.");
  return {
    name: String(p.name || "New flow").slice(0, 80),
    description: String(p.description || "").slice(0, 400),
    inputs: ports(p.inputs, "inputs"),
    outputs: ports(p.outputs, "outputs"),
    routines,
    connections: list(p.connections)
      .filter((c) => c && typeof c.from === "string" && typeof c.to === "string")
      .map((c) => ({ from: c.from.trim(), to: c.to.trim(), ...(toMatch(c.match) ? { match: toMatch(c.match)! } : {}) })),
  };
}

/** Where a plan connection end points: a flow input, a routine port, or a flow output. */
export function planEnd(ref: string): { kind: "input" | "routine" | "output"; id: string; port: string } | null {
  const [head, ...rest] = ref.split(".");
  if (!head || rest.length !== 1) return null;
  if (head === "input") return { kind: "input", id: rest[0], port: rest[0] };
  if (head === "output") return { kind: "output", id: rest[0], port: rest[0] };
  return { kind: "routine", id: head, port: rest[0] };
}

/** Problems with a plan, as messages for the model: unknown apps, broken connections, joins without a rule. */
export function planProblems(plan: FlowPlan, apps: AppId[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const [i, r] of plan.routines.entries()) {
    if (ids.has(r.id)) problems.push(`routines[${i}]: two routines have the id "${r.id}".`);
    ids.add(r.id);
    if (!apps.includes(r.appId)) problems.push(`routines[${i}] ("${r.id}"): "app" must be one of ${apps.join(", ")}; each routine works in one app.`);
    if (r.iterate) {
      const port = r.inputs.find((p) => p.key === r.iterate!.input);
      if (!port || !isListType(port.type)) problems.push(`routines[${i}] ("${r.id}"): iterate.input must be one of its rows or fileList inputs.`);
    }
  }
  const usedApps = new Set(plan.routines.map((r) => r.appId));
  for (const app of apps) if (!usedApps.has(app)) problems.push(`No routine works in ${app}, but the designer picked it for this task.`);
  const routine = (id: string) => plan.routines.find((r) => r.id === id);
  const fed = new Set<string>();
  const edges: { from: { nodeId: string }; to: { nodeId: string } }[] = [];
  for (const [i, c] of plan.connections.entries()) {
    const at = `connections[${i}] (${c.from} → ${c.to})`;
    const from = planEnd(c.from);
    const to = planEnd(c.to);
    if (!from || from.kind === "output") {
      problems.push(`${at}: "from" must be "input.<key>" or "<routine id>.<output key>".`);
      continue;
    }
    if (!to || to.kind === "input") {
      problems.push(`${at}: "to" must be "<routine id>.<input key>" or "output.<key>".`);
      continue;
    }
    let fromSpec;
    if (from.kind === "input") {
      const port = plan.inputs.find((p) => p.key === from.port);
      if (!port) {
        problems.push(`${at}: the plan has no input "${from.port}".`);
        continue;
      }
      fromSpec = inputSpec(port);
    } else {
      const r = routine(from.id);
      const port = r?.outputs.find((p) => p.key === from.port);
      if (!r || !port) {
        problems.push(`${at}: ${r ? `routine "${r.id}" has no output "${from.port}"` : `there is no routine "${from.id}"`}.`);
        continue;
      }
      fromSpec = outputSpec(port, !!r.iterate, r.appId);
    }
    if (to.kind === "output") {
      if (!plan.outputs.some((p) => p.key === to.port)) problems.push(`${at}: the plan has no output "${to.port}".`);
      if (from.kind === "routine") edges.push({ from: { nodeId: from.id }, to: { nodeId: `output.${to.port}` } });
      continue;
    }
    const r = routine(to.id);
    const port = r?.inputs.find((p) => p.key === to.port);
    if (!r || !port) {
      problems.push(`${at}: ${r ? `routine "${r.id}" has no input "${to.port}"` : `there is no routine "${to.id}"`}.`);
      continue;
    }
    if (fed.has(c.to)) problems.push(`${at}: "${c.to}" already gets a value from another connection.`);
    fed.add(c.to);
    const fit = compatible(fromSpec, inputSpec(port, r.appId));
    if (!fit.ok) problems.push(`${at}: ${fit.reason}`);
    const join = r.iterate && r.iterate.input !== port.key && isListType(port.type);
    if (join && !c.match) problems.push(`${at}: "${r.id}" iterates over "${r.iterate!.input}", so this second list needs a "match" rule (index, fileNameEqualsColumn, columnEquals or sameFileName).`);
    if (join && c.match) {
      const iterPort = r.inputs.find((p) => p.key === r.iterate!.input)!;
      const bad = ruleProblem(c.match, iterPort.type as "rows" | "fileList", port.type as "rows" | "fileList");
      if (bad) problems.push(`${at}: ${bad}`);
    }
    if (from.kind === "routine") edges.push({ from: { nodeId: from.id }, to: { nodeId: to.id } });
  }
  for (const r of plan.routines) {
    for (const p of r.inputs) {
      if (p.required && p.type !== "document" && !fed.has(`${r.id}.${p.key}`)) problems.push(`Input "${r.id}.${p.key}" is required but nothing connects to it.`);
    }
  }
  const { cycle } = topoOrder(plan.routines.map((r) => r.id), edges);
  if (cycle.length) problems.push(`The routines ${cycle.join(", ")} feed each other in a circle; a flow runs in one direction.`);
  return problems;
}

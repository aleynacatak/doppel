import { layoutLeftToRight } from "../../shared/flowGraph";
import type { AppId, Flow, FlowEdge, FlowNode, NodeProgress, ParamDef, PortDef, Routine, RoutineVersion, Run, RunOutput, SettingDef } from "../types";
import { findPlaceholders, onlyPlaceholder, rewritePlaceholders } from "./placeholders";
import { toSetting } from "./modelRoutine";
import { normalizeExtensions } from "../../shared/ports";

// Older routines had params (picked at each run) and, for several apps, stages that passed files along through
// {{stage.<id>.outputs.<key>}}. These pure functions turn them into routines with inputs, outputs and settings,
// and a multi-stage routine into a flow of single-app routines. services/routineMigration.ts applies them to the
// files on disk, with a backup.

/** The shape of routine files before format 2. */
export interface LegacyStage {
  id: string;
  name: string;
  appId: AppId;
  kind: "actions" | "script";
  body: { actions: Record<string, unknown>[] } | string;
  repeat?: { over: string };
  inputs?: string[];
  outputs?: { key: string; type: "fileList" | "file" | "nodeList" | "data"; label?: string }[];
  steps?: string[];
  document?: "open" | "none";
  modifiesDocument?: boolean;
}

export type LegacyRoutine = Omit<Routine, "inputs" | "outputs" | "settings" | "kind" | "format" | "iterate" | "matches" | "actions"> & {
  params?: ParamDef[];
  stages?: LegacyStage[];
  lastParams?: Record<string, unknown>;
};

const FILE_PARAMS = ["file", "folder", "dataFile"];

/** A param that is a location or data becomes an input; anything else a setting. */
export function paramToPort(p: ParamDef): PortDef {
  const type = p.type === "dataFile" ? "rows" : (p.type as "file" | "folder");
  const extensions = normalizeExtensions(p.extensions);
  return {
    key: p.key,
    label: p.label || p.key,
    type,
    required: p.required !== false,
    ...(p.help ? { description: p.help } : {}),
    ...(type === "file" && extensions.length ? { extensions } : {}),
    ...(type === "rows" && p.columns?.length ? { columns: [...p.columns] } : {}),
  };
}

export function paramsToContract(params: ParamDef[], appId: AppId): { inputs: PortDef[]; settings: SettingDef[] } {
  const inputs: PortDef[] = [];
  const settings: SettingDef[] = [];
  for (const p of params) {
    if (FILE_PARAMS.includes(p.type)) inputs.push(paramToPort(p));
    else {
      const s = toSetting({ ...p }, appId);
      if (s) settings.push({ ...s, required: p.required === true });
    }
  }
  return { inputs, settings };
}

const uniqueKey = (wanted: string, taken: Set<string>) => {
  let key = wanted;
  for (let n = 2; taken.has(key); n++) key = `${wanted}${n}`;
  taken.add(key);
  return key;
};

/** A single-app routine with params: its params become inputs and settings; it keeps working on the open document. */
export function legacyRoutineToContract(raw: LegacyRoutine): Routine {
  const { params = [], stages: _stages, lastParams: _last, ...rest } = raw;
  const { inputs, settings } = paramsToContract(params, raw.appId);
  const taken = new Set([...inputs.map((p) => p.key), ...settings.map((s) => s.key)]);
  const docKey = uniqueKey("document", taken);
  return {
    ...rest,
    inputs: [{ key: docKey, label: "Document", type: "document", required: true }, ...inputs],
    outputs: [],
    settings,
    kind: "script",
    script: raw.script ?? "",
    format: 2,
  };
}

/** Port key for an earlier stage's output: {{stage.s1.outputs.files}} → "s1Files". */
const stageOutputKey = (stageId: string, key: string) => `${stageId}${key.charAt(0).toUpperCase()}${key.slice(1)}`;

/** The params and earlier-stage outputs a stage reads, from its placeholders and script. */
function stageRefs(stage: LegacyStage) {
  const params = new Set<string>();
  const outputs = new Set<string>();
  const exprs = [
    ...(stage.kind === "actions" ? findPlaceholders(stage.body).map((p) => p.expr) : []),
    ...findPlaceholders(stage.inputs ?? []).map((p) => p.expr),
    ...(stage.repeat ? [onlyPlaceholder(stage.repeat.over) ?? ""] : []),
  ];
  for (const e of exprs) {
    const parts = e.split(".");
    if (parts[0] === "params" && parts[1]) params.add(parts[1]);
    if (parts[0] === "stage" && parts[2] === "outputs" && parts[3]) outputs.add(`${parts[1]}.${parts[3]}`);
  }
  if (stage.kind === "script" && typeof stage.body === "string") {
    for (const m of stage.body.matchAll(/\bparams\.([A-Za-z_$][\w$]*)/g)) params.add(m[1]);
    for (const m of stage.body.matchAll(/\bctx\.stages\.([A-Za-z_]\w*)\.outputs\.([A-Za-z_]\w*)/g)) outputs.add(`${m[1]}.${m[2]}`);
  }
  return { params, outputs };
}

const outputPort = (o: NonNullable<LegacyStage["outputs"]>[number]): PortDef => ({
  key: o.key,
  label: o.label || o.key,
  type: o.type === "file" ? "file" : o.type === "fileList" ? "fileList" : "rows",
  required: true,
});

/**
 * A multi-stage routine becomes a flow plus one routine per stage. Params become the flow's input nodes (and each
 * routine's inputs or settings); an earlier stage's output becomes an edge into an input of the later routine.
 * Placeholders and scripts are rewritten to the routine's own inputs. Versions and history stay; the AI calls
 * the routine was created with move to the flow (each routine shows 0, so nothing counts twice).
 */
export function stagedRoutineToFlow(raw: LegacyRoutine, makeId: () => string): { flow: Flow; routines: Routine[]; nodeOfStage: Record<string, string> } {
  const stages = raw.stages ?? [];
  const params = raw.params ?? [];
  const paramOf = (key: string) => params.find((p) => p.key === key);
  const nodeOfStage = Object.fromEntries(stages.map((s) => [s.id, `node-${s.id}`]));
  const iteratedParams = new Set(
    stages.flatMap((s) => {
      const parts = (onlyPlaceholder(s.repeat?.over) ?? "").split(".");
      return parts[0] === "params" && parts[2] === "files" ? [parts[1]] : [];
    }),
  );
  const inputNodeType = (p: ParamDef): PortDef => (iteratedParams.has(p.key) ? { ...paramToPort(p), type: "fileList" } : paramToPort(p));

  const routines: Routine[] = [];
  const edges: FlowEdge[] = [];
  const usedParams = new Set<string>();
  const versions: RoutineVersion[] = (raw.versions ?? []).map((v) => ({ ...v, aiCalls: 0, note: `${v.note} (from “${raw.name}”)` }));

  for (const [i, stage] of stages.entries()) {
    const refs = stageRefs(stage);
    const inputs: PortDef[] = [];
    const settings: SettingDef[] = [];
    const taken = new Set<string>();
    const portForParam = new Map<string, string>();
    for (const key of refs.params) {
      const p = paramOf(key);
      if (!p) continue;
      taken.add(key);
      if (FILE_PARAMS.includes(p.type)) {
        inputs.push(inputNodeType(p));
        portForParam.set(key, "inputs");
        usedParams.add(key);
      } else {
        const s = toSetting({ ...p }, stage.appId);
        if (s) settings.push({ ...s, required: p.required === true });
        portForParam.set(key, "settings");
      }
    }
    const portForOutput = new Map<string, string>();
    for (const ref of refs.outputs) {
      const [from, key] = ref.split(".");
      const source = stages.find((s) => s.id === from);
      const out = source?.outputs?.find((o) => o.key === key);
      if (!source || !out) continue;
      const portKey = uniqueKey(stageOutputKey(from, key), taken);
      portForOutput.set(ref, portKey);
      const type = out.type === "data" || out.type === "nodeList" ? "rows" : "fileList";
      inputs.push({ key: portKey, label: `${out.label || key} from ${source.name}`, type, required: true });
      edges.push({ id: makeId(), from: { nodeId: nodeOfStage[from], port: key }, to: { nodeId: nodeOfStage[stage.id], port: portKey } });
    }
    if ((stage.document ?? "open") === "open") inputs.unshift({ key: uniqueKey("document", taken), label: "Document", type: "document", required: true });

    const rewrite = (expr: string) => {
      const parts = expr.split(".");
      if (parts[0] === "params" && parts[1]) return [portForParam.get(parts[1]) ?? "inputs", ...parts.slice(1)].join(".");
      if (parts[0] === "stage" && parts[2] === "outputs") return ["inputs", portForOutput.get(`${parts[1]}.${parts[3]}`) ?? parts[3], ...parts.slice(4)].join(".");
      return expr;
    };
    const over = onlyPlaceholder(stage.repeat?.over);
    const overParts = over?.split(".") ?? [];
    const iterate =
      overParts[0] === "params" && overParts[1]
        ? { input: overParts[1] }
        : overParts[0] === "stage" && portForOutput.get(`${overParts[1]}.${overParts[3]}`)
          ? { input: portForOutput.get(`${overParts[1]}.${overParts[3]}`)! }
          : undefined;
    // A second list into a routine that iterates pairs item by item (the same data row).
    if (iterate) {
      for (const e of edges) {
        if (e.to.nodeId === nodeOfStage[stage.id] && e.to.port !== iterate.input) e.match = { by: "index" };
      }
    }
    const script =
      stage.kind === "script" && typeof stage.body === "string"
        ? stage.body.replace(/\bctx\.stages\.([A-Za-z_]\w*)\.outputs\.([A-Za-z_]\w*)/g, (all, from: string, key: string) => {
            const port = portForOutput.get(`${from}.${key}`);
            return port ? `params.${port}` : all;
          })
        : "";
    const last = i === stages.length - 1;
    routines.push({
      id: makeId(),
      name: `${raw.name} · ${stage.name}`.slice(0, 80),
      appId: stage.appId,
      description: raw.description,
      steps: (stage.steps ?? []).map((text) => ({ id: makeId(), plainLanguage: text })),
      inputs,
      outputs: (stage.outputs ?? []).map(outputPort),
      settings,
      ...(iterate ? { iterate } : {}),
      kind: stage.kind,
      script,
      ...(stage.kind === "actions" ? { actions: rewritePlaceholders((stage.body as { actions: Record<string, unknown>[] }).actions, rewrite) as Routine["actions"] } : {}),
      version: raw.version,
      createdWithAiCalls: 0,
      appVersion: i === 0 ? raw.appVersion : "",
      requiredFonts: raw.requiredFonts ?? [],
      runs: [],
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      versions,
      modifiesDocument: stage.modifiesDocument === true,
      qcProfile: raw.qcProfile,
      ...(last && raw.keyObjects?.length ? { keyObjects: raw.keyObjects } : {}),
      ...(last && raw.objectChecks?.length ? { objectChecks: raw.objectChecks } : {}),
      format: 2,
    });
  }

  // Params become input nodes, connected to every routine that uses them.
  const nodes: FlowNode[] = [];
  for (const key of usedParams) {
    const p = paramOf(key)!;
    const nodeId = `input-${key}`;
    nodes.push({ id: nodeId, kind: "input", port: inputNodeType(p), position: { x: 0, y: 0 } });
    stages.forEach((s, i) => {
      if (routines[i].inputs.some((port) => port.key === key)) {
        const edge: FlowEdge = { id: makeId(), from: { nodeId, port: key }, to: { nodeId: nodeOfStage[s.id], port: key } };
        if (routines[i].iterate && routines[i].iterate!.input !== key && ["rows", "fileList"].includes(routines[i].inputs.find((x) => x.key === key)!.type)) edge.match = { by: "index" };
        edges.push(edge);
      }
    });
  }
  stages.forEach((s, i) => nodes.push({ id: nodeOfStage[s.id], kind: "routine", routineId: routines[i].id, routineVersion: routines[i].version, position: { x: 0, y: 0 } }));
  const positions = layoutLeftToRight(
    nodes.map((n) => n.id),
    edges,
  );
  for (const n of nodes) n.position = positions.get(n.id)!;

  const flow: Flow = {
    id: makeId(),
    name: raw.name,
    description: raw.description,
    version: raw.version,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    nodes,
    edges,
    runs: raw.runs ?? [],
    createdWithAiCalls: raw.createdWithAiCalls ?? 0,
  };
  return { flow, routines, nodeOfStage };
}

/** The shape of run files before format 2. */
interface LegacyRun {
  id: string;
  routineId: string;
  routineName: string;
  routineVersion: number;
  appId: AppId;
  params?: Record<string, unknown>;
  qcMode: Run["qcMode"];
  options: { target?: "copy" | "original"; documentId?: string; documents?: Partial<Record<AppId, string>>; qcOptions?: Run["options"]["qcOptions"] };
  status: Run["status"];
  aiCalls: number;
  outputs: (RunOutput & { stageId?: string })[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  errorDetail?: string;
  log?: string[];
  findings?: Run["findings"];
  stages?: (Omit<NodeProgress, "nodeId" | "kind"> & { stageId: string })[];
}

export const isLegacyRun = (raw: unknown): boolean => !!raw && typeof raw === "object" && !("target" in raw) && "routineId" in raw;

/** An older run, as a run of the routine (or of the flow its stages became). */
export function legacyRunToRun(raw: LegacyRun, target: Run["target"], nodeOfStage: Record<string, string> = {}): Run {
  const routineNode = (stageId?: string) => (stageId ? (nodeOfStage[stageId] ?? stageId) : "routine");
  return {
    id: raw.id,
    target,
    name: raw.routineName,
    version: raw.routineVersion,
    appIds: raw.stages?.length ? [...new Set(raw.stages.map((s) => s.appId!))] : [raw.appId],
    inputs: {},
    outputFolders: {},
    qcMode: raw.qcMode,
    options: {
      target: raw.options?.target ?? "copy",
      documents: raw.options?.documents ?? (raw.options?.documentId ? { [raw.appId]: raw.options.documentId } : {}),
      ...(raw.options?.qcOptions ? { qcOptions: raw.options.qcOptions } : {}),
    },
    status: raw.status,
    aiCalls: raw.aiCalls ?? 0,
    outputs: (raw.outputs ?? []).map(({ stageId, ...o }) => ({ ...o, node: routineNode(stageId) })),
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    error: raw.error,
    errorDetail: raw.errorDetail,
    log: raw.log,
    findings: raw.findings,
    nodes: raw.stages?.length
      ? raw.stages.map(({ stageId, ...s }) => ({ ...s, nodeId: routineNode(stageId), kind: "routine" as const }))
      : [
          {
            nodeId: "routine",
            kind: "routine",
            name: raw.routineName,
            appId: raw.appId,
            status: raw.status === "succeeded" ? "done" : raw.status === "running" ? "failed" : raw.status,
            total: raw.outputs?.length ?? 0,
            done: raw.outputs?.filter((o) => o.status === "done").length ?? 0,
            failed: raw.outputs?.filter((o) => o.status === "failed").length ?? 0,
            items: [],
            error: raw.error,
          },
        ],
    edges: [],
  };
}

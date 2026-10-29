import type { AdapterRegistry } from "../../adapters/registry";
import { acceptedByOutput, compatible, inputSpec, isListType, outputSpec } from "../../shared/ports";
import { previewPairs, suggestMatch, type ListType } from "../flows/match";
import { type FlowRoutines, isJoin, routineOf, sourceSpec, validateFlow } from "../flows/validateFlow";
import { type ListItem, resolveInput } from "../flows/values";
import { topoOrder } from "../../shared/flowGraph";
import { contractChanges, isBreaking } from "../../shared/routineDiff";
import type { AppId, ConverterOption, ExecutionPlan, Flow, FlowContext, FlowEdge, FlowNode, InputValue, MatchPreview, MatchRule, PortDef, Routine, RoutineDraft, RoutineUsage } from "../types";
import { errorMessage, newId, nowIso } from "../util";
import type { LibraryService } from "./libraryService";
import type { StarterService } from "./starterService";
import type { Storage } from "./storage";

/** Node ids of a routine run as a one-node flow: "input-<key>", "routine", "output-<key>". */
export const ROUTINE_NODE = "routine";
export const inputNodeId = (key: string) => `input-${key}`;
export const outputNodeId = (key: string) => `output-${key}`;

/** Output types a routine run offers to save to a folder. */
const SAVABLE = ["file", "fileList", "rows", "folder"];

/** A routine as a flow of one node: its inputs as input nodes, its file and data outputs as "Save to folder" nodes. */
export function routineFlow(routine: Routine, matches: Record<string, MatchRule> = {}): Flow {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const inputs = routine.inputs.filter((p) => p.type !== "document");
  inputs.forEach((port, i) => {
    nodes.push({ id: inputNodeId(port.key), kind: "input", port: { ...port }, position: { x: 0, y: i * 160 } });
    const edge: FlowEdge = { id: `edge-in-${port.key}`, from: { nodeId: inputNodeId(port.key), port: port.key }, to: { nodeId: ROUTINE_NODE, port: port.key } };
    if (routine.iterate && routine.iterate.input !== port.key && isListType(port.type)) edge.match = matches[port.key] ?? routine.matches?.[port.key] ?? { by: "index" };
    edges.push(edge);
  });
  nodes.push({ id: ROUTINE_NODE, kind: "routine", routineId: routine.id, routineVersion: routine.version, position: { x: 320, y: 0 } });
  routine.outputs
    .filter((p) => SAVABLE.includes(p.type))
    .forEach((port, i) => {
      nodes.push({ id: outputNodeId(port.key), kind: "output", port: { ...port, required: false }, position: { x: 640, y: i * 160 } });
      edges.push({ id: `edge-out-${port.key}`, from: { nodeId: ROUTINE_NODE, port: port.key }, to: { nodeId: outputNodeId(port.key), port: port.key } });
    });
  return {
    id: `routine-${routine.id}`,
    name: routine.name,
    description: routine.description,
    version: routine.version,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
    nodes,
    edges,
    runs: [],
    createdWithAiCalls: routine.createdWithAiCalls,
  };
}

/** Flows: saved anytime, run when valid. Routine nodes pin a routine version. */
export class FlowService {
  constructor(private readonly deps: { storage: Storage; library: LibraryService; starters: StarterService; registry: AdapterRegistry }) {}

  async list(): Promise<Flow[]> {
    const flows = await this.deps.storage.listFlows();
    const out: Flow[] = [];
    for (const f of flows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) out.push({ ...f, appIds: await this.appsOf(f) });
    return out;
  }

  /** Every app a flow's routines use, in node order. */
  private async appsOf(flow: Flow): Promise<AppId[]> {
    const apps: AppId[] = [];
    for (const n of flow.nodes) {
      if (n.kind !== "routine") continue;
      const r = await this.deps.library.get(n.routineId);
      if (r && !apps.includes(r.appId)) apps.push(r.appId);
    }
    return apps;
  }

  get(id: string) {
    return this.deps.storage.getFlow(id);
  }

  async require(id: string): Promise<Flow> {
    const flow = await this.get(id);
    if (!flow) throw new Error("This flow doesn't exist anymore.");
    return flow;
  }

  async create(name: string): Promise<Flow> {
    const now = nowIso();
    const flow: Flow = { id: newId(), name: name.trim() || "New flow", description: "", version: 1, createdAt: now, updatedAt: now, nodes: [], edges: [], runs: [], createdWithAiCalls: 0 };
    await this.deps.storage.saveFlow(flow);
    return flow;
  }

  /** Saves the flow as it is (valid or not). Its run history stays as stored. */
  async save(flow: Flow): Promise<Flow> {
    const stored = await this.get(flow.id);
    const { appIds: _apps, ...rest } = flow;
    const next: Flow = {
      ...rest,
      name: flow.name.trim() || "Untitled flow",
      version: stored ? stored.version + 1 : flow.version || 1,
      createdAt: stored?.createdAt ?? flow.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      runs: stored?.runs ?? flow.runs ?? [],
      createdWithAiCalls: stored?.createdWithAiCalls ?? flow.createdWithAiCalls ?? 0,
    };
    await this.deps.storage.saveFlow(next);
    return { ...next, appIds: await this.appsOf(next) };
  }

  delete(id: string) {
    return this.deps.storage.deleteFlow(id);
  }

  /** Each routine node's pinned routine (or why it's missing), for validation and runs. */
  async routinesOf(flow: Flow): Promise<FlowRoutines> {
    const routines: FlowRoutines["routines"] = {};
    for (const node of flow.nodes) {
      if (node.kind !== "routine") continue;
      const pinned = await this.deps.library.getVersion(node.routineId, node.routineVersion);
      routines[node.id] = pinned ?? ((await this.deps.library.get(node.routineId)) ? "missing-version" : "missing-routine");
    }
    return {
      routines,
      stageKind: (appId) => (this.deps.registry.list().some((a) => a.id === appId) ? this.deps.registry.get(appId).stageKind : null),
    };
  }

  async context(flow: Flow): Promise<FlowContext> {
    const info = await this.routinesOf(flow);
    const routines: Record<string, Routine> = {};
    const latest: Record<string, number> = {};
    for (const node of flow.nodes) {
      if (node.kind !== "routine") continue;
      const r = routineOf(info, node.id);
      if (r) routines[node.id] = r;
      const newest = await this.deps.library.get(node.routineId);
      if (newest) latest[node.routineId] = newest.version;
    }
    return { routines, latest, validation: validateFlow(flow, info) };
  }

  /** Pins a routine node to a version (after "Update" or "Make compatible"), and saves the flow. */
  async pinVersion(flowId: string, nodeId: string, version: number): Promise<Flow> {
    const flow = await this.require(flowId);
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (node?.kind !== "routine") throw new Error("That node isn't a routine anymore.");
    node.routineVersion = version;
    return this.save(flow);
  }

  /** Flows that use a routine, the versions their nodes pin, and whether its newest version fits them. */
  async usage(routineId: string): Promise<RoutineUsage[]> {
    const latest = await this.deps.library.get(routineId);
    if (!latest) return [];
    const out: RoutineUsage[] = [];
    for (const flow of await this.deps.storage.listFlows()) {
      const nodes = flow.nodes.flatMap((n) => (n.kind === "routine" && n.routineId === routineId ? [{ nodeId: n.id, version: n.routineVersion }] : []));
      if (!nodes.length) continue;
      const changes = [];
      for (const v of new Set(nodes.map((n) => n.version))) {
        if (v === latest.version) continue;
        const pinned = await this.deps.library.getVersion(routineId, v);
        if (pinned) changes.push(...contractChanges(pinned, latest));
      }
      out.push({ flowId: flow.id, name: flow.name, nodes, latest: latest.version, compatible: !isBreaking(changes), changes });
    }
    return out;
  }

  /**
   * What updating each flow's nodes to a draft (a refine under review) would break: new problems on those nodes and
   * their connections, per flow.
   */
  async impactOf(routineId: string, draft: RoutineDraft): Promise<{ flowId: string; name: string; nodes: number; issues: string[] }[]> {
    const out = [];
    for (const flow of await this.deps.storage.listFlows()) {
      const ids = flow.nodes.filter((n) => n.kind === "routine" && n.routineId === routineId).map((n) => n.id);
      if (!ids.length) continue;
      const info = await this.routinesOf(flow);
      const before = new Set(validateFlow(flow, info).issues.map((i) => i.message));
      const routines = { ...info.routines };
      for (const id of ids) {
        const pinned = routines[id];
        if (typeof pinned === "object") routines[id] = { ...pinned, ...draft, id: pinned.id, version: pinned.version + 1 };
      }
      const touched = new Set([...ids, ...flow.edges.filter((e) => ids.includes(e.from.nodeId) || ids.includes(e.to.nodeId)).map((e) => e.id)]);
      const issues = validateFlow(flow, { ...info, routines })
        .issues.filter((i) => (i.nodeId && touched.has(i.nodeId)) || (i.edgeId && touched.has(i.edgeId)))
        .map((i) => i.message)
        .filter((m) => !before.has(m));
      out.push({ flowId: flow.id, name: flow.name, nodes: ids.length, issues: [...new Set(issues)] });
    }
    return out;
  }

  /** Moves nodes to the routine's newest version in every flow where that's a compatible change; the rest stay. */
  async updateAll(routineId: string): Promise<{ updated: string[]; skipped: { name: string; reason: string }[] }> {
    const latest = await this.deps.library.require(routineId);
    const updated: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const use of await this.usage(routineId)) {
      if (use.nodes.every((n) => n.version === latest.version)) continue;
      if (!use.compatible) {
        skipped.push({ name: use.name, reason: use.changes.filter((c) => c.breaking).map((c) => c.message).join(" ") });
        continue;
      }
      const flow = await this.require(use.flowId);
      for (const n of flow.nodes) if (n.kind === "routine" && n.routineId === routineId) n.routineVersion = latest.version;
      await this.save(flow);
      updated.push(use.name);
    }
    return { updated, skipped };
  }

  /** Points a flow node at another routine (a refined copy of a starter), when its connections still fit. */
  async repointNode(flowId: string, nodeId: string, routineId: string, version: number): Promise<boolean> {
    const flow = await this.require(flowId);
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (node?.kind !== "routine") return false;
    const next = structuredClone(flow);
    const target = next.nodes.find((n) => n.id === nodeId) as Extract<FlowNode, { kind: "routine" }>;
    target.routineId = routineId;
    target.routineVersion = version;
    const before = validateFlow(flow, await this.routinesOf(flow)).issues.length;
    if (validateFlow(next, await this.routinesOf(next)).issues.length > before) return false;
    await this.save(next);
    return true;
  }

  /** What reaches an edge's source, as a list, from what is picked for input nodes or from the flow's last run. */
  private async listAt(flow: Flow, nodeId: string, port: string, picked: Record<string, InputValue>): Promise<{ type: ListType; items: ListItem[]; columns?: string[] } | null> {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    if (node.kind === "input") {
      try {
        const { value } = await resolveInput(node.port, picked[node.id]);
        return value?.kind === "list" ? { type: value.type, items: value.items, columns: value.columns } : null;
      } catch {
        return null;
      }
    }
    if (node.kind !== "routine") return null;
    // A routine's files from the last run of the flow.
    const last = flow.runs[0] ? await this.deps.storage.getRun(flow.runs[0].id) : null;
    const files = (last?.outputs ?? []).filter((o) => o.node === nodeId && o.status === "done" && o.filePath);
    return files.length ? { type: "fileList", items: files.map((o) => ({ key: o.itemKey ?? o.id, label: o.label, value: o.filePath! })) } : null;
  }

  /** The pairs a join makes; with no rule, the suggested one. */
  async previewMatch(flow: Flow, edgeId: string, rule: MatchRule | null, inputs?: Record<string, InputValue>): Promise<MatchPreview & { rule: MatchRule | null }> {
    const edge = flow.edges.find((e) => e.id === edgeId);
    const info = await this.routinesOf(flow);
    if (!edge || !isJoin(edge, flow, info)) return { pairs: [], total: 0, unmatched: 0, note: "This connection doesn't pair items.", rule: null };
    const routine = routineOf(info, edge.to.nodeId)!;
    const iterPort = routine.inputs.find((p) => p.key === routine.iterate!.input)!;
    const joinedPort = routine.inputs.find((p) => p.key === edge.to.port)!;
    const iterEdge = flow.edges.find((e) => e.to.nodeId === edge.to.nodeId && e.to.port === iterPort.key);
    const picked = { ...((await this.deps.storage.getLastValues(`flow:${flow.id}`))?.inputs ?? {}), ...(inputs ?? {}) };
    const iter = iterEdge ? await this.listAt(flow, iterEdge.from.nodeId, iterEdge.from.port, picked) : null;
    const joined = await this.listAt(flow, edge.from.nodeId, edge.from.port, picked);
    const suggested =
      rule ??
      suggestMatch(
        iter ?? { type: iterPort.type as ListType, items: [], columns: iterPort.columns },
        joined ?? { type: joinedPort.type as ListType, items: [], columns: joinedPort.columns },
      );
    if (!iter || !joined) {
      return { pairs: [], total: 0, unmatched: 0, note: "Pick the files and data first (or run it once) to see how items pair.", rule: suggested };
    }
    try {
      return { ...previewPairs(suggested, { type: iter.type, items: iter.items }, { type: joined.type, items: joined.items, label: joinedPort.label }), rule: suggested };
    } catch (err) {
      return { pairs: [], total: 0, unmatched: 0, note: errorMessage(err), rule: suggested };
    }
  }

  /**
   * The order a flow runs in, with item counts (known for inputs that are picked, carried along for routines that
   * iterate) and the first pairs of every join. Dev panel; nothing runs.
   */
  async plan(flow: Flow, picked: Record<string, InputValue>): Promise<ExecutionPlan> {
    const info = await this.routinesOf(flow);
    const validation = validateFlow(flow, info);
    const { order } = topoOrder(
      flow.nodes.map((n) => n.id),
      flow.edges,
    );
    const counts = new Map<string, number | null>();
    const steps: ExecutionPlan["steps"] = [];
    for (const id of order) {
      const node = flow.nodes.find((n) => n.id === id)!;
      if (node.kind === "input") {
        let items: number | null = null;
        let note: string | undefined;
        try {
          const { value, problems } = await resolveInput(node.port, picked[id]);
          items = value ? (value.kind === "list" ? value.items.length : 1) : null;
          note = value ? (problems.length ? `${problems.length} rows with problems are left out` : undefined) : "Nothing picked";
        } catch (err) {
          note = errorMessage(err);
        }
        counts.set(id, items);
        steps.push({ nodeId: id, name: node.port.label, kind: "input", items, note });
        continue;
      }
      const into = flow.edges.filter((e) => e.to.nodeId === id);
      if (node.kind === "output") {
        const items = into.length ? (counts.get(into[0].from.nodeId) ?? null) : null;
        steps.push({ nodeId: id, name: node.port.label, kind: "output", items, note: "Saved to the folder picked at run time" });
        continue;
      }
      const routine = routineOf(info, id);
      if (!routine) {
        steps.push({ nodeId: id, name: "Missing routine", kind: "routine", items: null, note: "Can't run" });
        continue;
      }
      let items: number | null = 1;
      let note: string | undefined;
      if (routine.iterate) {
        const edge = into.find((e) => e.to.port === routine.iterate!.input);
        items = edge ? (counts.get(edge.from.nodeId) ?? null) : null;
        note = items === null ? "Item count is known once the routines before it ran" : undefined;
      }
      counts.set(id, items);
      steps.push({ nodeId: id, name: routine.name, kind: "routine", appId: routine.appId, items, iterates: routine.iterate?.input, note });
    }
    const joins: ExecutionPlan["joins"] = [];
    for (const edge of flow.edges.filter((e) => isJoin(e, flow, info))) {
      const preview = await this.previewMatch(flow, edge.id, edge.match ?? null, picked);
      const routine = routineOf(info, edge.to.nodeId)!;
      if (preview.rule) joins.push({ edgeId: edge.id, into: `${routine.name} · ${edge.to.port}`, rule: preview.rule, preview });
    }
    return { steps, joins, issues: validation.issues };
  }

  /** What an edge's source carries and what its target takes, for converters. */
  private async ends(flow: Flow, edgeId: string) {
    const edge = flow.edges.find((e) => e.id === edgeId);
    if (!edge) throw new Error("That connection isn't in the flow anymore.");
    const info = await this.routinesOf(flow);
    const from = flow.nodes.find((n) => n.id === edge.from.nodeId);
    const to = flow.nodes.find((n) => n.id === edge.to.nodeId);
    const source = from ? sourceSpec(from, edge.from.port, routineOf(info, from.id)) : null;
    const target = to?.kind === "routine" ? routineOf(info, to.id) : undefined;
    const targetPort = to?.kind === "output" ? to.port : target?.inputs.find((p) => p.key === edge.to.port);
    return { edge, from, to, source, target, targetPort };
  }

  /** Starter converters that take what the edge carries and give what its target takes. */
  async converterOptions(flow: Flow, edgeId: string): Promise<ConverterOption[]> {
    const { source, to, target, targetPort } = await this.ends(flow, edgeId);
    if (!source || !to || !targetPort) return [];
    const fits = (c: Routine) => {
      const input = c.inputs.find((p) => p.type !== "document")!;
      const out = outputSpec(c.outputs[0], !!c.iterate, c.appId);
      const intoTarget = to.kind === "output" ? acceptedByOutput(out) : compatible(out, inputSpec(targetPort as PortDef, target?.appId));
      return compatible(source.spec, inputSpec(input, c.appId)).ok && intoTarget.ok;
    };
    return this.deps.starters
      .converters()
      .filter(fits)
      .map((c) => ({ routineId: c.id, version: c.version, name: c.name, description: c.description }));
  }

  /** The flow with the converter placed on the edge: from → converter → to. Not saved. */
  async insertConverter(flow: Flow, edgeId: string, routineId: string): Promise<Flow> {
    const { edge, from, to } = await this.ends(flow, edgeId);
    const converter = await this.deps.library.require(routineId);
    const input = converter.inputs.find((p) => p.type !== "document");
    const output = converter.outputs[0];
    if (!from || !to || !input || !output) throw new Error("That converter can't go on this connection.");
    // The converter goes right after the source; everything from the target rightwards moves over to make room.
    const node: FlowNode = { id: newId(), kind: "routine", routineId: converter.id, routineVersion: converter.version, position: { x: from.position.x + 336, y: from.position.y } };
    const next = structuredClone(flow);
    for (const n of next.nodes) if (n.position.x >= to.position.x && n.position.x > from.position.x) n.position = { ...n.position, x: n.position.x + 336 };
    next.nodes.push(node);
    next.edges = next.edges.filter((e) => e.id !== edgeId);
    next.edges.push({ id: newId(), from: edge.from, to: { nodeId: node.id, port: input.key } });
    next.edges.push({ id: newId(), from: { nodeId: node.id, port: output.key }, to: edge.to, ...(edge.match ? { match: edge.match } : {}) });
    return next;
  }
}

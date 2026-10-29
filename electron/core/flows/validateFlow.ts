import { topoOrder } from "../../shared/flowGraph";
import { type PortSpec, acceptedByOutput, compatible, inputSpec, isListType, outputSpec } from "../../shared/ports";
import type { AppId, Flow, FlowEdge, FlowIssue, FlowNode, FlowValidation, PortDef, Routine, StageKind } from "../types";
import { ruleProblem } from "./match";

// A flow can be saved anytime, but only runs when this passes: routines exist in their pinned version, edges
// connect compatible ports, joins say how items pair, every required input is fed, and nothing runs in a circle.

export interface FlowRoutines {
  /** Per routine node id: its pinned routine, or why there is none. */
  routines: Record<string, Routine | "missing-routine" | "missing-version">;
  /** The kind of routine each app runs (an older Figma routine with a script can't run anymore). */
  stageKind(appId: AppId): StageKind | null;
}

type RoutineNode = Extract<FlowNode, { kind: "routine" }>;

/** The routine of a routine node, when it exists in its pinned version. */
export const routineOf = (info: FlowRoutines, nodeId: string): Routine | undefined => {
  const r = info.routines[nodeId];
  return typeof r === "object" ? r : undefined;
};

/** What a node's output port carries (input nodes: the picked value; routines: their outputs, as lists when they iterate). */
export function sourceSpec(node: FlowNode, port: string, routine: Routine | undefined): { port: PortDef; spec: PortSpec } | null {
  if (node.kind === "input") return node.port.key === port ? { port: node.port, spec: inputSpec(node.port) } : null;
  if (node.kind === "output" || !routine) return null;
  const p = routine.outputs.find((o) => o.key === port);
  return p ? { port: p, spec: outputSpec(p, !!routine.iterate, routine.appId) } : null;
}

/** What a node's input port takes. */
export function targetPort(node: FlowNode, port: string, routine: Routine | undefined): PortDef | null {
  if (node.kind === "output") return node.port.key === port ? node.port : null;
  if (node.kind === "input" || !routine) return null;
  return routine.inputs.find((p) => p.key === port) ?? null;
}

/** An edge into a routine that iterates, bringing a second list: it needs a match rule. */
export function isJoin(edge: FlowEdge, flow: Flow, info: FlowRoutines): boolean {
  const node = flow.nodes.find((n) => n.id === edge.to.nodeId);
  const routine = node?.kind === "routine" ? routineOf(info, node.id) : undefined;
  if (!routine?.iterate) return false;
  const port = routine.inputs.find((p) => p.key === edge.to.port);
  return !!port && port.key !== routine.iterate.input && isListType(port.type);
}

/** Problems with one edge (unknown ports, types that don't fit, a join without a rule). */
export function edgeIssues(edge: FlowEdge, flow: Flow, info: FlowRoutines): FlowIssue[] {
  const from = flow.nodes.find((n) => n.id === edge.from.nodeId);
  const to = flow.nodes.find((n) => n.id === edge.to.nodeId);
  const issue = (code: FlowIssue["code"], message: string): FlowIssue => ({ code, message, edgeId: edge.id });
  if (!from || !to) return [issue("unknown-port", "This connection points to a node that isn't in the flow anymore.")];
  if (from.kind === "routine" && !routineOf(info, from.id)) return [];
  if (to.kind === "routine" && !routineOf(info, to.id)) return [];
  const source = sourceSpec(from, edge.from.port, from.kind === "routine" ? routineOf(info, from.id) : undefined);
  if (!source) return [issue("unknown-port", from.kind === "output" ? "A “Save to folder” node has nothing to pass on." : `“${edge.from.port}” isn't an output of this node anymore.`)];
  if (to.kind === "input") return [issue("unknown-port", "An input node can't receive a connection.")];
  if (to.kind === "output") {
    const fit = acceptedByOutput(source.spec);
    return fit.ok ? [] : [issue("incompatible", fit.reason)];
  }
  const routine = routineOf(info, to.id)!;
  const port = routine.inputs.find((p) => p.key === edge.to.port);
  if (!port) return [issue("unknown-port", `“${edge.to.port}” isn't an input of ${routine.name} anymore.`)];
  const fit = compatible(source.spec, inputSpec(port, routine.appId));
  if (!fit.ok) return [issue("incompatible", fit.reason)];
  if (isJoin(edge, flow, info)) {
    const iterPort = routine.inputs.find((p) => p.key === routine.iterate!.input)!;
    if (!edge.match) return [issue("needs-match", `${routine.name} runs once per item of “${iterPort.label}”. Pick how “${port.label}” pairs with those items.`)];
    const bad = ruleProblem(edge.match, iterPort.type as "rows" | "fileList", port.type as "rows" | "fileList");
    if (bad) return [issue("bad-match", bad)];
  }
  return [];
}

export function validateFlow(flow: Flow, info: FlowRoutines): FlowValidation {
  const issues: FlowIssue[] = [];
  const routineNodes = flow.nodes.filter((n): n is RoutineNode => n.kind === "routine");
  if (routineNodes.length === 0) issues.push({ code: "empty", message: "Add a routine to the flow." });

  for (const node of routineNodes) {
    const r = info.routines[node.id];
    if (r === "missing-routine" || r === undefined) issues.push({ code: "missing-routine", nodeId: node.id, message: "This routine doesn't exist anymore." });
    else if (r === "missing-version") issues.push({ code: "missing-version", nodeId: node.id, message: `Version ${node.routineVersion} of this routine doesn't exist anymore. Update the node.` });
    else if (info.stageKind(r.appId) && info.stageKind(r.appId) !== r.kind) {
      issues.push({ code: "legacy-routine", nodeId: node.id, message: `${r.name} was made by an older Doppl and can't run anymore. Create it again with New task.` });
    }
  }

  const { cycle } = topoOrder(
    flow.nodes.map((n) => n.id),
    flow.edges,
  );
  for (const id of cycle) issues.push({ code: "cycle", nodeId: id, message: "This node is part of a loop; a flow runs in one direction." });

  const fed = new Map<string, string>();
  for (const edge of flow.edges) {
    issues.push(...edgeIssues(edge, flow, info));
    const target = `${edge.to.nodeId}\u0000${edge.to.port}`;
    if (fed.has(target)) issues.push({ code: "duplicate-input", edgeId: edge.id, message: "This input already gets a value from another connection. Remove one of them." });
    else fed.set(target, edge.id);
  }

  for (const node of flow.nodes) {
    if (node.kind === "output" && !flow.edges.some((e) => e.to.nodeId === node.id)) {
      issues.push({ code: "no-source", nodeId: node.id, message: `Connect what “${node.port.label}” should save.` });
    }
    if (node.kind !== "routine") continue;
    const routine = routineOf(info, node.id);
    if (!routine) continue;
    for (const port of routine.inputs) {
      if (!port.required || port.type === "document") continue;
      const connected = fed.has(`${node.id}\u0000${port.key}`);
      const value = node.values?.[port.key];
      if (!connected && (value === undefined || value === "")) {
        issues.push({ code: "missing-input", nodeId: node.id, port: port.key, message: `${routine.name} needs “${port.label}”: connect it${["text", "number", "boolean"].includes(port.type) ? " or give it a value" : ""}.` });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

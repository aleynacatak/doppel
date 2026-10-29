import type { App, Flow, FlowContext, FlowIssue, FlowNode, InputValue, PortDef, Routine, Run } from "@core/types";
import { type PortSpec, acceptedByOutput, compatible, describeSpec, inputSpec, outputSpec } from "@shared/ports";
import { createContext, useContext } from "react";

// What the flow canvas, its nodes and edges share: the flow, its pinned routines, validation, the run being shown,
// and the connection being dragged (to highlight the ports that fit).

export interface PortView {
  port: PortDef;
  spec: PortSpec;
}

/** A connection being dragged: from which port, and what it carries or takes. */
export interface Connecting {
  nodeId: string;
  port: string;
  side: "source" | "target";
  spec: PortSpec;
}

export interface FlowViewState {
  flow: Flow;
  ctx: FlowContext | null;
  apps: App[];
  mode: "edit" | "run";
  /** The run shown on the canvas (run mode), or the flow's last run (edit mode: node footers). */
  run: Run | null;
  connecting: Connecting | null;
  /** Per node: the latest version of its routine, when newer than the pinned one. */
  updates: Record<string, number>;
  onUpdateNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  /** Edit mode: what is picked for input nodes on this Mac (for previews), and picking it. */
  pickedInputs?: Record<string, InputValue>;
  onPickInput?: (nodeId: string) => void;
}

export const FlowViewContext = createContext<FlowViewState | null>(null);

export function useFlowView(): FlowViewState {
  const value = useContext(FlowViewContext);
  if (!value) throw new Error("FlowViewContext is missing");
  return value;
}

/** The pinned routine of a routine node, when it exists. */
export const routineAt = (ctx: FlowContext | null, nodeId: string): Routine | undefined => ctx?.routines[nodeId];

/** What a node takes (left) and gives (right). Document inputs aren't connected: the document is picked at run time. */
export function nodePorts(node: FlowNode, routine: Routine | undefined): { inputs: PortView[]; outputs: PortView[] } {
  if (node.kind === "input") return { inputs: [], outputs: [{ port: node.port, spec: inputSpec(node.port) }] };
  if (node.kind === "output") return { inputs: [{ port: node.port, spec: { type: node.port.type } }], outputs: [] };
  if (!routine) return { inputs: [], outputs: [] };
  return {
    inputs: routine.inputs.filter((p) => p.type !== "document").map((port) => ({ port, spec: inputSpec(port, routine.appId) })),
    outputs: routine.outputs.map((port) => ({ port, spec: outputSpec(port, !!routine.iterate, routine.appId) })),
  };
}

/** Whether a dragged connection fits a port: "fit", "no" (dims), or null when nothing is dragged or it's the same side. */
export function fitOf(connecting: Connecting | null, node: FlowNode, side: "source" | "target", view: PortView): "fit" | "no" | null {
  if (!connecting || connecting.side === side) return null;
  if (connecting.nodeId === node.id) return "no";
  if (side === "target") {
    const ok = node.kind === "output" ? acceptedByOutput(connecting.spec) : compatible(connecting.spec, view.spec);
    return ok.ok ? "fit" : "no";
  }
  return compatible(view.spec, connecting.spec).ok ? "fit" : "no";
}

export function issuesFor(ctx: FlowContext | null, where: { nodeId?: string; edgeId?: string }): FlowIssue[] {
  return (ctx?.validation.issues ?? []).filter((i) => (where.nodeId ? i.nodeId === where.nodeId : i.edgeId === where.edgeId));
}

/** What an edge carries, from its source port, in plain words ("PNG files"). */
export function edgeCarries(flow: Flow, ctx: FlowContext | null, edgeId: string): string | null {
  const edge = flow.edges.find((e) => e.id === edgeId);
  const from = edge && flow.nodes.find((n) => n.id === edge.from.nodeId);
  if (!edge || !from) return null;
  const view = nodePorts(from, routineAt(ctx, from.id)).outputs.find((o) => o.port.key === edge.from.port);
  return view ? describeSpec(view.spec) : null;
}

/** A short name for a node (its routine's name, or its port's label). */
export function nodeName(node: FlowNode | undefined, ctx: FlowContext | null): string {
  if (!node) return "?";
  if (node.kind === "routine") return routineAt(ctx, node.id)?.name ?? "Missing routine";
  return node.port.label;
}

export const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`);

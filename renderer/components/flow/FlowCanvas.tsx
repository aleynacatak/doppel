"use client";

import "@xyflow/react/dist/base.css";
import type { FlowNode, PortType } from "@core/types";
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnConnectStartParams,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { wouldCreateCycle } from "@shared/flowGraph";
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PortEdge } from "./FlowEdgeView";
import { InputNodeView, OutputNodeView, RoutineNodeView } from "./FlowNodes";
import { type Connecting, FlowViewContext, type FlowViewState, type PortView, nodePorts, routineAt } from "./flowView";

const nodeTypes = { routine: RoutineNodeView, input: InputNodeView, output: OutputNodeView };
const edgeTypes = { port: PortEdge };

/** Something dragged from the library panel onto the canvas. */
export type DragItem = { kind: "input"; type: PortType } | { kind: "output" } | { kind: "routine"; routineId: string };
export const DRAG_TYPE = "application/x-doppl-node";

export type Selection = { kind: "node" | "edge"; id: string } | null;

interface Props extends Omit<FlowViewState, "connecting"> {
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Edit mode: the flow changed (moved nodes, removed nodes or edges). */
  onFlowChange?: (change: { nodes?: FlowNode[]; removeNodes?: string[]; removeEdges?: string[] }) => void;
  onConnect?: (from: { nodeId: string; port: string }, to: { nodeId: string; port: string }) => void;
  /** A connection dropped on empty canvas: offer what can take it, at that spot. */
  onConnectToEmpty?: (from: { nodeId: string; port: string; view: PortView }, at: { client: { x: number; y: number }; flow: { x: number; y: number } }) => void;
  onDropItem?: (item: DragItem, at: { x: number; y: number }) => void;
  /** A node just added off-screen: the view moves to show the whole flow with it. */
  reveal?: string | null;
  overlay?: ReactNode;
  className?: string;
}

function Canvas(props: Props) {
  const { flow, ctx, mode, selection, onSelect, onFlowChange, onConnect, onConnectToEmpty, onDropItem, reveal } = props;
  const rf = useReactFlow();
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const measured = useNodesInitialized();
  const fitted = useRef(false);

  // Nodes arrive after the first paint and grow once their routines load, so the `fitView` prop alone leaves a flow
  // cut off: fit once, after they've been measured at their full size.
  const hasNodes = nodes.length > 0;
  const loaded = !!ctx;
  useEffect(() => {
    if (!measured || !loaded || !hasNodes || fitted.current) return;
    const timer = window.setTimeout(() => {
      fitted.current = true;
      void rf.fitView({ padding: 0.2, maxZoom: 1 });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [measured, loaded, hasNodes, rf]);

  // Once the new node is drawn (and measured), fit the flow in view.
  useEffect(() => {
    if (!reveal) return;
    const timer = window.setTimeout(() => void rf.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 50);
    return () => window.clearTimeout(timer);
  }, [reveal, rf]);

  // Nodes follow the flow; positions move live while dragging and are written back when dropped.
  useEffect(() => {
    setNodes((prev) =>
      flow.nodes.map((n) => {
        const old = prev.find((p) => p.id === n.id);
        return { ...(old ?? {}), id: n.id, type: n.kind, position: n.position, data: {}, selected: selection?.kind === "node" && selection.id === n.id };
      }),
    );
  }, [flow.nodes, selection]);
  const edges: Edge[] = useMemo(() => {
    // A port that a newer version of the routine removed: the connection stays drawn (from the node's first port,
    // dashed with "reconnect") instead of disappearing, until it's reconnected or removed.
    const has = (nodeId: string, port: string, side: "outputs" | "inputs") => {
      const routine = flow.nodes.find((n) => n.id === nodeId)?.kind === "routine" ? routineAt(ctx, nodeId) : undefined;
      return !routine || routine[side].some((p) => p.key === port);
    };
    return flow.edges.map((e) => ({
      id: e.id,
      source: e.from.nodeId,
      sourceHandle: has(e.from.nodeId, e.from.port, "outputs") ? e.from.port : null,
      target: e.to.nodeId,
      targetHandle: has(e.to.nodeId, e.to.port, "inputs") ? e.to.port : null,
      type: "port",
      selected: selection?.kind === "edge" && selection.id === e.id,
    }));
  }, [flow.edges, flow.nodes, ctx, selection]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      const dropped = changes.filter((c) => c.type === "position" && c.dragging === false && c.position);
      if (dropped.length && onFlowChange) {
        const moved = new Map(dropped.map((c) => [(c as { id: string }).id, (c as { position: { x: number; y: number } }).position]));
        onFlowChange({ nodes: flow.nodes.map((n) => (moved.has(n.id) ? { ...n, position: { x: Math.round(moved.get(n.id)!.x), y: Math.round(moved.get(n.id)!.y) } } : n)) });
      }
    },
    [flow.nodes, onFlowChange],
  );

  const portView = (nodeId: string, port: string, side: "source" | "target"): PortView | undefined => {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    const ports = nodePorts(node, routineAt(ctx, nodeId));
    return (side === "source" ? ports.outputs : ports.inputs).find((p) => p.port.key === port);
  };

  const onConnectStart = (_e: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (!params.nodeId || !params.handleId || !params.handleType) return;
    const view = portView(params.nodeId, params.handleId, params.handleType);
    if (view) setConnecting({ nodeId: params.nodeId, port: params.handleId, side: params.handleType, spec: view.spec });
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    setConnecting(null);
    if (state.isValid || state.toNode || !state.fromNode || state.fromHandle?.type !== "source" || !state.fromHandle.id) return;
    const view = portView(state.fromNode.id, state.fromHandle.id, "source");
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (view && onConnectToEmpty) {
      onConnectToEmpty(
        { nodeId: state.fromNode.id, port: state.fromHandle.id, view },
        { client: { x: point.clientX, y: point.clientY }, flow: rf.screenToFlowPosition({ x: point.clientX, y: point.clientY }) },
      );
    }
  };

  const isValidConnection = (c: Edge | Connection) => c.source !== c.target && !wouldCreateCycle(flow.edges, c.source, c.target);

  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw || !onDropItem) return;
    e.preventDefault();
    onDropItem(JSON.parse(raw) as DragItem, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const view: FlowViewState = { ...props, connecting };
  const edit = mode === "edit";
  return (
    <FlowViewContext.Provider value={view}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodesDelete={(deleted) => onFlowChange?.({ removeNodes: deleted.map((n) => n.id) })}
        onEdgesDelete={(deleted) => onFlowChange?.({ removeEdges: deleted.map((e) => e.id) })}
        onNodeClick={(_e, n) => onSelect({ kind: "node", id: n.id })}
        onEdgeClick={(_e, ed) => onSelect({ kind: "edge", id: ed.id })}
        onPaneClick={() => onSelect(null)}
        onConnect={(c) => c.sourceHandle && c.targetHandle && onConnect?.({ nodeId: c.source, port: c.sourceHandle }, { nodeId: c.target, port: c.targetHandle })}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={onDrop}
        nodesDraggable={edit}
        nodesConnectable={edit}
        elementsSelectable
        deleteKeyCode={edit ? ["Backspace", "Delete"] : null}
        snapToGrid
        snapGrid={[16, 16]}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.1}
        maxZoom={1.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </FlowViewContext.Provider>
  );
}

/** The flow as a left-to-right node canvas: editing (edit mode) or a run's progress on the same layout (run mode). */
export function FlowCanvas(props: Props) {
  return (
    <div className={`ui-flow relative ${props.className ?? "h-[560px]"}`}>
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
      {props.overlay}
    </div>
  );
}

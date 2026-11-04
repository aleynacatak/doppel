// The shape of a flow as a graph: run order, cycles, and a simple left-to-right layout. Shared by the main process
// and the renderer (list view order, placing nodes), so it stays free of Node.js and Electron.

export interface GraphEdge {
  from: { nodeId: string };
  to: { nodeId: string };
}

/**
 * Topological order (Kahn), keeping the given node order among nodes that are ready at the same time.
 * `cycle` lists the nodes that are part of (or stuck behind) a cycle; empty when the graph is a DAG.
 */
export function topoOrder(nodeIds: string[], edges: GraphEdge[]): { order: string[]; cycle: string[] } {
  const known = new Set(nodeIds);
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  const next = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!known.has(e.from.nodeId) || !known.has(e.to.nodeId)) continue;
    incoming.set(e.to.nodeId, incoming.get(e.to.nodeId)! + 1);
    next.get(e.from.nodeId)!.push(e.to.nodeId);
  }
  const order: string[] = [];
  const ready = nodeIds.filter((id) => incoming.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of next.get(id)!) {
      const left = incoming.get(to)! - 1;
      incoming.set(to, left);
      if (left === 0) {
        // Keep the original node order among nodes that become ready.
        const at = ready.findIndex((r) => nodeIds.indexOf(r) > nodeIds.indexOf(to));
        ready.splice(at < 0 ? ready.length : at, 0, to);
      }
    }
  }
  return { order, cycle: nodeIds.filter((id) => !order.includes(id)) };
}

/** Whether adding an edge from → to would close a cycle (to already reaches from). */
export function wouldCreateCycle(edges: GraphEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from.nodeId === id) stack.push(e.to.nodeId);
  }
  return false;
}

/** Column per node: the length of the longest path that leads to it (inputs in column 0). */
export function depths(nodeIds: string[], edges: GraphEdge[]): Map<string, number> {
  const { order } = topoOrder(nodeIds, edges);
  const depth = new Map(nodeIds.map((id) => [id, 0]));
  for (const id of order) {
    for (const e of edges) {
      if (e.from.nodeId === id && depth.has(e.to.nodeId)) depth.set(e.to.nodeId, Math.max(depth.get(e.to.nodeId)!, depth.get(id)! + 1));
    }
  }
  return depth;
}

/** Positions for a left-to-right layout: one column per depth, nodes stacked in each column. */
export function layoutLeftToRight(
  nodeIds: string[],
  edges: GraphEdge[],
  size: { columnWidth: number; rowHeight: number } = { columnWidth: 320, rowHeight: 200 },
): Map<string, { x: number; y: number }> {
  const depth = depths(nodeIds, edges);
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  const { order, cycle } = topoOrder(nodeIds, edges);
  for (const id of [...order, ...cycle]) {
    const col = depth.get(id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(id, { x: col * size.columnWidth, y: row * size.rowHeight });
  }
  return out;
}

/**
 * The AI calls behind a flow: what making it took, or its routines' own calls when it was wired by hand. A routine used
 * twice counts once.
 */
export function flowAiCalls(
  flow: { createdWithAiCalls?: number; nodes: { kind: string; routineId?: string }[] },
  routines: { id: string; createdWithAiCalls: number }[],
): number {
  const used = new Set(flow.nodes.flatMap((n) => (n.kind === "routine" && n.routineId ? [n.routineId] : [])));
  const total = routines.filter((r) => used.has(r.id)).reduce((sum, r) => sum + r.createdWithAiCalls, 0);
  return Math.max(flow.createdWithAiCalls ?? 0, total);
}

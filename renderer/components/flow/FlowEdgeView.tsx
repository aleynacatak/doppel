"use client";

import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from "@xyflow/react";
import { copy } from "@/copy";
import { edgeCarries, issuesFor, useFlowView } from "./flowView";
import { Button } from "@/components/ui/button";

/**
 * An edge with what it carries ("PNG files"; during a run, "6 PNG"). Incompatible edges, and edges whose port a new
 * version removed, are dashed with a chip to fix them; joins without a rule get a chip to pick one. While the next
 * node runs, dots move along the edge.
 */
export function PortEdge(props: EdgeProps) {
  const v = useFlowView();
  const [path, labelX, labelY] = getBezierPath(props);
  const issues = issuesFor(v.ctx, { edgeId: props.id });
  const incompatible = issues.some((i) => i.code === "incompatible");
  const lost = issues.some((i) => i.code === "unknown-port");
  const needsMatch = issues.some((i) => i.code === "needs-match" || i.code === "bad-match");
  const edge = v.flow.edges.find((e) => e.id === props.id);
  const runEdge = v.mode === "run" ? v.run?.edges.find((e) => e.edgeId === props.id) : undefined;
  const flowing = v.mode === "run" && v.run?.nodes.find((n) => n.nodeId === props.target)?.status === "running";
  const label = runEdge?.label ?? (v.mode === "edit" ? edgeCarries(v.flow, v.ctx, props.id) : null);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        interactionWidth={16}
        style={{
          stroke: props.selected ? "var(--primary)" : incompatible || lost || needsMatch ? "var(--ring)" : "var(--muted-foreground)",
          strokeWidth: props.selected ? 2 : 1.5,
          strokeDasharray: incompatible || lost ? "6 4" : undefined,
        }}
      />
      {flowing &&
        [0, 0.4, 0.8].map((delay) => (
          <circle key={delay} r={3} className="ui-flow-dot">
            <animateMotion dur="1.2s" begin={`${delay}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
      <EdgeLabelRenderer>
        <div
          className="ui-flow-edge-label nodrag nopan flex flex-col items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {label && (
            <span className="text-xs whitespace-nowrap">
              {label}
              {edge?.match && v.mode === "edit" && !needsMatch && <span className="text-muted-foreground"> · {copy.match.short(edge.match)}</span>}
            </span>
          )}
          {v.mode === "edit" && incompatible && (
            <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => v.onSelectEdge?.(props.id)}>
              {copy.flow.chipFix}
            </Button>
          )}
          {v.mode === "edit" && lost && (
            <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => v.onSelectEdge?.(props.id)}>
              {copy.flow.chipReconnect}
            </Button>
          )}
          {v.mode === "edit" && needsMatch && !incompatible && (
            <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => v.onSelectEdge?.(props.id)}>
              {copy.flow.chipMatch}
            </Button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

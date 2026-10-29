"use client";

import type { Flow, FlowContext, Run } from "@core/types";
import { topoOrder } from "@shared/flowGraph";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Tag } from "../ui/Tag";
import { edgeCarries, issuesFor, nodeName, routineAt } from "./flowView";

/** The same flow as a list of steps, in run order (like Apple Shortcuts); best for flows that don't branch. */
export function FlowListView({
  flow,
  ctx,
  run,
  selectedId,
  onSelect,
}: {
  flow: Flow;
  ctx: FlowContext | null;
  run?: Run | null;
  selectedId?: string;
  onSelect?: (nodeId: string) => void;
}) {
  const { order, cycle } = topoOrder(
    flow.nodes.map((n) => n.id),
    flow.edges,
  );
  const branches = flow.nodes.some((n) => flow.edges.filter((e) => e.from.nodeId === n.id).length > 1 || flow.edges.filter((e) => e.to.nodeId === n.id && flow.nodes.find((x) => x.id === e.from.nodeId)?.kind === "routine").length > 1);
  return (
    <div className="flex flex-col gap-3">
      {branches && <p className="ui-small ui-muted">{copy.flow.notLinear}</p>}
      <ol className="flex flex-col gap-2">
        {[...order, ...cycle].map((id, i) => {
          const node = flow.nodes.find((n) => n.id === id)!;
          const routine = node.kind === "routine" ? routineAt(ctx, id) : undefined;
          const into = flow.edges.filter((e) => e.to.nodeId === id);
          const out = flow.edges.filter((e) => e.from.nodeId === id);
          const progress = run?.nodes.find((n) => n.nodeId === id);
          const issues = issuesFor(ctx, { nodeId: id });
          return (
            <li key={id}>
              <button
                type="button"
                className="ui-card flex w-full flex-col gap-1 p-3 text-left"
                data-selected={selectedId === id || issues.length > 0}
                onClick={() => onSelect?.(id)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ui-small ui-muted">{copy.flow.listStep(i + 1)}</span>
                  {routine ? <Tag tone="strong">{appLabel(routine.appId)}</Tag> : <Tag>{node.kind === "input" ? copy.flow.inputNode : copy.flow.saveToFolder}</Tag>}
                  <span className="ui-h3">{nodeName(node, ctx)}</span>
                  {node.kind === "routine" && <span className="ui-small ui-muted">{copy.flow.version(node.routineVersion)}</span>}
                  {progress && <span className="ui-small ui-muted">· {copy.run.stageStatus[progress.status]}</span>}
                </div>
                {into.map((e) => (
                  <span key={e.id} className="ui-small ui-muted">
                    {copy.flow.listFrom(`${edgeCarries(flow, ctx, e.id) ?? ""} from ${nodeName(flow.nodes.find((n) => n.id === e.from.nodeId), ctx)}`)}
                    {e.match ? ` (${copy.match.describe(e.match)})` : ""}
                  </span>
                ))}
                {out.map((e) => (
                  <span key={e.id} className="ui-small ui-muted">
                    {copy.flow.listTo(`${edgeCarries(flow, ctx, e.id) ?? ""} to ${nodeName(flow.nodes.find((n) => n.id === e.to.nodeId), ctx)}`)}
                  </span>
                ))}
                {issues[0] && <span className="ui-small">{issues[0].message}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

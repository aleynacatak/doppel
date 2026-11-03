"use client";

import type { Flow, FlowContext, Run } from "@core/types";
import { topoOrder } from "@shared/flowGraph";
import { copy } from "@/copy";
import { AppTag } from "../common/AppLogo";
import { Tag } from "../common/Tag";
import { edgeCarries, issuesFor, nodeName, routineAt } from "./flowView";
import { Item } from "@/components/ui/item";

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
    <div className="flex flex-col gap-4">
      {branches && <p className="text-sm text-muted-foreground">{copy.flow.notLinear}</p>}
      <ol className="flex flex-col gap-3">
        {[...order, ...cycle].map((id, i) => {
          const node = flow.nodes.find((n) => n.id === id)!;
          const routine = node.kind === "routine" ? routineAt(ctx, id) : undefined;
          const into = flow.edges.filter((e) => e.to.nodeId === id);
          const out = flow.edges.filter((e) => e.from.nodeId === id);
          const progress = run?.nodes.find((n) => n.nodeId === id);
          const issues = issuesFor(ctx, { nodeId: id });
          return (
            <li key={id}>
              <Item render={<button type="button" />} variant="outline" className="flex-col items-start gap-1.5 text-left data-[selected=true]:border-primary" data-selected={selectedId === id || issues.length > 0} onClick={() => onSelect?.(id)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">{copy.flow.listStep(i + 1)}</span>
                  {routine ? <AppTag appId={routine.appId} /> : <Tag>{node.kind === "input" ? copy.flow.inputNode : copy.flow.saveToFolder}</Tag>}
                  <span className="text-sm font-medium">{nodeName(node, ctx)}</span>
                  {node.kind === "routine" && <span className="text-sm text-muted-foreground">{copy.flow.version(node.routineVersion)}</span>}
                  {progress && <span className="text-sm text-muted-foreground">· {copy.run.stageStatus[progress.status]}</span>}
                </div>
                {into.map((e) => (
                  <span key={e.id} className="text-sm text-muted-foreground">
                    {copy.flow.listFrom(`${edgeCarries(flow, ctx, e.id) ?? ""} from ${nodeName(flow.nodes.find((n) => n.id === e.from.nodeId), ctx)}`)}
                    {e.match ? ` (${copy.match.describe(e.match)})` : ""}
                  </span>
                ))}
                {out.map((e) => (
                  <span key={e.id} className="text-sm text-muted-foreground">
                    {copy.flow.listTo(`${edgeCarries(flow, ctx, e.id) ?? ""} to ${nodeName(flow.nodes.find((n) => n.id === e.to.nodeId), ctx)}`)}
                  </span>
                ))}
                {issues[0] && <span className="text-sm">{issues[0].message}</span>}
              </Item>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

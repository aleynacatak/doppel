import type { NodeProgress } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { ProgressBar, Spinner } from "../ui/Progress";
import { Tag } from "../ui/Tag";

const MAX_ITEMS = 40;

/** Progress per flow node and per item ("Figma · item 3 of 6"). Input and output nodes show only when they matter. */
export function NodeProgressList({ nodes }: { nodes: NodeProgress[] }) {
  const shown = nodes.filter((n) => n.kind === "routine" || n.status === "failed" || n.failed > 0 || (n.kind === "output" && n.status !== "pending"));
  return (
    <ol className="flex flex-col gap-3">
      {shown.map((n) => (
        <li key={n.nodeId} id={`node-${n.nodeId}`} className="ui-card flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {n.status === "running" && <Spinner />}
              {n.appId && <Tag tone="strong">{appLabel(n.appId)}</Tag>}
              <span className="ui-h3">{n.name}</span>
            </div>
            <span className="ui-small ui-muted">{copy.run.stageStatus[n.status]}</span>
          </div>
          {n.total > 0 && n.kind === "routine" && (
            <>
              <ProgressBar value={(n.done + n.failed) / n.total} label={n.name} />
              <div className="ui-small ui-muted">{copy.run.stageProgress(n.done, n.total, n.failed)}</div>
            </>
          )}
          {n.documentName && <div className="ui-small ui-muted">{n.kind === "output" ? copy.results.savedTo(n.done, n.documentName) : copy.results.stageOn(n.documentName)}</div>}
          {n.error && <p className="ui-small">{n.error}</p>}
          {n.note && <p className="ui-small ui-muted">{n.note}</p>}
          {n.items.length > 1 && n.kind === "routine" && (
            <ul className="ui-small flex flex-col">
              {n.items.slice(0, MAX_ITEMS).map((item) => (
                <li key={item.key} className="flex justify-between gap-4">
                  <span className="truncate">{item.label}</span>
                  <span className="ui-muted shrink-0" title={item.error}>
                    {copy.run.itemStatus[item.status]}
                  </span>
                </li>
              ))}
              {n.items.length > MAX_ITEMS && <li className="ui-muted">+ {n.items.length - MAX_ITEMS}</li>}
            </ul>
          )}
          {n.kind === "input" && n.failed > 0 && (
            <ul className="ui-small flex flex-col">
              {n.items
                .filter((i) => i.status === "failed")
                .slice(0, MAX_ITEMS)
                .map((i) => (
                  <li key={i.key}>{i.error}</li>
                ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

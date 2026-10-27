import type { StageProgress } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { ProgressBar, Spinner } from "../ui/Progress";
import { Tag } from "../ui/Tag";

const MAX_ITEMS = 40;

/** Progress per stage and per item ("Figma · item 3 of 6"). */
export function StageProgressList({ stages }: { stages: StageProgress[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {stages.map((s, i) => (
        <li key={s.stageId} className="ui-card flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {s.status === "running" && <Spinner />}
              <Tag tone="strong">{appLabel(s.appId)}</Tag>
              <span className="ui-h3">
                {i + 1}. {s.name}
              </span>
            </div>
            <span className="ui-small ui-muted">{copy.run.stageStatus[s.status]}</span>
          </div>
          {s.total > 0 && (
            <>
              <ProgressBar value={(s.done + s.failed) / s.total} label={s.name} />
              <div className="ui-small ui-muted">{copy.run.stageProgress(s.done, s.total, s.failed)}</div>
            </>
          )}
          {s.documentName && <div className="ui-small ui-muted">{copy.results.stageOn(s.documentName)}</div>}
          {s.error && <p className="ui-small">{s.error}</p>}
          {s.items.length > 1 && (
            <ul className="ui-small flex flex-col">
              {s.items.slice(0, MAX_ITEMS).map((item) => (
                <li key={item.key} className="flex justify-between gap-4">
                  <span className="truncate">{item.label}</span>
                  <span className="ui-muted shrink-0" title={item.error}>
                    {copy.run.itemStatus[item.status]}
                  </span>
                </li>
              ))}
              {s.items.length > MAX_ITEMS && <li className="ui-muted">+ {s.items.length - MAX_ITEMS}</li>}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

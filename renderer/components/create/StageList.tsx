import type { Creation } from "@core/types";
import { copy } from "@/copy";
import { Spinner } from "../common/Progress";

const MARK = { pending: "○", done: "●", failed: "×" } as const;

export function StageList({ creation }: { creation: Creation }) {
  const labels = copy.create.stages[creation.mode];
  const waiting = creation.status === "waiting";
  return (
    <ol className="flex flex-col gap-4" aria-label="Progress">
      {creation.stages.map((stage) => (
        <li key={stage.key} className="flex gap-3" aria-current={stage.status === "active" ? "step" : undefined}>
          <span className="flex w-4 shrink-0 justify-center pt-0.5" aria-hidden>
            {stage.status === "active" ? (waiting ? "…" : <Spinner />) : MARK[stage.status]}
          </span>
          <div className="flex flex-col">
            <span className={stage.status === "pending" ? "text-muted-foreground" : stage.status === "active" ? "text-sm font-medium" : undefined}>
              {labels[stage.key]}
            </span>
            {stage.detail && <span className="text-sm text-muted-foreground">{stage.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

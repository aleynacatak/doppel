import type { Run } from "@core/types";
import { copy } from "@/copy";
import { AiCallCounter } from "../ui/AiCallCounter";
import { Button } from "../ui/Button";
import { ProgressBar, Spinner } from "../ui/Progress";
import { StageProgressList } from "./StageProgressList";

/** Live progress of a run: phase, per-output status, cancel, AI-call counter. */
export function RunProgress({ run, onCancel }: { run: Run; onCancel: () => void }) {
  const total = run.outputs.length;
  const done = run.outputs.filter((o) => o.status === "done" || o.status === "failed").length;
  return (
    <div className="flex flex-col gap-6">
      <AiCallCounter
        count={run.aiCalls}
        label={copy.run.aiCounterLabel}
        hint={run.qcMode === "auto_ai" ? copy.run.aiCounterReview : copy.run.aiCounterZero}
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Spinner />
            <span>{run.phase ?? copy.run.progressTitle}</span>
          </div>
          <Button onClick={onCancel}>{copy.run.cancelRun}</Button>
        </div>
        {!run.stages?.length && <ProgressBar value={total ? done / total : undefined} label={copy.run.progressTitle} />}
        {total > 0 && !run.stages?.length && <div className="ui-small ui-muted">{copy.run.outputsDone(done, total)}</div>}
      </div>
      {run.stages?.length ? <StageProgressList stages={run.stages} /> : null}
      {total > 0 && !run.stages?.length && (
        <ul className="ui-card flex flex-col">
          {run.outputs.map((o) => (
            <li key={o.id} className="ui-divider flex items-center justify-between gap-4 px-3 py-2 first:border-t-0">
              <span>{o.label}</span>
              <span className="ui-small ui-muted flex items-center gap-2">
                {o.status === "running" && <Spinner />}
                {copy.run.outputStatus[o.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

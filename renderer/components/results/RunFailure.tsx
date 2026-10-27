import type { Run } from "@core/types";
import { copy } from "@/copy";
import { Button, ButtonLink } from "../ui/Button";
import { Notice } from "../ui/Notice";

export function RunFailure({ run, onRepair }: { run: Run; onRepair: () => void }) {
  return (
    <Notice
      tone="error"
      title={run.error ?? copy.results.failedTitle}
      actions={
        <>
          <Button variant="primary" onClick={onRepair}>
            {copy.results.repair}
          </Button>
          <ButtonLink href={`/run?routine=${run.routineId}`}>{copy.results.runAgain}</ButtonLink>
        </>
      }
    >
      {run.errorDetail && <p>{run.errorDetail}</p>}
      <p className="ui-muted">{copy.results.repairHint}</p>
    </Notice>
  );
}

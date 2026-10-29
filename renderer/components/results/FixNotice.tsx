"use client";

import type { Run } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Button, ButtonLink } from "../ui/Button";
import { Notice } from "../ui/Notice";
import { Spinner } from "../ui/Progress";

/**
 * Doppl's own fix after a run (items failed because of the routine): adapting, adapted (with the new results and
 * Restore), not adapted, or a change for the designer to look at. On the rerun: what it is, and Restore.
 */
export function FixNotice({ run }: { run: Run }) {
  const [restored, setRestored] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = async (routineId: string, version: number) => {
    setError(null);
    try {
      await doppel().restoreRoutineVersion(routineId, version);
      setRestored(version);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const restoreButton = (routineId: string, version: number) =>
    restored === version ? (
      <span className="ui-small">{copy.results.fix.restored(version)}</span>
    ) : (
      <Button onClick={() => restore(routineId, version)}>{copy.results.fix.restore(version)}</Button>
    );

  if (run.autoFixOf && run.target.kind === "routine") {
    return (
      <Notice
        title={copy.results.fix.rerunTitle}
        actions={
          <>
            <ButtonLink href={`/results?run=${run.autoFixOf}`}>{copy.results.fix.firstRun}</ButtonLink>
            {run.version > 1 && restoreButton(run.target.id, run.version - 1)}
          </>
        }
      >
        {copy.results.fix.rerunBody(run.version)}
        {error && <p className="ui-small">{error}</p>}
      </Notice>
    );
  }
  const fix = run.fix;
  if (!fix) return null;
  if (fix.status === "fixing") {
    return (
      <Notice title={copy.results.fix.fixingTitle}>
        <span className="flex items-center gap-2">
          <Spinner /> {copy.results.fix.fixingBody}
        </span>
      </Notice>
    );
  }
  if (fix.status === "fixed") {
    return (
      <Notice
        title={copy.results.fix.fixedTitle}
        actions={
          <>
            {fix.rerunId && (
              <ButtonLink href={`/results?run=${fix.rerunId}`} variant="primary">
                {copy.results.fix.newResults}
              </ButtonLink>
            )}
            {restoreButton(fix.routineId, fix.fromVersion)}
          </>
        }
      >
        {[fix.summary, copy.results.fix.details(fix.toVersion ?? fix.fromVersion + 1, fix.aiCalls ?? 0)].filter(Boolean).join(" · ")}
        {error && <p className="ui-small">{error}</p>}
      </Notice>
    );
  }
  if (fix.status === "needs-review") {
    return (
      <Notice
        title={copy.results.fix.reviewTitle}
        actions={
          fix.creationId && (
            <ButtonLink href={`/create?task=${fix.creationId}`} variant="primary">
              {copy.results.fix.review}
            </ButtonLink>
          )
        }
      >
        {[fix.summary, fix.reason].filter(Boolean).join(" ")}
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title={copy.results.fix.notFixedTitle}>
      {[fix.reason, copy.results.fix.unchanged].filter(Boolean).join(" ")}
    </Notice>
  );
}

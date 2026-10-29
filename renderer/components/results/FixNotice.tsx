"use client";

import type { Run, RunFix } from "@core/types";
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
  // Restore: the routine's previous version again; in a flow, the flow's node uses it again.
  const restore = async (fix: Pick<RunFix, "routineId" | "flowId" | "nodeId">, version: number) => {
    setError(null);
    try {
      if (fix.flowId && fix.nodeId) await doppel().pinFlowNodeVersion(fix.flowId, fix.nodeId, version);
      else await doppel().restoreRoutineVersion(fix.routineId, version);
      setRestored(version);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const restoreButton = (fix: Pick<RunFix, "routineId" | "flowId" | "nodeId">, version: number) =>
    restored === version ? (
      <span className="ui-small">{copy.results.fix.restored(version)}</span>
    ) : (
      <Button onClick={() => restore(fix, version)}>{copy.results.fix.restore(version)}</Button>
    );

  if (run.autoFixOf) {
    // The rerun after a fix: what it is, the first run, and Restore.
    const fix = run.fix ?? (run.target.kind === "routine" ? { routineId: run.target.id, fromVersion: run.version - 1, toVersion: run.version } : null);
    return (
      <Notice
        title={copy.results.fix.rerunTitle}
        actions={
          <>
            <ButtonLink href={`/results?run=${run.autoFixOf}`}>{copy.results.fix.firstRun}</ButtonLink>
            {fix && fix.fromVersion > 0 && restoreButton(fix, fix.fromVersion)}
          </>
        }
      >
        {copy.results.fix.rerunBody(fix?.toVersion ?? run.version)}
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
            {restoreButton(fix, fix.fromVersion)}
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

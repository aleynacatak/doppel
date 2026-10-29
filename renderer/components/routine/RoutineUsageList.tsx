"use client";

import type { RoutineUsage } from "@core/types";
import Link from "next/link";
import { useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";
import { Tag } from "../ui/Tag";

/** Flows that use a routine, the versions they pin, and "Update all flows" for compatible updates. */
export function RoutineUsageList({ routineId }: { routineId: string }) {
  const { data: usage, reload } = useAsync<RoutineUsage[]>(() => doppel().getRoutineUsage(routineId), [routineId]);
  const [result, setResult] = useState<{ updated: string[]; skipped: { name: string; reason: string }[] } | null>(null);
  if (!usage) return null;
  if (usage.length === 0) return <p className="ui-muted">{copy.usage.none}</p>;
  const outdated = usage.filter((u) => u.nodes.some((n) => n.version !== u.latest));
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {usage.map((u) => {
          const versions = [...new Set(u.nodes.map((n) => n.version))].sort((a, b) => a - b);
          const current = versions.every((v) => v === u.latest);
          return (
            <li key={u.flowId} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/flow?id=${u.flowId}`} className="ui-link">
                  {u.name}
                </Link>
                <span className="ui-small ui-muted">{copy.usage.pinned(versions)}</span>
                {current ? <Tag>{copy.usage.upToDate}</Tag> : u.compatible ? <Tag tone="strong">{copy.flow.updateAvailable(u.latest)}</Tag> : <Tag tone="quiet">{copy.usage.updateBreaking}</Tag>}
              </div>
              {!current && !u.compatible && (
                <ul className="ui-small ui-muted flex flex-col">
                  {u.changes
                    .filter((c) => c.breaking)
                    .map((c, i) => (
                      <li key={i}>{c.message}</li>
                    ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {outdated.some((u) => u.compatible) && (
        <div>
          <Button
            onClick={async () => {
              setResult(await doppel().updateFlowsToLatest(routineId));
              reload();
            }}
          >
            {copy.usage.updateAll}
          </Button>
        </div>
      )}
      {result && (
        <Notice tone={result.skipped.length ? "warning" : "info"}>
          {result.updated.length > 0 && <p>{copy.usage.updated(result.updated)}</p>}
          {result.skipped.map((s) => (
            <p key={s.name} className="ui-small">
              {copy.usage.skipped(s.name)}
            </p>
          ))}
        </Notice>
      )}
    </div>
  );
}

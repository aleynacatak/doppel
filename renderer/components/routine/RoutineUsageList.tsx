"use client";

import type { RoutineUsage } from "@core/types";
import Link from "next/link";
import { useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";
import { Notice } from "../common/Notice";
import { Tag } from "../common/Tag";
import { Button } from "@/components/ui/button";

/** Flows that use a routine, the versions they pin, and "Update all flows" for compatible updates. */
export function RoutineUsageList({ routineId }: { routineId: string }) {
  const { data: usage, reload } = useAsync<RoutineUsage[]>(() => doppel().getRoutineUsage(routineId), [routineId]);
  const [result, setResult] = useState<{ updated: string[]; skipped: { name: string; reason: string }[] } | null>(null);
  if (!usage) return null;
  if (usage.length === 0) return <p className="text-muted-foreground">{copy.usage.none}</p>;
  const outdated = usage.filter((u) => u.nodes.some((n) => n.version !== u.latest));
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {usage.map((u) => {
          const versions = [...new Set(u.nodes.map((n) => n.version))].sort((a, b) => a - b);
          const current = versions.every((v) => v === u.latest);
          return (
            <li key={u.flowId} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/flow?id=${u.flowId}`} className="text-primary underline-offset-4 hover:underline">
                  {u.name}
                </Link>
                <span className="text-sm text-muted-foreground">{copy.usage.pinned(versions)}</span>
                {current ? <Tag>{copy.usage.upToDate}</Tag> : u.compatible ? <Tag tone="strong">{copy.flow.updateAvailable(u.latest)}</Tag> : <Tag tone="quiet">{copy.usage.updateBreaking}</Tag>}
              </div>
              {!current && !u.compatible && (
                <ul className="text-sm text-muted-foreground flex flex-col">
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
          <Button variant="outline"
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
            <p key={s.name} className="text-sm">
              {copy.usage.skipped(s.name)}
            </p>
          ))}
        </Notice>
      )}
    </div>
  );
}

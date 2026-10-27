"use client";

import type { RunSummary } from "@core/types";
import { useRouter } from "next/navigation";
import { copy } from "@/copy";
import { formatDateTime } from "@/lib/format";
import { Tag } from "../ui/Tag";

function QcTag({ run }: { run: RunSummary }) {
  if (run.status === "failed" || run.status === "cancelled" || run.status === "running") return <span className="ui-muted">—</span>;
  if (run.qcStatus === "flagged") return <Tag tone="filled">{`${run.flaggedCount} ${copy.qcStatus.flagged.toLowerCase()}`}</Tag>;
  if (run.qcStatus === "pass") return <Tag>{copy.qcStatus.pass}</Tag>;
  return <Tag tone="quiet">{copy.qcStatus["not-checked"]}</Tag>;
}

export function RunHistory({ runs }: { runs: RunSummary[] }) {
  const router = useRouter();
  if (runs.length === 0) return <p className="ui-muted">{copy.routine.noRuns}</p>;
  return (
    <table className="ui-table">
      <thead>
        <tr>
          <th className="py-2 pr-4">{copy.routine.table.date}</th>
          <th className="py-2 pr-4">{copy.routine.table.inputs}</th>
          <th className="py-2 pr-4">{copy.routine.table.result}</th>
          <th className="py-2">{copy.routine.table.qc}</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} data-clickable="true" onClick={() => router.push(`/results?run=${run.id}`)}>
            <td className="py-2 pr-4 whitespace-nowrap">
              <a href={`/results?run=${run.id}`} className="ui-link" onClick={(e) => e.preventDefault()}>
                {formatDateTime(run.startedAt)}
              </a>
            </td>
            <td className="ui-muted py-2 pr-4">{run.inputsSummary}</td>
            <td className="py-2 pr-4 whitespace-nowrap">
              {copy.runStatus[run.status]}
              <span className="ui-muted"> · {copy.plural(run.outputCount, "output")}</span>
              <span className="ui-muted"> · {copy.plural(run.aiCalls, "AI call")}</span>
            </td>
            <td className="py-2">
              <QcTag run={run} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

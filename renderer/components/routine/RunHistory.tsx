"use client";

import type { RunSummary } from "@core/types";
import { useRouter } from "next/navigation";
import { copy } from "@/copy";
import { formatDateTime } from "@/lib/format";
import { Tag } from "../common/Tag";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function QcTag({ run }: { run: RunSummary }) {
  if (run.status === "failed" || run.status === "cancelled" || run.status === "running") return <span className="text-muted-foreground">—</span>;
  if (run.qcStatus === "flagged") return <Tag tone="filled">{`${run.flaggedCount} ${copy.qcStatus.flagged.toLowerCase()}`}</Tag>;
  if (run.qcStatus === "pass") return <Tag>{copy.qcStatus.pass}</Tag>;
  return <Tag tone="quiet">{copy.qcStatus["not-checked"]}</Tag>;
}

export function RunHistory({ runs }: { runs: RunSummary[] }) {
  const router = useRouter();
  if (runs.length === 0) return <p className="text-muted-foreground">{copy.routine.noRuns}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="py-3 pr-4">{copy.routine.table.date}</TableHead>
          <TableHead className="py-3 pr-4">{copy.routine.table.inputs}</TableHead>
          <TableHead className="py-3 pr-4">{copy.routine.table.result}</TableHead>
          <TableHead className="py-3">{copy.routine.table.qc}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} data-clickable="true" onClick={() => router.push(`/results?run=${run.id}`)}>
            <TableCell className="py-3 pr-4 whitespace-nowrap">
              <a href={`/results?run=${run.id}`} className="text-primary underline-offset-4 hover:underline" onClick={(e) => e.preventDefault()}>
                {formatDateTime(run.startedAt)}
              </a>
            </TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4">{run.inFlow ? `${copy.routine.inFlow(run.inFlow)} · ${run.inputsSummary}` : run.inputsSummary}</TableCell>
            <TableCell className="py-3 pr-4 whitespace-nowrap">
              {copy.runStatus[run.status]}
              <span className="text-muted-foreground"> · {copy.plural(run.outputCount, "output")}</span>
              <span className="text-muted-foreground"> · {copy.plural(run.aiCalls, "AI call")}</span>
            </TableCell>
            <TableCell className="py-3">
              <QcTag run={run} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

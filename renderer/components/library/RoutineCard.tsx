import type { Flow, Routine } from "@core/types";
import Link from "next/link";
import { copy } from "@/copy";
import { appLabel, flowApps, formatRelative } from "@/lib/format";
import { RoutineBadges } from "../routine/ContractView";
import { Tag } from "../common/Tag";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const lastRun = (r: { runs: { startedAt: string }[] }) => (r.runs[0] ? formatRelative(r.runs[0].startedAt) : copy.library.never);

export function RoutineCard({ routine }: { routine: Routine }) {
  return (
    <Link href={`/routine?id=${routine.id}`} className="flex rounded-2xl">
      <Card className="w-full hover:ring-foreground/30">
        <CardHeader>
          <CardTitle>{routine.name}</CardTitle>
          <CardAction className="flex flex-wrap justify-end gap-1">
            <RoutineBadges appId={routine.appId} starter={!!routine.starter} />
          </CardAction>
          <CardDescription className="line-clamp-2">{routine.description}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          {!routine.starter && (
            <>
              <span>
                {copy.library.lastRun}: {lastRun(routine)}
              </span>
              <span>{copy.library.runs(routine.runs.length)}</span>
            </>
          )}
          {routine.starter?.tags.includes("converter") && <span>Converter</span>}
          {routine.experimental && <span>{copy.common.experimental}</span>}
        </CardContent>
      </Card>
    </Link>
  );
}

export function FlowCard({ flow }: { flow: Flow }) {
  const routines = flow.nodes.filter((n) => n.kind === "routine").length;
  return (
    <Link href={`/flow?id=${flow.id}`} className="flex rounded-2xl">
      <Card className="w-full hover:ring-foreground/30">
        <CardHeader>
          <CardTitle>{flow.name}</CardTitle>
          <CardAction className="flex flex-wrap justify-end gap-1">
            {flowApps(flow).map((id) => (
              <Tag key={id} tone="strong">
                {appLabel(id)}
              </Tag>
            ))}
          </CardAction>
          {flow.description && <CardDescription className="line-clamp-2">{flow.description}</CardDescription>}
        </CardHeader>
        <CardContent className="mt-auto flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span>{copy.library.flowNodes(routines)}</span>
          <span>
            {copy.library.lastRun}: {lastRun(flow)}
          </span>
          <span>{copy.library.runs(flow.runs.length)}</span>
        </CardContent>
      </Card>
    </Link>
  );
}

export function RoutineTable({ routines }: { routines: Routine[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="py-3 pr-4">{copy.library.table.name}</TableHead>
          <TableHead className="py-3 pr-4">{copy.library.table.app}</TableHead>
          <TableHead className="py-3 pr-4">{copy.library.table.lastRun}</TableHead>
          <TableHead className="py-3">{copy.library.table.runs}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {routines.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="py-3 pr-4">
              <Link href={`/routine?id=${r.id}`} className="text-primary underline-offset-4 hover:underline">
                {r.name}
              </Link>
            </TableCell>
            <TableCell className="py-3 pr-4">{appLabel(r.appId)}</TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4">{r.starter ? "—" : lastRun(r)}</TableCell>
            <TableCell className="text-muted-foreground py-3">{r.starter ? "—" : r.runs.length}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

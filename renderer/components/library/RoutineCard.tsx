import type { AppId, Flow, Routine } from "@core/types";
import Link from "next/link";
import { copy } from "@/copy";
import { appLabel, flowApps, formatRelative } from "@/lib/format";
import { AppLogo, AppTag } from "../common/AppLogo";
import { RoutineBadges } from "../routine/ContractView";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const lastRun = (r: { runs: { startedAt: string }[] }) => (r.runs[0] ? formatRelative(r.runs[0].startedAt) : copy.library.never);
const routineCount = (f: Flow) => f.nodes.filter((n) => n.kind === "routine").length;

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
  return (
    <Link href={`/flow?id=${flow.id}`} className="flex rounded-2xl">
      <Card className="w-full hover:ring-foreground/30">
        <CardHeader>
          <CardTitle>{flow.name}</CardTitle>
          <CardAction className="flex flex-wrap justify-end gap-1">
            {flowApps(flow).map((id) => (
              <AppTag key={id} appId={id} />
            ))}
          </CardAction>
          {flow.description && <CardDescription className="line-clamp-2">{flow.description}</CardDescription>}
        </CardHeader>
        <CardContent className="mt-auto flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span>{copy.library.flowNodes(routineCount(flow))}</span>
          <span>
            {copy.library.lastRun}: {lastRun(flow)}
          </span>
          <span>{copy.library.runs(flow.runs.length)}</span>
        </CardContent>
      </Card>
    </Link>
  );
}

function AppName({ appId }: { appId: AppId }) {
  return (
    <span className="flex items-center gap-2">
      <AppLogo appId={appId} />
      {appLabel(appId)}
    </span>
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
            <TableCell className="py-3 pr-4">
              <AppName appId={r.appId} />
            </TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4">{r.starter ? "—" : lastRun(r)}</TableCell>
            <TableCell className="text-muted-foreground py-3">{r.starter ? "—" : r.runs.length}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function FlowTable({ flows }: { flows: Flow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="py-3 pr-4">{copy.library.table.name}</TableHead>
          <TableHead className="py-3 pr-4">{copy.library.table.apps}</TableHead>
          <TableHead className="py-3 pr-4">{copy.library.table.routines}</TableHead>
          <TableHead className="py-3 pr-4">{copy.library.table.lastRun}</TableHead>
          <TableHead className="py-3">{copy.library.table.runs}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {flows.map((f) => (
          <TableRow key={f.id}>
            <TableCell className="py-3 pr-4">
              <Link href={`/flow?id=${f.id}`} className="text-primary underline-offset-4 hover:underline">
                {f.name}
              </Link>
            </TableCell>
            <TableCell className="py-3 pr-4">
              {flowApps(f).length > 0 ? (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {flowApps(f).map((id) => (
                    <AppName key={id} appId={id} />
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4">{routineCount(f)}</TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4">{lastRun(f)}</TableCell>
            <TableCell className="text-muted-foreground py-3">{f.runs.length}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

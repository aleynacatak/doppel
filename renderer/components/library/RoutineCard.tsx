import type { Flow, Routine } from "@core/types";
import Link from "next/link";
import { copy } from "@/copy";
import { appLabel, flowApps, formatRelative } from "@/lib/format";
import { RoutineBadges } from "../routine/ContractView";
import { Tag } from "../ui/Tag";

const lastRun = (r: { runs: { startedAt: string }[] }) => (r.runs[0] ? formatRelative(r.runs[0].startedAt) : copy.library.never);

export function RoutineCard({ routine }: { routine: Routine }) {
  return (
    <Link href={`/routine?id=${routine.id}`} className="ui-card ui-card-link flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="ui-h3">{routine.name}</div>
        <span className="flex flex-wrap justify-end gap-1">
          <RoutineBadges appId={routine.appId} starter={!!routine.starter} />
        </span>
      </div>
      <p className="ui-small ui-muted line-clamp-2">{routine.description}</p>
      <div className="ui-small ui-muted mt-auto flex flex-wrap gap-x-3">
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
      </div>
    </Link>
  );
}

export function FlowCard({ flow }: { flow: Flow }) {
  const routines = flow.nodes.filter((n) => n.kind === "routine").length;
  return (
    <Link href={`/flow?id=${flow.id}`} className="ui-card ui-card-link flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="ui-h3">{flow.name}</div>
        <span className="flex flex-wrap justify-end gap-1">
          {flowApps(flow).map((id) => (
            <Tag key={id} tone="strong">
              {appLabel(id)}
            </Tag>
          ))}
        </span>
      </div>
      {flow.description && <p className="ui-small ui-muted line-clamp-2">{flow.description}</p>}
      <div className="ui-small ui-muted mt-auto flex flex-wrap gap-x-3">
        <span>{copy.library.flowNodes(routines)}</span>
        <span>
          {copy.library.lastRun}: {lastRun(flow)}
        </span>
        <span>{copy.library.runs(flow.runs.length)}</span>
      </div>
    </Link>
  );
}

export function RoutineTable({ routines }: { routines: Routine[] }) {
  return (
    <table className="ui-table">
      <thead>
        <tr>
          <th className="py-2 pr-4">{copy.library.table.name}</th>
          <th className="py-2 pr-4">{copy.library.table.app}</th>
          <th className="py-2 pr-4">{copy.library.table.lastRun}</th>
          <th className="py-2">{copy.library.table.runs}</th>
        </tr>
      </thead>
      <tbody>
        {routines.map((r) => (
          <tr key={r.id}>
            <td className="py-2 pr-4">
              <Link href={`/routine?id=${r.id}`} className="ui-link">
                {r.name}
              </Link>
            </td>
            <td className="py-2 pr-4">{appLabel(r.appId)}</td>
            <td className="ui-muted py-2 pr-4">{r.starter ? "—" : lastRun(r)}</td>
            <td className="ui-muted py-2">{r.starter ? "—" : r.runs.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

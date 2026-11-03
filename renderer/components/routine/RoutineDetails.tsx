import type { AiRole, Routine } from "@core/types";
import { copy } from "@/copy";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

const ROLES: AiRole[] = ["planner", "coder", "reviewer", "segmenter"];

/** Details: which model served each role while this version was made (provenance), and what it used. */
export function RoutineDetails({ routine }: { routine: Routine }) {
  const version = routine.versions.find((v) => v.version === routine.version);
  const provenance = version?.provenance;
  return (
    <div className="flex flex-col gap-4">
      {provenance ? (
        <Table>
          <TableBody>
            {ROLES.filter((r) => provenance[r]).map((role) => {
              const p = provenance[role]!;
              return (
                <TableRow key={role}>
                  <TableCell className="py-3 pr-4">{copy.aiModels.roles[role].label}</TableCell>
                  <TableCell className="py-3 pr-4">{p.model}</TableCell>
                  <TableCell className="text-muted-foreground py-3 pr-4">{copy.details.calls(p.calls)}</TableCell>
                  <TableCell className="text-muted-foreground py-3 pr-4">{copy.details.tokens(p.inputTokens, p.outputTokens)}</TableCell>
                  <TableCell className="text-muted-foreground py-3">{copy.details.cost(p.costUsd)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.details.noProvenance}</p>
      )}
      <div className="text-sm font-medium">{copy.blocks.title}</div>
      {routine.helpers && Object.keys(routine.helpers).length ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm">{copy.blocks.summary(Object.keys(routine.helpers).length, routine.steps.filter((s) => s.kind === "custom").length)}</p>
          <p className="text-sm text-muted-foreground">
            {Object.entries(routine.helpers)
              .map(([id, v]) => copy.blocks.pinned(id.split(".").pop() ?? id, v))
              .join(" · ")}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.blocks.none}</p>
      )}
    </div>
  );
}

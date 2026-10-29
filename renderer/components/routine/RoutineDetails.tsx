import type { AiRole, Routine } from "@core/types";
import { copy } from "@/copy";

const ROLES: AiRole[] = ["planner", "coder", "reviewer", "segmenter"];

/** Details: which model served each role while this version was made (provenance), and what it used. */
export function RoutineDetails({ routine }: { routine: Routine }) {
  const version = routine.versions.find((v) => v.version === routine.version);
  const provenance = version?.provenance;
  return (
    <div className="flex flex-col gap-3">
      {provenance ? (
        <table className="ui-table">
          <tbody>
            {ROLES.filter((r) => provenance[r]).map((role) => {
              const p = provenance[role]!;
              return (
                <tr key={role}>
                  <td className="py-2 pr-4">{copy.aiModels.roles[role].label}</td>
                  <td className="py-2 pr-4">{p.model}</td>
                  <td className="ui-muted py-2 pr-4">{copy.details.calls(p.calls)}</td>
                  <td className="ui-muted py-2 pr-4">{copy.details.tokens(p.inputTokens, p.outputTokens)}</td>
                  <td className="ui-muted py-2">{copy.details.cost(p.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="ui-small ui-muted">{copy.details.noProvenance}</p>
      )}
      <div className="ui-label">{copy.blocks.title}</div>
      {routine.helpers && Object.keys(routine.helpers).length ? (
        <div className="flex flex-col gap-1">
          <p className="ui-small">{copy.blocks.summary(Object.keys(routine.helpers).length, routine.steps.filter((s) => s.kind === "custom").length)}</p>
          <p className="ui-small ui-muted">
            {Object.entries(routine.helpers)
              .map(([id, v]) => copy.blocks.pinned(id.split(".").pop() ?? id, v))
              .join(" · ")}
          </p>
        </div>
      ) : (
        <p className="ui-small ui-muted">{copy.blocks.none}</p>
      )}
    </div>
  );
}

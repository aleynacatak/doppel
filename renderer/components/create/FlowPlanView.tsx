import type { Creation, FlowPlan } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { ContractView, PortTable } from "../routine/ContractView";
import { Spinner } from "../ui/Progress";
import { Tag } from "../ui/Tag";
import { describeSpec, inputSpec } from "@shared/ports";

/** "input.photos" → "Photos (flow input)", "cutouts.cutouts" → "Cut out photos · Cutouts". */
function endLabel(plan: FlowPlan, ref: string) {
  const [head, port] = ref.split(".");
  if (head === "input") return `${plan.inputs.find((p) => p.key === port)?.label ?? port} (${copy.planEnds.input})`;
  if (head === "output") return `${plan.outputs.find((p) => p.key === port)?.label ?? port} (${copy.planEnds.output})`;
  const r = plan.routines.find((x) => x.id === head);
  const p = r?.inputs.find((x) => x.key === port) ?? r?.outputs.find((x) => x.key === port);
  return `${r?.name ?? head} · ${p?.label ?? port}`;
}

/** The proposed flow: routines with their apps and contracts, what the designer picks, and how they connect. */
export function FlowPlanView({ plan }: { plan: FlowPlan }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="ui-h2">{plan.name}</div>
        <p className="ui-muted">{plan.description}</p>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="ui-h3">{copy.create.planInputs}</div>
          <PortTable ports={plan.inputs} describe={(p) => describeSpec(inputSpec(p))} empty={copy.routine.noInputs} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="ui-h3">{copy.create.planOutputs}</div>
          <PortTable ports={plan.outputs} describe={(p) => describeSpec(inputSpec(p))} empty={copy.routine.noOutputs} />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="ui-h3">{copy.create.planRoutines}</div>
        <ol className="flex flex-col gap-3">
          {plan.routines.map((r, i) => (
            <li key={r.id} className="ui-card flex flex-col gap-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-small ui-muted">{copy.flow.listStep(i + 1)}</span>
                <Tag tone="strong">{appLabel(r.appId)}</Tag>
                <span className="ui-h3">{r.name}</span>
              </div>
              <p className="ui-small">{r.purpose}</p>
              <ContractView routine={r} compact />
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-2">
        <div className="ui-h3">{copy.create.planConnections}</div>
        <ul className="ui-small flex flex-col gap-1">
          {plan.connections.map((c, i) => (
            <li key={i}>
              {endLabel(plan, c.from)} → {endLabel(plan, c.to)}
              {c.match && <span className="ui-muted"> · {copy.match.describe(c.match)}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The plan's routines, created one after another. */
export function FlowRoutinesProgress({ creation }: { creation: Creation }) {
  return (
    <ol className="flex flex-col gap-2">
      {(creation.flowRoutines ?? []).map((r, i) => (
        <li key={r.id} className="ui-card flex flex-wrap items-center gap-2 px-3 py-2" data-selected={r.status === "creating"}>
          <span className="ui-small ui-muted">{copy.flow.listStep(i + 1)}</span>
          <Tag tone="strong">{appLabel(r.appId)}</Tag>
          <span className="ui-h3">{r.name}</span>
          <span className="ui-small ui-muted ml-auto flex items-center gap-2">
            {r.status === "creating" && <Spinner />}
            {copy.create.flowRoutineStatus[r.status]}
            {r.aiCalls > 0 && ` · ${copy.plural(r.aiCalls, "AI call")}`}
          </span>
        </li>
      ))}
    </ol>
  );
}

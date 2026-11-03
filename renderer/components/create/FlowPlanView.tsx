import type { Creation, FlowPlan } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { ContractView, PortTable } from "../routine/ContractView";
import { Spinner } from "../common/Progress";
import { Tag } from "../common/Tag";
import { describeSpec, inputSpec } from "@shared/ports";
import { Card, CardContent } from "@/components/ui/card";

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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <div className="text-base font-semibold">{plan.name}</div>
        <p className="text-muted-foreground">{plan.description}</p>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.create.planInputs}</div>
          <PortTable ports={plan.inputs} describe={(p) => describeSpec(inputSpec(p))} empty={copy.routine.noInputs} />
        </div>
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.create.planOutputs}</div>
          <PortTable ports={plan.outputs} describe={(p) => describeSpec(inputSpec(p))} empty={copy.routine.noOutputs} />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="text-sm font-medium">{copy.create.planRoutines}</div>
        <ol className="flex flex-col gap-4">
          {plan.routines.map((r, i) => (
            <li key={r.id}>
              <Card size="sm">
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">{copy.flow.listStep(i + 1)}</span>
                    <Tag tone="strong">{appLabel(r.appId)}</Tag>
                    <span className="text-sm font-medium">{r.name}</span>
                  </div>
                  <p className="text-sm">{r.purpose}</p>
                  <ContractView routine={r} compact />
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">{copy.create.planConnections}</div>
        <ul className="text-sm flex flex-col gap-1.5">
          {plan.connections.map((c, i) => (
            <li key={i}>
              {endLabel(plan, c.from)} → {endLabel(plan, c.to)}
              {c.match && <span className="text-muted-foreground"> · {copy.match.describe(c.match)}</span>}
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
    <ol className="flex flex-col gap-3">
      {(creation.flowRoutines ?? []).map((r, i) => (
        <li key={r.id}>
          <Card data-selected={r.status === "creating"} size="sm" className="data-[selected=true]:ring-2 data-[selected=true]:ring-primary">
            <CardContent className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{copy.flow.listStep(i + 1)}</span>
              <Tag tone="strong">{appLabel(r.appId)}</Tag>
              <span className="text-sm font-medium">{r.name}</span>
              <span className="text-sm text-muted-foreground ml-auto flex items-center gap-2">
                {r.status === "creating" && <Spinner />}
                {copy.create.flowRoutineStatus[r.status]}
                {r.aiCalls > 0 && ` · ${copy.plural(r.aiCalls, "AI call")}`}
              </span>
            </CardContent>
          </Card>
        </li>
      ))}
    </ol>
  );
}

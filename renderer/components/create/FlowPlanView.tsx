import type { Creation, FlowPlan } from "@core/types";
import { copy } from "@/copy";
import { ContractView, PortTable } from "../routine/ContractView";
import { AppTag } from "../common/AppLogo";
import { Spinner } from "../common/Progress";
import { Section } from "../common/Section";
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <div className="text-base font-semibold">{plan.name}</div>
        <p className="text-muted-foreground">{plan.description}</p>
      </div>
      <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-2">
        <Section title={copy.create.planInputs}>
          <PortTable ports={plan.inputs} describe={(p) => describeSpec(inputSpec(p))} empty={copy.routine.noInputs} />
        </Section>
        <Section title={copy.create.planOutputs}>
          <PortTable ports={plan.outputs} describe={(p) => describeSpec(inputSpec(p))} empty={copy.routine.noOutputs} />
        </Section>
      </div>
      <Section title={copy.create.planRoutines}>
        <ol className="flex flex-col">
          {plan.routines.map((r, i) => (
            <li key={r.id} className="flex flex-col gap-4 border-t py-4 first:border-t-0 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">{copy.flow.listStep(i + 1)}</span>
                <AppTag appId={r.appId} />
                <span className="text-sm font-medium">{r.name}</span>
              </div>
              <p className="text-sm">{r.purpose}</p>
              <ContractView routine={r} />
            </li>
          ))}
        </ol>
      </Section>
      <Section title={copy.create.planConnections}>
        <ul className="text-sm flex flex-col gap-1.5">
          {plan.connections.map((c, i) => (
            <li key={i}>
              {endLabel(plan, c.from)} → {endLabel(plan, c.to)}
              {c.match && <span className="text-muted-foreground"> · {copy.match.describe(c.match)}</span>}
            </li>
          ))}
        </ul>
      </Section>
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
              <AppTag appId={r.appId} />
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

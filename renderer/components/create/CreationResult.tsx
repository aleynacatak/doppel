import type { Creation, PortabilityIssue } from "@core/types";
import { copy } from "@/copy";
import { OutputCard } from "../results/OutputCard";
import { OutputGrid } from "../results/OutputGrid";
import { ParamsList } from "../routine/ParamsList";
import { StepsList } from "../routine/StepsList";
import { Section } from "../ui/Section";
import { Tag } from "../ui/Tag";
import { SaveRoutineForm } from "./SaveRoutineForm";

export function CreationResult({
  creation,
  onSave,
  onDiscard,
}: {
  creation: Creation;
  onSave: (name: string, acceptIssues: boolean) => Promise<PortabilityIssue[] | null>;
  onDiscard: () => void;
}) {
  const draft = creation.draft!;
  return (
    <div className="flex flex-col gap-8">
      <Section title={copy.create.resultTitle}>
        <p className="ui-muted">{copy.create.resultHint(creation.outputs.length)}</p>
        <OutputGrid>
          {creation.outputs.map((o) => (
            <OutputCard key={o.id} output={o} />
          ))}
        </OutputGrid>
      </Section>

      <Section title={copy.create.proposedTitle} aside={draft.experimental ? <Tag>{copy.common.experimental}</Tag> : undefined}>
        <p className="ui-muted">{draft.description}</p>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="ui-h3">{copy.create.stepsTitle}</div>
            <StepsList steps={draft.steps} />
          </div>
          <div className="flex flex-col gap-2">
            <div className="ui-h3">{copy.create.paramsTitle}</div>
            <ParamsList params={draft.params} />
          </div>
        </div>
        <SaveRoutineForm creation={creation} onSave={onSave} onDiscard={onDiscard} />
      </Section>
    </div>
  );
}

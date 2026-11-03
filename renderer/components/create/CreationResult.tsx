import type { Creation, PortabilityIssue } from "@core/types";
import { copy } from "@/copy";
import { OutputCard } from "../results/OutputCard";
import { OutputGrid } from "../results/OutputGrid";
import { ContractView } from "../routine/ContractView";
import { StepsList } from "../routine/StepsList";
import { Section } from "../common/Section";
import { Tag } from "../common/Tag";
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
    <div className="flex flex-col gap-6">
      <Section plain title={copy.create.resultTitle}>
        <p className="text-muted-foreground">{copy.create.resultHintStaged(creation.outputs.length)}</p>
        <OutputGrid>
          {creation.outputs.map((o) => (
            <OutputCard key={o.id} output={o} />
          ))}
        </OutputGrid>
      </Section>

      <Section title={copy.create.proposedTitle} aside={draft.experimental ? <Tag>{copy.common.experimental}</Tag> : undefined}>
        <p className="text-muted-foreground">{draft.description}</p>
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.create.stepsTitle}</div>
          <StepsList steps={draft.steps} />
        </div>
        <ContractView routine={draft} />
        <SaveRoutineForm creation={creation} onSave={onSave} onDiscard={onDiscard} />
      </Section>
    </div>
  );
}

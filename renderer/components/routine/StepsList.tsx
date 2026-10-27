import type { RoutineStep } from "@core/types";

export function StepsList({ steps }: { steps: RoutineStep[] }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map((step, i) => (
        <li key={step.id} className="flex gap-3">
          <span className="ui-muted w-5 shrink-0 text-right">{i + 1}.</span>
          <span>{step.plainLanguage}</span>
        </li>
      ))}
    </ol>
  );
}

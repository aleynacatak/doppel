import type { RoutineStep } from "@core/types";
import { copy } from "@/copy";
import { Tag } from "../common/Tag";

/** The plain-language steps; steps written as custom code (no tested building block) are marked. */
export function StepsList({ steps }: { steps: RoutineStep[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, i) => (
        <li key={step.id} className="flex gap-3">
          <span className="text-muted-foreground w-5 shrink-0 text-right">{i + 1}.</span>
          <span className="flex flex-wrap items-center gap-2">
            {step.plainLanguage}
            {step.kind === "custom" && <Tag tone="quiet">{copy.blocks.customTag}</Tag>}
          </span>
        </li>
      ))}
    </ol>
  );
}

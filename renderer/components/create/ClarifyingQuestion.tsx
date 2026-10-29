import type { ClarifyingQuestion as Question } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/Button";

export function ClarifyingQuestion({ question, onAnswer }: { question: Question; onAnswer: (optionId: string) => Promise<void> }) {
  const [sending, setSending] = useState<string | null>(null);
  const label = question.kind === "inputs" ? copy.create.inputsQuestionLabel : copy.create.questionLabel;
  // Options with a line of their own (example pairs, how many have one) are listed one under the other.
  const listed = question.options.some((o) => o.detail);
  const answer = async (id: string) => {
    setSending(id);
    await onAnswer(id);
  };
  return (
    <div className="ui-card flex flex-col gap-3 p-4" role="group" aria-label={label}>
      <div className="ui-label">{label}</div>
      <div className="ui-h2">{question.text}</div>
      {question.detail && <div className="ui-small ui-muted">{question.detail}</div>}
      {listed ? (
        <div className="flex flex-col gap-2">
          {question.options.map((o, i) => (
            <div key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button variant={i === 0 ? "primary" : "secondary"} disabled={sending !== null} onClick={() => answer(o.id)}>
                {o.label}
              </Button>
              {i === 0 && <span className="ui-small ui-muted">{copy.create.recommended}</span>}
              {o.detail && <span className="ui-small ui-muted">{o.detail}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {question.options.map((o, i) => (
            <Button key={o.id} variant={i === 0 ? "primary" : "secondary"} disabled={sending !== null} onClick={() => answer(o.id)}>
              {o.label}
            </Button>
          ))}
        </div>
      )}
      <div className="ui-small ui-muted">{copy.create.waitingHint}</div>
    </div>
  );
}

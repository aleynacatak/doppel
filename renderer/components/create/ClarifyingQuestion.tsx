import type { ClarifyingQuestion as Question } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/Button";

export function ClarifyingQuestion({ question, onAnswer }: { question: Question; onAnswer: (optionId: string) => Promise<void> }) {
  const [sending, setSending] = useState<string | null>(null);
  return (
    <div className="ui-card flex flex-col gap-3 p-4" role="group" aria-label={copy.create.questionLabel}>
      <div className="ui-label">{copy.create.questionLabel}</div>
      <div className="ui-h2">{question.text}</div>
      <div className="flex flex-wrap gap-2">
        {question.options.map((o, i) => (
          <Button
            key={o.id}
            variant={i === 0 ? "primary" : "secondary"}
            disabled={sending !== null}
            onClick={async () => {
              setSending(o.id);
              await onAnswer(o.id);
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
      <div className="ui-small ui-muted">{copy.create.waitingHint}</div>
    </div>
  );
}

import type { ClarifyingQuestion as Question } from "@core/types";
import { useRef, useState } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/Button";

/** An option that means "I'll say it myself": it opens the text box instead of answering. */
const OWN_WORDS = /^(something else|other|none of these)\b|describe it|my own words/i;

export function ClarifyingQuestion({ question, onAnswer }: { question: Question; onAnswer: (optionId: string) => Promise<void> }) {
  const [sending, setSending] = useState<string | null>(null);
  const [own, setOwn] = useState("");
  const ownRef = useRef<HTMLInputElement>(null);
  const label = question.kind === "inputs" ? copy.create.inputsQuestionLabel : copy.create.questionLabel;
  // Options with a line of their own (example pairs, how many have one) are listed one under the other.
  const listed = question.options.some((o) => o.detail);
  // The AI's questions can be answered in the designer's own words; Doppl's questions about files can't.
  const free = question.kind !== "inputs";
  const answer = async (id: string) => {
    const o = question.options.find((x) => x.id === id);
    if (free && o && OWN_WORDS.test(o.label)) {
      ownRef.current?.focus();
      return;
    }
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
      {free && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (own.trim()) void answer(own.trim());
          }}
        >
          <input ref={ownRef} className="ui-input min-w-0 flex-1" value={own} placeholder={copy.create.ownAnswer} aria-label={copy.create.ownAnswer} onChange={(e) => setOwn(e.target.value)} disabled={sending !== null} />
          <Button type="submit" disabled={!own.trim() || sending !== null}>
            {copy.create.ownAnswerSend}
          </Button>
        </form>
      )}
      <div className="ui-small ui-muted">{copy.create.waitingHint}</div>
    </div>
  );
}

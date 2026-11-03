import type { ClarifyingQuestion as Question } from "@core/types";
import { useRef, useState } from "react";
import { copy } from "@/copy";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
    <Card role="group" aria-label={label}>
      <CardContent className="flex flex-col gap-4">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-base font-semibold">{question.text}</div>
        {question.detail && <div className="text-sm text-muted-foreground">{question.detail}</div>}
        {listed ? (
          <div className="flex flex-col gap-3">
            {question.options.map((o, i) => (
              <div key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button variant={i === 0 ? "default" : "outline"} disabled={sending !== null} onClick={() => answer(o.id)}>
                  {o.label}
                </Button>
                {i === 0 && <span className="text-sm text-muted-foreground">{copy.create.recommended}</span>}
                {o.detail && <span className="text-sm text-muted-foreground">{o.detail}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {question.options.map((o, i) => (
              <Button key={o.id} variant={i === 0 ? "default" : "outline"} disabled={sending !== null} onClick={() => answer(o.id)}>
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
            <Input ref={ownRef} className="min-w-0 flex-1" value={own} placeholder={copy.create.ownAnswer} aria-label={copy.create.ownAnswer} onChange={(e) => setOwn(e.target.value)} disabled={sending !== null} />
            <Button variant="outline" type="submit" disabled={!own.trim() || sending !== null}>
              {copy.create.ownAnswerSend}
            </Button>
          </form>
        )}
        <div className="text-sm text-muted-foreground">{copy.create.waitingHint}</div>
      </CardContent>
    </Card>
  );
}

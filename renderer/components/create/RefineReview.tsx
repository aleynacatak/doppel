"use client";

import type { Creation, RunOutput } from "@core/types";
import Link from "next/link";
import { useState } from "react";
import { copy } from "@/copy";
import { OutputCard } from "../results/OutputCard";
import { ContractView } from "../routine/ContractView";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Notice } from "../ui/Notice";
import { Section } from "../ui/Section";
import { Tag } from "../ui/Tag";

const MARK = { added: "+", removed: "−", changed: "~", same: "" } as const;

function Outputs({ outputs, empty }: { outputs: RunOutput[]; empty: string }) {
  if (!outputs.length) return <p className="ui-small ui-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      {outputs.map((o) => (
        <OutputCard key={o.id} output={o} />
      ))}
    </div>
  );
}

/** Review of a refine before saving: what changed, before and after on the same items, and what it does to flows. */
export function RefineReview({
  creation,
  onSave,
  onTryAgain,
  onDiscard,
}: {
  creation: Creation;
  onSave: () => Promise<void>;
  onTryAgain: (instruction: string) => Promise<void>;
  onDiscard: () => void;
}) {
  const r = creation.refine!;
  const draft = creation.draft!;
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const breaking = r.contract.filter((c) => c.breaking);
  const compatible = r.contract.filter((c) => !c.breaking);
  const affected = r.flows.filter((f) => f.issues.length > 0);
  const byItem = (outputs: RunOutput[], key: string) => outputs.filter((o) => o.itemKey === key || (r.items.length === 1 && (!o.itemKey || o.itemKey === "all")));
  const changedSteps = r.steps.filter((s) => s.kind !== "same").length;

  return (
    <div className="flex flex-col gap-8">
      <Section title={copy.refine.reviewTitle}>
        <p className="ui-h2">{r.changeSummary}</p>
        <p className="ui-small ui-muted">{copy.refine.asked(r.request)}</p>
      </Section>

      <Section title={copy.refine.stepsTitle} aside={<span className="ui-small ui-muted">{copy.refine.stepsChanged(changedSteps)}</span>}>
        <ol className="flex flex-col gap-1">
          {r.steps.map((s, i) => (
            <li key={i} className="flex gap-3" data-change={s.kind}>
              <span className="ui-h3 w-4 shrink-0 text-center" aria-label={s.kind}>
                {MARK[s.kind]}
              </span>
              {s.kind === "changed" ? (
                <span className="flex flex-col">
                  <span className="ui-muted line-through">{s.before}</span>
                  <span className="ui-h3">{s.after}</span>
                </span>
              ) : s.kind === "removed" ? (
                <span className="ui-muted line-through">{s.before}</span>
              ) : s.kind === "added" ? (
                <span className="ui-h3">{s.after}</span>
              ) : (
                <span className="ui-muted">{s.after}</span>
              )}
            </li>
          ))}
        </ol>
      </Section>

      <Section title={copy.refine.compareTitle}>
        {r.items.map((item) => (
          <div key={item.key} className="flex flex-col gap-2">
            <div className="ui-h3">
              {item.label}
              {r.problemLabel && item.label === r.problemLabel && <span className="ui-small ui-muted"> · {copy.refine.problemTag.toLowerCase()}</span>}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <div className="ui-label">{copy.refine.before(r.fromVersion)}</div>
                <Outputs outputs={byItem(r.before, item.key)} empty={copy.refine.noBefore} />
              </div>
              <div className="flex flex-col gap-2">
                <div className="ui-label">{copy.refine.after}</div>
                <Outputs outputs={byItem(creation.outputs, item.key)} empty={copy.refine.noAfter} />
              </div>
            </div>
          </div>
        ))}
      </Section>

      <Section title={copy.refine.contractTitle}>
        {r.contract.length === 0 ? (
          <p className="ui-muted">{copy.refine.contractSame}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {breaking.length > 0 && (
              <Notice tone="warning" title={copy.refine.breakingTitle}>
                <ul className="ui-small flex flex-col gap-0.5">
                  {breaking.map((c, i) => (
                    <li key={i}>{c.message}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {compatible.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Tag>{copy.refine.compatibleTag}</Tag>
                  <span className="ui-small ui-muted">{copy.refine.compatibleHint}</span>
                </div>
                <ul className="ui-small flex flex-col gap-0.5">
                  {compatible.map((c, i) => (
                    <li key={i}>{c.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {r.flows.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="ui-label">{copy.refine.flowsTitle}</div>
            <ul className="ui-small flex flex-col gap-1">
              {r.flows.map((f) => (
                <li key={f.flowId}>
                  <Link href={`/flow?id=${f.flowId}`} className="ui-link">
                    {f.name}
                  </Link>
                  {f.issues.length ? (
                    <span> · {copy.refine.flowBreaks(f.issues.length)}: {f.issues.join(" ")}</span>
                  ) : (
                    <span className="ui-muted"> · {copy.refine.flowFine}</span>
                  )}
                </li>
              ))}
            </ul>
            {affected.length > 0 && <p className="ui-small ui-muted">{copy.refine.flowsStay}</p>}
          </div>
        )}
        <details>
          <summary className="ui-small ui-link">{copy.refine.fullContract}</summary>
          <div className="pt-3">
            <ContractView routine={draft} />
          </div>
        </details>
      </Section>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave().finally(() => setBusy(false));
            }}
          >
            {copy.refine.save(creation.nextVersion ?? r.fromVersion + 1)}
          </Button>
          <Button onClick={onDiscard} disabled={busy}>
            {copy.common.discard}
          </Button>
        </div>
        {!r.blockUpdate && (
        <Field label={copy.refine.tryAgainLabel} htmlFor="refine-again" hint={copy.refine.tryAgainHint}>
          <div className="flex flex-wrap gap-2">
            <input
              id="refine-again"
              className="ui-input max-w-xl flex-1"
              value={instruction}
              placeholder={copy.refine.tryAgainPlaceholder}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onTryAgain(instruction).finally(() => setBusy(false));
                setInstruction("");
              }}
            >
              {copy.refine.tryAgain}
            </Button>
          </div>
        </Field>
        )}
      </div>
    </div>
  );
}

"use client";

import type { RunOutput } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/Button";
import { Preview } from "../ui/Preview";
import { Tag } from "../ui/Tag";
import { QcChecks } from "./QcChecks";

const MAX_DETAILS = 8;

function StatusTag({ output }: { output: RunOutput }) {
  if (output.status === "failed") return <Tag tone="strong">{copy.results.failedOutput}</Tag>;
  if (output.status !== "done") return <Tag tone="quiet">{copy.run.outputStatus[output.status]}</Tag>;
  if (output.markedOk) return <Tag>{copy.results.markedOk}</Tag>;
  if (!output.qc) return <Tag tone="quiet">{copy.results.notChecked}</Tag>;
  return output.qc.status === "flagged" ? <Tag tone="filled">{copy.qcStatus.flagged}</Tag> : <Tag>{copy.qcStatus.pass}</Tag>;
}

export interface OutputActions {
  onOpen?: () => void;
  onReveal?: () => void;
  onMarkOk?: () => void;
  /** "This isn't right": opens Refine with this item attached; offered for failed items too. */
  onRefine?: () => void;
}

export function OutputCard({ output, actions }: { output: RunOutput; actions?: OutputActions }) {
  const [showChecks, setShowChecks] = useState(false);
  const problems = output.qc?.checks.filter((c) => !c.passed) ?? [];
  const flagged = output.qc?.status === "flagged" && !output.markedOk;
  return (
    <article className="ui-card flex flex-col overflow-hidden" data-selected={flagged}>
      <Preview
        preview={output.preview}
        status={output.status === "done" ? undefined : output.status === "failed" ? copy.results.failedOutput : copy.run.outputStatus[output.status]}
      />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="ui-h3 break-words">{output.label}</div>
            {output.itemLabel && output.itemLabel !== output.label && <div className="ui-small ui-muted truncate">{output.itemLabel}</div>}
          </div>
          <StatusTag output={output} />
        </div>

        {output.error && <p className="ui-small">{output.error}</p>}
        {output.status === "failed" && output.cause && <p className="ui-small ui-muted">{copy.results.cause[output.cause]}</p>}
        {problems.length > 0 && !output.markedOk && (
          <ul className="ui-small flex flex-col gap-0.5">
            {problems.map((p) => (
              <li key={p.label}>{p.reason ?? p.label}</li>
            ))}
          </ul>
        )}

        {output.details && output.details.length > 0 && (
          <ul className="ui-small ui-muted flex flex-col gap-0.5">
            {output.details.slice(0, MAX_DETAILS).map((d, i) => (
              <li key={`${d.label}-${i}`}>
                {d.label}
                {d.value !== undefined && <> → {d.value}</>}
              </li>
            ))}
            {output.details.length > MAX_DETAILS && <li>+ {output.details.length - MAX_DETAILS}</li>}
          </ul>
        )}

        {output.qc && (
          <div className="flex flex-col gap-2">
            <button type="button" className="ui-small ui-link self-start" onClick={() => setShowChecks((s) => !s)} aria-expanded={showChecks}>
              {showChecks ? copy.results.hideChecks : copy.results.showChecks}
            </button>
            {showChecks && <QcChecks checks={output.qc.checks} />}
          </div>
        )}

        {actions && (output.status === "done" || (output.status === "failed" && actions.onRefine)) && (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {actions.onOpen && output.status === "done" && (
              <Button size="small" onClick={actions.onOpen}>
                {copy.results.openInApp}
              </Button>
            )}
            {actions.onReveal && output.status === "done" && output.filePath && (
              <Button size="small" onClick={actions.onReveal}>
                {copy.results.showInFinder}
              </Button>
            )}
            {actions.onMarkOk && flagged && (
              <Button size="small" onClick={actions.onMarkOk}>
                {copy.results.markOk}
              </Button>
            )}
            {actions.onRefine && (
              <Button size="small" onClick={actions.onRefine}>
                {copy.results.notRight}
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

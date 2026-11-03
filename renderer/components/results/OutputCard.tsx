"use client";

import type { RunOutput } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { Details } from "../common/Details";
import { Preview } from "../common/Preview";
import { Tag } from "../common/Tag";
import { QcChecks } from "./QcChecks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const MAX_DETAILS = 8;

function StatusTag({ output }: { output: RunOutput }) {
  if (output.status === "failed") return <Tag tone="strong">{copy.results.failedOutput}</Tag>;
  if (output.status !== "done") return <Tag tone="quiet">{copy.run.outputStatus[output.status]}</Tag>;
  if (output.markedOk) return <Tag>{copy.results.markedOk}</Tag>;
  if (!output.qc || output.qc.status === "not-checked") return <Tag tone="quiet">{copy.results.notChecked}</Tag>;
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
  const problems = output.qc?.checks.filter((c) => !c.passed && !c.skipped) ?? [];
  const flagged = output.qc?.status === "flagged" && !output.markedOk;
  return (
    <Card size="sm" className="pt-0 data-[selected=true]:ring-2 data-[selected=true]:ring-primary" data-selected={flagged}>
      <Preview
        preview={output.preview}
        status={output.status === "done" ? undefined : output.status === "failed" ? copy.results.failedOutput : copy.run.outputStatus[output.status]}
      />
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium break-words">{output.label}</div>
            {output.itemLabel && output.itemLabel !== output.label && <div className="text-sm text-muted-foreground truncate">{output.itemLabel}</div>}
          </div>
          <StatusTag output={output} />
        </div>

        {output.error && <p className="text-sm">{output.error}</p>}
        {output.status === "failed" && output.cause && <p className="text-sm text-muted-foreground">{copy.results.cause[output.cause]}</p>}
        <Details text={output.errorDetail} />
        {problems.length > 0 && !output.markedOk && (
          <ul className="text-sm flex flex-col gap-1">
            {problems.map((p) => (
              <li key={p.label}>{p.reason ?? p.label}</li>
            ))}
          </ul>
        )}

        {output.details && output.details.length > 0 && (
          <ul className="text-sm text-muted-foreground flex flex-col gap-1">
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
          <div className="flex flex-col gap-3">
            <Button variant="link" className="h-auto p-0 text-sm self-start" onClick={() => setShowChecks((s) => !s)} aria-expanded={showChecks}>
              {showChecks ? copy.results.hideChecks : copy.results.showChecks}
            </Button>
            {showChecks && <QcChecks checks={output.qc.checks} />}
          </div>
        )}

        {actions && (output.status === "done" || (output.status === "failed" && actions.onRefine)) && (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {actions.onOpen && output.status === "done" && (
              <Button variant="outline" size="sm" onClick={actions.onOpen}>
                {copy.results.openInApp}
              </Button>
            )}
            {actions.onReveal && output.status === "done" && output.filePath && (
              <Button variant="outline" size="sm" onClick={actions.onReveal}>
                {copy.results.showInFinder}
              </Button>
            )}
            {actions.onMarkOk && flagged && (
              <Button variant="outline" size="sm" onClick={actions.onMarkOk}>
                {copy.results.markOk}
              </Button>
            )}
            {actions.onRefine && (
              <Button variant="outline" size="sm" onClick={actions.onRefine}>
                {copy.results.notRight}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

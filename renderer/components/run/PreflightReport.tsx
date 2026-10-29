"use client";

import type { PreflightIssue, PreflightReport as Report } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Progress";

/**
 * What Doppl found in the picked files before the run: what it handled on its own, what needs the designer (pick a
 * file or a column, or let the item be skipped), and what will be skipped. Picks are remembered for the next run.
 */
export function PreflightReport({
  report,
  loading,
  canPickPartners,
  onPickPartner,
  onPickColumn,
}: {
  report: Report | null;
  loading: boolean;
  /** Whether partners can be picked here (both routine and flow runs can). */
  canPickPartners: boolean;
  onPickPartner: (issue: Extract<PreflightIssue, { kind: "partner" }>, file: string) => void;
  onPickColumn: (issue: Extract<PreflightIssue, { kind: "column" }>, column: string) => void;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState(false);
  if (!report) return loading ? <Spinner /> : null;
  const needs = report.needs.filter((i) => !skipped.has(i.id));
  const nothing = report.fixed.length === 0 && needs.length === 0 && report.skipped.length === 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="ui-small ui-muted flex items-center gap-2">
        {nothing ? copy.run.preflight.allGood : copy.run.preflight.summary(report.fixed.length, needs.length, report.skipped.length + skipped.size)}
        {loading && <Spinner />}
      </p>
      {needs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {needs.map((i) => (
            <li key={i.id} className="ui-card flex flex-col gap-2 p-3">
              <span>⚠ {i.text}</span>
              {i.kind === "column" && (
                <select className="ui-select max-w-xs" value="" aria-label={copy.run.preflight.chooseColumn} onChange={(e) => e.target.value && onPickColumn(i, e.target.value)}>
                  <option value="">{copy.run.preflight.chooseColumn}</option>
                  {i.candidates.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
              {i.kind === "partner" && (
                <div className="flex flex-wrap items-center gap-2">
                  {canPickPartners && i.candidates.length > 0 && (
                    <select className="ui-select max-w-xs" value="" aria-label={copy.run.preflight.chooseFile} onChange={(e) => e.target.value && onPickPartner(i, e.target.value)}>
                      <option value="">{copy.run.preflight.chooseFile}</option>
                      {i.candidates.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  )}
                  <Button onClick={() => setSkipped((s) => new Set(s).add(i.id))}>{copy.run.preflight.skip}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {report.fixed.length > 0 && (
        <ul className="ui-small flex flex-col gap-1">
          {report.fixed.map((n, k) => (
            <li key={k}>
              ✓ {n.text}
              {details && n.detail && <span className="ui-muted"> · {n.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {(report.skipped.length > 0 || skipped.size > 0) && (
        <ul className="ui-small ui-muted flex flex-col gap-1">
          {report.needs
            .filter((i) => skipped.has(i.id))
            .map((i) => (
              <li key={i.id}>– {copy.run.preflight.willSkip(i.text)}</li>
            ))}
          {report.skipped.map((n, k) => (
            <li key={k}>– {n.text}</li>
          ))}
        </ul>
      )}
      {report.fixed.some((n) => n.detail) && (
        <button type="button" className="ui-link ui-small self-start" onClick={() => setDetails((d) => !d)}>
          {details ? copy.run.preflight.hideDetails : copy.run.preflight.showDetails}
        </button>
      )}
    </div>
  );
}

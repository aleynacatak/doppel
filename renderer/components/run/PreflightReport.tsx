"use client";

import type { PreflightIssue, PreviewImage, PreflightReport as Report } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Spinner } from "../common/Progress";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Card, CardContent } from "@/components/ui/card";

type Partner = Extract<PreflightIssue, { kind: "partner" }>;

/** The likeliest files for an item, as small pictures to pick from. */
function CandidatePictures({ issue, onPick }: { issue: Partner; onPick: (file: string) => void }) {
  const shown = issue.candidates.filter((c) => issue.files?.[c]).slice(0, 6);
  const [pictures, setPictures] = useState<Record<string, PreviewImage>>({});
  const paths = shown.map((c) => issue.files![c]).join("\n");
  useEffect(() => {
    let alive = true;
    if (paths)
      doppel()
        .previewFiles(paths.split("\n"))
        .then((p) => alive && setPictures(p))
        .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [paths]);
  const withPicture = shown.filter((c) => pictures[issue.files![c]]);
  if (!withPicture.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {withPicture.map((c) => (
        <button key={c} type="button" className="rounded-2xl bg-card text-card-foreground ring-1 ring-foreground/10 flex w-24 flex-col items-center gap-1.5 p-1" title={copy.run.preflight.useFile(c)} onClick={() => onPick(c)}>
          <img src={pictures[issue.files![c]].src} alt="" className="h-20 w-full object-contain" />
          <span className="text-sm w-full truncate">{c}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * What Doppl found in the picked files before the run: what it handled on its own, what needs the designer (pick a
 * file or a column, or let the item be skipped), and what will be skipped. Picks are remembered for the next run.
 * Items without a file can be matched with AI on request: Doppl suggests files, and nothing is used until approved.
 */
export function PreflightReport({
  report,
  loading,
  aiCalls = 0,
  canPickPartners,
  onPickPartner,
  onPickColumn,
  onSuggestPartners,
}: {
  report: Report | null;
  loading: boolean;
  /** AI calls the checks on this screen made (to match columns). */
  aiCalls?: number;
  /** Whether partners can be picked here (both routine and flow runs can). */
  canPickPartners: boolean;
  onPickPartner: (issue: Extract<PreflightIssue, { kind: "partner" }>, file: string) => void;
  onPickColumn: (pick: { inputNodeId: string; column: string }, header: string) => void;
  /** "Let Doppl match them": files suggested with AI for these items, by issue id. */
  onSuggestPartners?: (ids: string[]) => Promise<Record<string, string>>;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState(false);
  const [suggested, setSuggested] = useState<Record<string, string> | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  if (!report) return loading ? <Spinner /> : null;
  const needs = report.needs.filter((i) => !skipped.has(i.id));
  const unpaired = needs.filter((i): i is Partner => i.kind === "partner" && i.candidates.length > 0);
  // Suggestions still open: the item still needs a file and the suggested one is still free.
  const open = answered ? [] : unpaired.filter((i) => suggested?.[i.id] && i.candidates.includes(suggested[i.id]));
  const suggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      setSuggested(await onSuggestPartners!(unpaired.map((i) => i.id)));
    } catch (e) {
      setSuggestError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
  const notes = report.notes ?? [];
  const nothing = report.fixed.length === 0 && needs.length === 0 && report.skipped.length === 0 && notes.length === 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground flex items-center gap-2">
        {nothing ? copy.run.preflight.allGood : copy.run.preflight.summary(report.fixed.length, needs.length, report.skipped.length + skipped.size, notes.length)}
        {aiCalls > 0 && <span className="text-muted-foreground">· {copy.run.preflight.aiCalls(aiCalls)}</span>}
        {loading && <Spinner />}
      </p>
      {canPickPartners && onSuggestPartners && unpaired.length > 0 && (
        <div className="flex flex-col gap-3">
          {suggested === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={suggest} disabled={suggesting}>
                {suggesting ? copy.run.preflight.suggesting : copy.run.preflight.suggest}
              </Button>
              <span className="text-sm text-muted-foreground">{copy.run.preflight.suggestHint}</span>
              {suggesting && <Spinner />}
            </div>
          ) : open.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{copy.run.preflight.suggested(open.length)}</span>
              <Button variant="outline"
                onClick={() => {
                  for (const i of open) onPickPartner(i, suggested[i.id]);
                  setAnswered(true);
                }}
              >
                {copy.run.preflight.useSuggested}
              </Button>
              <Button variant="outline" onClick={() => setAnswered(true)}>{copy.run.preflight.dismissSuggested}</Button>
            </div>
          ) : (
            !answered && Object.keys(suggested).length === 0 && <span className="text-sm text-muted-foreground">{copy.run.preflight.noSuggestions}</span>
          )}
          {suggestError && <span className="text-sm">{suggestError}</span>}
        </div>
      )}
      {needs.length > 0 && (
        <ul className="flex flex-col gap-3">
          {needs.map((i) => (
            <li key={i.id}>
              <Card size="sm">
                <CardContent className="flex flex-col gap-3">
                  <span>⚠ {i.text}</span>
                  {i.kind === "partner" && open.includes(i) && <span className="text-sm">{copy.run.preflight.suggestion(suggested![i.id])}</span>}
                  {i.kind === "column" && (
                    <NativeSelect className="w-full max-w-xs" value="" aria-label={copy.run.preflight.chooseColumn} onChange={(e) => e.target.value && onPickColumn(i, e.target.value)}>
                      <NativeSelectOption value="">{copy.run.preflight.chooseColumn}</NativeSelectOption>
                      {i.candidates.map((c) => (
                        <NativeSelectOption key={c}>{c}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                  {i.kind === "partner" && (
                    <div className="flex flex-wrap items-center gap-2">
                      {canPickPartners && i.candidates.length > 0 && (
                        <NativeSelect className="w-full max-w-xs" value="" aria-label={copy.run.preflight.chooseFile} onChange={(e) => e.target.value && onPickPartner(i, e.target.value)}>
                          <NativeSelectOption value="">{copy.run.preflight.chooseFile}</NativeSelectOption>
                          {i.candidates.map((c) => (
                            <NativeSelectOption key={c}>{c}</NativeSelectOption>
                          ))}
                        </NativeSelect>
                      )}
                      <Button variant="outline" onClick={() => setSkipped((s) => new Set(s).add(i.id))}>{copy.run.preflight.skip}</Button>
                    </div>
                  )}
                  {i.kind === "partner" && canPickPartners && i.files && <CandidatePictures issue={i} onPick={(file) => onPickPartner(i, file)} />}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {report.fixed.length > 0 && (
        <ul className="text-sm flex flex-col gap-1.5">
          {report.fixed.map((n, k) => (
            <li key={k} className="flex flex-wrap items-center gap-2">
              <span>
                ✓ {n.text}
                {details && n.detail && <span className="text-muted-foreground"> · {n.detail}</span>}
              </span>
              {/* A column Doppl matched on its own: the designer can pick another. */}
              {n.change && (
                <NativeSelect className="w-full text-sm max-w-xs" value="" aria-label={copy.run.preflight.changeColumn} onChange={(e) => e.target.value && onPickColumn(n.change!, e.target.value)}>
                  <NativeSelectOption value="">{copy.run.preflight.changeColumn}</NativeSelectOption>
                  {n.change.candidates.map((c) => (
                    <NativeSelectOption key={c}>{c}</NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="text-sm flex flex-col gap-1.5">
          {notes.map((n, k) => (
            <li key={k}>ⓘ {n.text}</li>
          ))}
        </ul>
      )}
      {(report.skipped.length > 0 || skipped.size > 0) && (
        <ul className="text-sm text-muted-foreground flex flex-col gap-1.5">
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
        <Button variant="link" className="h-auto p-0 text-sm self-start" onClick={() => setDetails((d) => !d)}>
          {details ? copy.run.preflight.hideDetails : copy.run.preflight.showDetails}
        </Button>
      )}
    </div>
  );
}

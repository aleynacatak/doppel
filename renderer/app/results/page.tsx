"use client";

import type { RunOutput } from "@core/types";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { OutputCard } from "@/components/results/OutputCard";
import { OutputGrid } from "@/components/results/OutputGrid";
import { ResultsSummary } from "@/components/results/ResultsSummary";
import { RunFailure } from "@/components/results/RunFailure";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, Spinner } from "@/components/ui/Progress";
import { Segmented } from "@/components/ui/Segmented";
import { Tag } from "@/components/ui/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel, formatDateTime } from "@/lib/format";
import { useRun } from "@/lib/hooks";
import { useShell } from "@/lib/store";

type Filter = "all" | "flagged" | "passed";

const matches = (o: RunOutput, filter: Filter) => {
  if (filter === "all") return true;
  const flagged = o.status === "done" && o.qc?.status === "flagged" && !o.markedOk;
  if (filter === "flagged") return flagged;
  return o.status === "done" && !flagged;
};

function ResultsScreen() {
  const runId = useSearchParams().get("run");
  const router = useRouter();
  const apps = useShell((s) => s.apps);
  const { data: run, loading, setData } = useRun(runId);
  const [filter, setFilter] = useState<Filter>("all");
  const [note, setNote] = useState<string | null>(null);

  if (loading && run === undefined) return <Loading />;
  if (!run) return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;

  const api = doppel();
  const app = apps.find((a) => a.id === run.appId);
  const failedCount = run.outputs.filter((o) => o.status === "failed").length;
  const shown = run.outputs.filter((o) => matches(o, filter));
  const repair = async () => {
    const creation = await api.repairRoutine(run.routineId, run.id);
    router.push(`/create?task=${creation.id}`);
  };
  const open = async (o: RunOutput) => {
    setNote(null);
    try {
      await api.openOutput(run.id, o.id);
      if (app?.connection === "in-app-plugin") setNote(copy.results.openedMock(appLabel(run.appId)));
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: `/routine?id=${run.routineId}`, label: copy.results.backToRoutine }}
        title={copy.results.title(run.routineName)}
        subtitle={`${formatDateTime(run.startedAt)} · ${copy.common.version(run.routineVersion)} · ${copy.run.qcModes[run.qcMode].label}`}
        tags={<Tag tone={run.status === "failed" ? "strong" : "default"}>{copy.runStatus[run.status]}</Tag>}
        actions={<ButtonLink href={`/run?routine=${run.routineId}`}>{copy.results.runAgain}</ButtonLink>}
      />

      {run.status === "failed" && <RunFailure run={run} onRepair={repair} />}

      {run.status !== "failed" && (
        <>
          <ResultsSummary run={run} />
          {run.targetDocument && run.appId === "indesign" && (
            <div className="ui-small ui-muted flex flex-col">
              <span>{copy.results.ranOn(run.targetDocument.name, run.options.target === "copy")}</span>
              {run.modifiesDocument && <span>{copy.results.undoHint(run.routineName)}</span>}
            </div>
          )}
          {run.status === "running" && (
            <div className="ui-muted flex items-center gap-2">
              <Spinner /> {run.phase ?? copy.results.running}
            </div>
          )}
          {failedCount > 0 && run.status !== "running" && (
            <Notice
              tone="warning"
              title={copy.results.partialTitle(failedCount)}
              actions={
                <Button variant="primary" onClick={async () => setData(await api.retryFailed(run.id))}>
                  {copy.results.retryFailed}
                </Button>
              }
            />
          )}
          {note && <Notice>{note}</Notice>}
          <div>
            <Segmented<Filter>
              label="Filter outputs"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: copy.results.filters.all },
                { value: "flagged", label: copy.results.filters.flagged },
                { value: "passed", label: copy.results.filters.passed },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <p className="ui-muted">{copy.results.noneMatch}</p>
          ) : (
            <OutputGrid>
              {shown.map((o) => (
                <OutputCard
                  key={o.id}
                  output={o}
                  actions={{
                    onOpen: () => open(o),
                    onReveal: () => api.revealOutput(run.id, o.id),
                    onMarkOk: async () => setData(await api.markOutputOk(run.id, o.id)),
                  }}
                />
              ))}
            </OutputGrid>
          )}
        </>
      )}
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ResultsScreen />
    </Suspense>
  );
}

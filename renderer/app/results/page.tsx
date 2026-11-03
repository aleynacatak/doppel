"use client";

import type { NodeProgress, Run, RunOutput } from "@core/types";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { FixNotice } from "@/components/results/FixNotice";
import { OutputCard } from "@/components/results/OutputCard";
import { OutputGrid } from "@/components/results/OutputGrid";
import { AppTag } from "@/components/common/AppLogo";
import { Details } from "@/components/common/Details";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Loading, Spinner } from "@/components/common/Progress";
import { Section } from "@/components/common/Section";
import { Segmented } from "@/components/common/Segmented";
import { Tag } from "@/components/common/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { formatDateTime } from "@/lib/format";
import { useAsync, useRun } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/common/ButtonLink";

type Filter = "all" | "flagged" | "passed";

const matches = (o: RunOutput, filter: Filter) => {
  if (filter === "all") return true;
  const flagged = o.status === "done" && o.qc?.status === "flagged" && !o.markedOk;
  if (filter === "flagged") return flagged;
  // Outputs Doppl couldn't check aren't "passed".
  return o.status === "done" && !flagged && (o.markedOk || o.qc?.status === "pass");
};

/** "12 items · 2 flagged · 0 AI calls": items are what the last routine went through (its rows or files). */
function runSummary(run: Run) {
  const last = [...run.nodes].reverse().find((n) => n.kind === "routine" && n.total > 0);
  const items = last ? last.total : run.outputs.filter((o) => o.status !== "failed").length;
  const failedKeys = new Set(run.outputs.filter((o) => o.status === "failed").map((o) => o.itemKey ?? o.id));
  return {
    items,
    failed: failedKeys.size,
    flagged: run.outputs.filter((o) => o.status === "done" && o.qc?.status === "flagged" && !o.markedOk).length,
    aiCalls: run.aiCalls,
    // Doppl's fix after this run (not on the rerun it made, whose own calls are its run's).
    fixCalls: run.autoFixOf ? 0 : (run.fix?.aiCalls ?? 0),
  };
}

function NodeSection({ run, node, shown, card, onRepair }: { run: Run; node: NodeProgress; shown: RunOutput[]; card: (o: RunOutput) => React.ReactNode; onRepair?: () => void }) {
  const mine = shown.filter((o) => o.node === node.nodeId);
  const failedItems = node.items.filter((i) => i.status === "failed" || (i.status === "skipped" && i.error));
  // The AI can fix the routine, not the designer's files or an app that wasn't ready.
  const repairable = node.kind === "routine" && !!onRepair && (failedItems.length === 0 || failedItems.some((i) => !i.cause || i.cause === "routine"));
  return (
    <Section
      // Output cards stand on their own, so they aren't put in another card.
      plain={mine.length > 0 && node.kind !== "output"}
      title={
        <span id={`node-${node.nodeId}`} className="flex flex-wrap items-center gap-2">
          {node.appId && <AppTag appId={node.appId} />}
          {node.kind === "output" ? `${copy.flow.saveToFolder} · ${node.name}` : node.kind === "input" ? `${copy.flow.inputNode} · ${node.name}` : node.name}
        </span>
      }
      aside={<Tag>{copy.run.stageStatus[node.status]}</Tag>}
    >
      {node.documentName && node.kind === "routine" && <p className="text-sm text-muted-foreground">{copy.results.stageOn(node.documentName)}</p>}
      {node.kind === "output" && node.status === "done" && node.documentName && <p className="text-sm">{copy.results.savedTo(node.done, node.documentName)}</p>}
      {node.note && <p className="text-sm text-muted-foreground">{node.note}</p>}
      {node.error && (
        <Notice tone="warning" actions={repairable ? <Button variant="outline" size="sm" onClick={onRepair}>{copy.results.repair}</Button> : undefined}>
          {node.error}
          <Details text={node.errorDetail} />
        </Notice>
      )}
      {node.kind === "routine" && node.total > 1 && <p className="text-sm text-muted-foreground">{copy.run.stageProgress(node.done, node.total, node.failed)}</p>}
      {failedItems.length > 0 && node.kind !== "routine" && (
        <ul className="text-sm flex flex-col gap-1">
          {failedItems.map((i) => (
            <li key={i.key}>{i.error}</li>
          ))}
        </ul>
      )}
      {node.kind === "output" ? (
        <ul className="text-sm flex flex-col gap-1.5">
          {mine.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3">
              <span className="truncate">{o.label}</span>
              {o.filePath && (
                <Button variant="outline" size="sm" onClick={() => doppel().revealOutput(run.id, o.id)}>
                  {copy.results.showInFinder}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : mine.length === 0 ? (
        node.kind === "routine" && <p className="text-sm text-muted-foreground">{copy.results.noneMatch}</p>
      ) : (
        <OutputGrid>{mine.map(card)}</OutputGrid>
      )}
      {repairable && failedItems.length > 0 && !node.error && (
        <div>
          <Button variant="outline" size="sm" onClick={onRepair}>
            {copy.results.repair}
          </Button>
        </div>
      )}
    </Section>
  );
}

function ResultsScreen() {
  const runId = useSearchParams().get("run");
  const router = useRouter();
  const { data: run, loading, setData } = useRun(runId);
  const { data: flow } = useAsync(() => (run?.target.kind === "flow" ? doppel().getFlow(run.target.id) : Promise.resolve(null)), [run?.target.kind, run?.target.id]);
  const [filter, setFilter] = useState<Filter>("all");
  const [note, setNote] = useState<string | null>(null);

  if (loading && run === undefined) return <Loading />;
  if (!run) return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;

  const api = doppel();
  const isFlow = run.target.kind === "flow";
  const back = isFlow ? `/flow?id=${run.target.id}` : `/routine?id=${run.target.id}`;
  const again = `/run?${run.target.kind}=${run.target.id}`;
  const failedOutputs = run.outputs.filter((o) => o.status === "failed");
  const failedCount = failedOutputs.length;
  // Items that failed on their own files or data fail the same way again: the next step is to change the files.
  const filesOnly = failedCount > 0 && failedOutputs.every((o) => o.cause === "files");
  const shown = run.outputs.filter((o) => matches(o, filter));
  const summary = runSummary(run);
  const repairNode = (nodeId: string) => {
    const node = flow?.nodes.find((n) => n.id === nodeId);
    const routineId = isFlow ? (node?.kind === "routine" ? node.routineId : undefined) : run.target.id;
    if (!routineId || run.mocked) return undefined;
    return async () => {
      try {
        const creation = await api.repairRoutine(routineId, run.id);
        router.push(`/create?task=${creation.id}`);
      } catch (e) {
        setNote((e as Error).message);
      }
    };
  };
  // "This isn't right" on items a routine made (not the copies saved to a folder).
  const refineLink = (o: RunOutput) => {
    if (run.mocked) return undefined;
    if (!isFlow) return o.node === "routine" || !o.node ? `/refine?routine=${run.target.id}&run=${run.id}&output=${o.id}` : undefined;
    const node = flow?.nodes.find((n) => n.id === o.node);
    if (node?.kind !== "routine") return undefined;
    return `/refine?routine=${node.routineId}&run=${run.id}&output=${o.id}&flow=${run.target.id}&node=${node.id}`;
  };
  const retry = async () => {
    setNote(null);
    try {
      const next = await api.retryFailed(run.id);
      router.push(`/run?${next.target.kind}=${next.target.id}&run=${next.id}`);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const open = async (o: RunOutput) => {
    setNote(null);
    try {
      await api.openOutput(run.id, o.id);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const card = (o: RunOutput) => {
    const refine = refineLink(o);
    return (
      <OutputCard
        key={o.id}
        output={o}
        actions={{
          onOpen: () => open(o),
          onReveal: () => api.revealOutput(run.id, o.id),
          onMarkOk: async () => setData(await api.markOutputOk(run.id, o.id)),
          ...(refine && run.status !== "running" ? { onRefine: () => router.push(refine) } : {}),
        }}
      />
    );
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        back={{ href: back, label: isFlow ? copy.results.backToFlow : copy.results.backToRoutine }}
        title={copy.results.title(run.name)}
        subtitle={`${formatDateTime(run.startedAt)} · ${copy.common.version(run.version)} · ${copy.run.qcModes[run.qcMode].label}`}
        tags={<Tag tone={run.status === "failed" ? "strong" : "default"}>{copy.runStatus[run.status]}</Tag>}
        actions={<ButtonLink href={again}>{copy.results.runAgain}</ButtonLink>}
      />
      {run.mocked && <Notice>{copy.results.simulated}</Notice>}
      <p className="text-base font-semibold">{copy.results.itemsSummary(summary)}</p>
      <FixNotice run={run} />
      {run.status === "failed" && (run.error || run.errorDetail) && (
        <Notice tone="error" title={run.error ?? copy.results.failedTitle}>
          {run.errorDetail && <p>{run.errorDetail}</p>}
        </Notice>
      )}
      {run.status === "running" && (
        <div className="text-muted-foreground flex items-center gap-2">
          <Spinner /> {run.phase ?? copy.results.running}
        </div>
      )}
      {failedCount > 0 && run.status !== "running" && !["fixing", "ready", "fixed"].includes(run.fix?.status ?? "") && (
        <Notice
          tone="warning"
          title={copy.results.partialTitle(failedCount)}
          actions={
            filesOnly ? (
              <ButtonLink href={again} variant="default">
                {copy.results.runWithOtherFiles}
              </ButtonLink>
            ) : (
              <Button onClick={retry}>
                {copy.results.retryFailedItems}
              </Button>
            )
          }
        >
          {filesOnly && <p>{copy.results.filesOnlyBody}</p>}
        </Notice>
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
      {run.nodes
        .filter((n) => n.kind === "routine" || n.failed > 0 || n.status === "failed" || (n.kind === "output" && n.status !== "pending"))
        .map((node) => (
          <NodeSection key={node.nodeId} run={run} node={node} shown={shown} card={card} onRepair={repairNode(node.nodeId)} />
        ))}
      {run.workDir && <p className="text-sm text-muted-foreground">{copy.results.runFolder(run.workDir)}</p>}
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

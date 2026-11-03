"use client";

import type { RunTarget } from "@core/types";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { RunProgress } from "@/components/run/RunProgress";
import { RunSetupForm } from "@/components/run/RunSetupForm";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Loading } from "@/components/common/Progress";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useAsync, useRun } from "@/lib/hooks";
import { ButtonLink } from "@/components/common/ButtonLink";

function RunInProgress({ target, runId }: { target: RunTarget; runId: string }) {
  const router = useRouter();
  const { data: run, loading } = useRun(runId);
  const { data: flow } = useAsync(() => (target.kind === "flow" ? doppel().getFlow(target.id) : Promise.resolve(null)), [target.id]);

  useEffect(() => {
    if (run && run.status !== "running" && run.status !== "cancelled") router.replace(`/results?run=${run.id}`);
  }, [run, router]);

  if (loading && !run) return <Loading />;
  if (!run) return <EmptyState title={copy.common.notFound} />;
  if (run.status === "cancelled") {
    return (
      <Notice title={copy.run.cancelledTitle} actions={<ButtonLink href={`/run?${target.kind}=${target.id}`}>{copy.run.runAgain}</ButtonLink>}>
        {run.workDir && <p className="text-sm text-muted-foreground">{copy.results.runFolder(run.workDir)}</p>}
      </Notice>
    );
  }
  if (run.status !== "running") return <Loading />;
  return <RunProgress run={run} flow={flow} onCancel={() => doppel().cancelRun(run.id)} />;
}

function RunScreen() {
  const params = useSearchParams();
  const flowId = params.get("flow");
  const target: RunTarget | null = flowId ? { kind: "flow", id: flowId } : params.get("routine") ? { kind: "routine", id: params.get("routine")! } : null;
  const runId = params.get("run");
  const { data: setup, loading, error } = useAsync(() => (target ? doppel().getRunSetup(target) : Promise.resolve(null)), [target?.kind, target?.id]);

  if (!target) return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;
  if (loading && setup === undefined) return <Loading />;
  if (error || !setup) return <EmptyState title={copy.common.notFound} body={error ?? undefined} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;

  const back = target.kind === "flow" ? `/flow?id=${target.id}` : `/routine?id=${target.id}`;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader back={{ href: back, label: setup.name }} title={copy.run.title(setup.name)} />
      {runId ? <RunInProgress target={target} runId={runId} /> : <RunSetupForm key={`${target.kind}:${target.id}`} setup={setup} keepPicks={params.get("picked") === "1"} />}
    </div>
  );
}

export default function RunPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RunScreen />
    </Suspense>
  );
}

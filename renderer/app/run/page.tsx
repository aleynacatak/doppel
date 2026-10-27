"use client";

import type { ParamValue, ParamValues, QcMode, QcOptions, Routine, RunOptions } from "@core/types";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { EnvironmentWarning } from "@/components/run/EnvironmentWarning";
import { ParamForm, initialValues } from "@/components/run/ParamForm";
import { QcModePicker } from "@/components/run/QcModePicker";
import { RunProgress } from "@/components/run/RunProgress";
import { TargetOptions } from "@/components/run/TargetOptions";
import { AiCallCounter } from "@/components/ui/AiCallCounter";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { Section } from "@/components/ui/Section";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useAsync, useOpenDocuments, useRun } from "@/lib/hooks";
import { useAiReviewAvailable, useShell } from "@/lib/store";

const DEFAULT_QC: QcOptions = { minPpiPrint: 300, minPpiWeb: 150 };

function RunForm({ routine }: { routine: Routine }) {
  const router = useRouter();
  const flagsVersion = useShell((s) => s.flagsVersion);
  const aiReviewAvailable = useAiReviewAvailable();
  const { data: docs = [], connected, app } = useOpenDocuments(routine.appId);
  const [values, setValues] = useState<ParamValues>(() => initialValues(routine.params, routine.lastParams));
  const [qcMode, setQcMode] = useState<QcMode>("auto");
  const [qcOptions, setQcOptions] = useState<QcOptions>(DEFAULT_QC);
  const [target, setTarget] = useState<RunOptions["target"]>("copy");
  const [documentId, setDocumentId] = useState<string>();
  const [envAccepted, setEnvAccepted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: env } = useAsync(() => doppel().checkEnvironment(routine.id), [routine.id, flagsVersion, app?.status]);
  useEffect(() => {
    if (qcMode === "auto_ai" && !aiReviewAvailable) setQcMode("auto");
  }, [qcMode, aiReviewAvailable]);
  const envProblem = !!env && (env.versionMismatch || env.missingFonts.length > 0);
  useEffect(() => setEnvAccepted(false), [env]);

  const setValue = useCallback((key: string, value: ParamValue) => setValues((v) => ({ ...v, [key]: value })), []);

  const repair = async () => {
    const creation = await doppel().repairRoutine(routine.id);
    router.push(`/create?task=${creation.id}`);
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const run = await doppel().runRoutine(routine.id, values, qcMode, { target, documentId, qcOptions });
      router.replace(`/run?routine=${routine.id}&run=${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const needsDocument = app?.connection === "script-bridge";
  const blocked = !connected || (needsDocument && docs.length === 0) || (envProblem && !envAccepted);

  return (
    <div className="flex flex-col gap-8">
      {app && !connected && (
        <Notice tone="warning">
          <span>
            {copy.run.appNotConnected(app.name)}{" "}
            <Link href="/connect" className="ui-link">
              {copy.common.connectApps}
            </Link>
          </span>
        </Notice>
      )}
      {app && connected && needsDocument && docs.length === 0 && <Notice tone="warning">{copy.run.noDocument(app.name)}</Notice>}
      {envProblem && !envAccepted && env && (
        <EnvironmentWarning env={env} appName={app?.name ?? ""} onRunAnyway={() => setEnvAccepted(true)} onRepair={repair} />
      )}

      <Section title={copy.run.inputsTitle}>
        <ParamForm routineId={routine.id} params={routine.params} values={values} onChange={setValue} />
      </Section>

      {app && (
        <Section title={copy.run.targetTitle}>
          <TargetOptions
            app={app}
            docs={docs}
            documentId={documentId}
            onDocumentChange={setDocumentId}
            target={target}
            onTargetChange={setTarget}
            modifiesDocument={routine.modifiesDocument}
          />
        </Section>
      )}

      <Section title={copy.run.qcTitle}>
        <QcModePicker
          mode={qcMode}
          onModeChange={setQcMode}
          options={qcOptions}
          onOptionsChange={setQcOptions}
          showResolution={routine.appId === "indesign" && !routine.builtInQc}
          aiReviewAvailable={aiReviewAvailable}
        />
      </Section>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-wrap items-center gap-4">
        <Button variant="primary" onClick={start} disabled={blocked || starting}>
          {starting ? copy.run.starting : copy.run.runButton}
        </Button>
        <div className="w-72">
          <AiCallCounter count={0} label={copy.run.aiCounterLabel} hint={qcMode === "auto_ai" ? copy.run.aiCounterReview : copy.run.aiCounterZero} />
        </div>
      </div>
    </div>
  );
}

function RunInProgress({ routineId, runId }: { routineId: string; runId: string }) {
  const router = useRouter();
  const { data: run, loading } = useRun(runId);

  useEffect(() => {
    if (run && run.status !== "running" && run.status !== "cancelled") router.replace(`/results?run=${run.id}`);
  }, [run, router]);

  if (loading && !run) return <Loading />;
  if (!run) return <EmptyState title={copy.common.notFound} />;
  if (run.status === "cancelled") {
    return (
      <Notice title={copy.run.cancelledTitle} actions={<ButtonLink href={`/run?routine=${routineId}`}>{copy.run.runAgain}</ButtonLink>} />
    );
  }
  if (run.status !== "running") return <Loading />;
  return <RunProgress run={run} onCancel={() => doppel().cancelRun(run.id)} />;
}

function RunScreen() {
  const params = useSearchParams();
  const routineId = params.get("routine");
  const runId = params.get("run");
  const { data: routine, loading } = useAsync(() => (routineId ? doppel().getRoutine(routineId) : Promise.resolve(null)), [routineId]);

  if (loading && routine === undefined) return <Loading />;
  if (!routine) return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;

  return (
    <div className="flex flex-col gap-2">
      <PageHeader back={{ href: `/routine?id=${routine.id}`, label: routine.name }} title={copy.run.title(routine.name)} />
      {runId ? <RunInProgress routineId={routine.id} runId={runId} /> : <RunForm key={routine.id} routine={routine} />}
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

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ClarifyingQuestion } from "@/components/create/ClarifyingQuestion";
import { CreationFailure } from "@/components/create/CreationFailure";
import { CreationResult } from "@/components/create/CreationResult";
import { StageList } from "@/components/create/StageList";
import { StageProgressList } from "@/components/run/StageProgressList";
import { AiCallCounter } from "@/components/ui/AiCallCounter";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useCreation } from "@/lib/hooks";

function CreateScreen() {
  const id = useSearchParams().get("task");
  const router = useRouter();
  const { data: creation, loading, setData } = useCreation(id);

  if (loading && creation === undefined) return <Loading />;
  if (!id || !creation) {
    return <EmptyState title={copy.create.goneTitle} body={copy.create.goneBody} action={<ButtonLink href="/">{copy.create.newTask}</ButtonLink>} />;
  }

  const api = doppel();
  const discard = async () => {
    await api.discardCreation(creation.id);
    router.push(creation.mode === "repair" && creation.routineId ? `/routine?id=${creation.routineId}` : "/");
  };
  const save = async (name: string, acceptPortabilityIssues: boolean) => {
    const result = await api.saveRoutine(creation.id, { name, acceptPortabilityIssues });
    if (!result.saved) return result.issues;
    const notice = creation.mode === "repair" ? `repaired=${result.routine!.version}` : "saved=1";
    router.push(`/routine?id=${result.routine!.id}&${notice}`);
    return null;
  };
  const startOver = async () => {
    const t = creation.task;
    const next =
      creation.mode === "repair" && creation.routineId
        ? await api.repairRoutine(creation.routineId, creation.failedRunId)
        : await api.createRoutine({ request: t.request, references: t.references, folders: t.folders, appId: t.appId, documentId: t.documentId, apps: t.apps });
    await api.discardCreation(creation.id);
    router.replace(`/create?task=${next.id}`);
  };
  const running = creation.status === "running" || creation.status === "waiting";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={creation.mode === "repair" ? copy.create.titleRepair : copy.create.titleCreate}
        subtitle={<>“{creation.task.request}”</>}
        actions={
          running ? (
            <Button onClick={() => api.cancelCreation(creation.id)}>{copy.common.cancel}</Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto]">
        <StageList creation={creation} />
        <div className="flex flex-col gap-2 md:w-72">
          <AiCallCounter count={creation.aiCalls} label={copy.create.aiCallsLabel} hint={copy.create.aiCallsHint} />
          {creation.activity !== undefined && <p className="ui-small ui-muted">{copy.create.aiCallsLimit(15)}</p>}
          {creation.quota && <p className="ui-small">{copy.create.quota(creation.quota.used, creation.quota.max)}</p>}
        </div>
      </div>

      {creation.activity && creation.activity.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="ui-h3">{copy.create.activityTitle}</div>
          <ol className="ui-small flex list-decimal flex-col gap-0.5 pl-5">
            {creation.activity.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        </section>
      )}

      {creation.trialStages && running && (
        <section className="flex flex-col gap-2">
          <div className="ui-h3">{copy.create.trialTitle}</div>
          <StageProgressList stages={creation.trialStages} />
        </section>
      )}

      {creation.status === "waiting" && creation.question && (
        <ClarifyingQuestion
          question={creation.question}
          onAnswer={async (optionId) => {
            setData(await api.answerQuestion(creation.id, creation.question!.id, optionId));
          }}
        />
      )}

      {creation.status === "failed" && (
        <CreationFailure
          creation={creation}
          onRetry={async () => setData(await api.retryCreation(creation.id))}
          onStartOver={startOver}
          onDiscard={discard}
        />
      )}

      {creation.status === "cancelled" && (
        <Notice
          title={copy.create.cancelled}
          actions={
            <>
              <Button variant="primary" onClick={async () => setData(await api.retryCreation(creation.id))}>
                {copy.common.tryAgain}
              </Button>
              <ButtonLink href="/">{copy.create.newTask}</ButtonLink>
            </>
          }
        />
      )}

      {(creation.status === "ready" || creation.status === "saved") && creation.draft && (
        <CreationResult creation={creation} onSave={save} onDiscard={discard} />
      )}
    </div>
  );
}

export default function CreatePage() {
  return (
    <Suspense fallback={<Loading />}>
      <CreateScreen />
    </Suspense>
  );
}

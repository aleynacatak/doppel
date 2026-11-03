"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { Creation } from "@core/types";
import { Suspense, useState } from "react";
import { ClarifyingQuestion } from "@/components/create/ClarifyingQuestion";
import { CreationFailure } from "@/components/create/CreationFailure";
import { CreationResult } from "@/components/create/CreationResult";
import { FlowPlanView, FlowRoutinesProgress } from "@/components/create/FlowPlanView";
import { NeedsSamples } from "@/components/create/NeedsSamples";
import { RefineReview } from "@/components/create/RefineReview";
import { StageList } from "@/components/create/StageList";
import { NodeProgressList } from "@/components/run/NodeProgressList";
import { AiCallCounter } from "@/components/common/AiCallCounter";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Loading } from "@/components/common/Progress";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useCreation } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/common/ButtonLink";

function CreateScreen() {
  const id = useSearchParams().get("task");
  const router = useRouter();
  const { data: creation, loading, setData } = useCreation(id);
  // A button that failed (the app couldn't reach Doppl's service, say): said here instead of nothing happening.
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && creation === undefined) return <Loading />;
  if (!id || !creation) {
    return <EmptyState title={copy.create.goneTitle} body={copy.create.goneBody} action={<ButtonLink href="/">{copy.create.newTask}</ButtonLink>} />;
  }

  const api = doppel();
  const attempt = async (work: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await work();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const run = (next: Promise<Creation>) => attempt(async () => setData(await next));
  const discard = () =>
    attempt(async () => {
      await api.discardCreation(creation.id);
      router.push(creation.flowLink ? `/flow?id=${creation.flowLink.flowId}` : (creation.mode === "repair" || creation.mode === "refine") && creation.routineId ? `/routine?id=${creation.routineId}` : "/");
    });
  const save = async (name: string, acceptPortabilityIssues: boolean) => {
    const result = await api.saveRoutine(creation.id, { name, acceptPortabilityIssues });
    if (!result.saved) return result.issues;
    // "Make compatible" goes back to the flow, whose node now uses the new version.
    if (creation.flowLink) {
      router.push(`/flow?id=${creation.flowLink.flowId}&updated=${creation.flowLink.nodeId}`);
      return null;
    }
    const notice = creation.mode === "repair" ? `repaired=${result.routine!.version}` : "saved=1";
    router.push(`/routine?id=${result.routine!.id}&${notice}`);
    return null;
  };
  const startOver = () =>
    attempt(async () => {
      // "Make compatible" and Refine keep their place: start them over as they are.
      if (creation.flowLink || creation.mode === "refine") {
        setData(await api.retryCreation(creation.id));
        return;
      }
      const t = creation.task;
      const next =
        creation.mode === "repair" && creation.routineId
          ? await api.repairRoutine(creation.routineId, creation.failedRunId)
          : await api.createRoutine({ request: t.request, references: t.references, folders: t.folders, appId: t.appId, documentId: t.documentId, apps: t.apps });
      await api.discardCreation(creation.id);
      router.replace(`/create?task=${next.id}`);
    });
  const running = creation.status === "running" || creation.status === "waiting";
  const planWaiting = creation.kind === "flow" && creation.status === "waiting" && !!creation.plan && !creation.planConfirmed && !creation.question && !creation.needs;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        back={creation.flowLink ? { href: `/flow?id=${creation.flowLink.flowId}`, label: copy.create.backToFlow } : undefined}
        title={creation.mode === "refine" ? copy.refine.titleCreating : creation.mode === "repair" ? copy.create.titleRepair : creation.kind === "flow" ? copy.create.titleFlow : copy.create.titleCreate}
        subtitle={<>“{creation.task.request}”</>}
        actions={
          running ? (
            <Button variant="outline" onClick={() => api.cancelCreation(creation.id)}>{copy.common.cancel}</Button>
          ) : undefined
        }
      />
      {actionError && <Notice tone="error">{actionError}</Notice>}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto]">
        <StageList creation={creation} />
        <div className="flex flex-col gap-3 md:w-72">
          <AiCallCounter count={creation.aiCalls} label={copy.create.aiCallsLabel} hint={copy.create.aiCallsHint} />
          {creation.activity !== undefined && <p className="text-sm text-muted-foreground">{creation.steps ? copy.create.stepsOf(creation.steps, 15) : copy.create.aiCallsLimit(15)}</p>}
          {creation.quota && <p className="text-sm">{copy.create.quota(creation.quota.used, creation.quota.max)}</p>}
        </div>
      </div>

      {creation.activity && creation.activity.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.create.activityTitle}</div>
          <ol className="text-sm flex list-decimal flex-col gap-1 pl-5">
            {creation.activity.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        </section>
      )}

      {creation.kind === "flow" && creation.flowRoutines && (
        <section className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.create.flowRoutinesTitle}</div>
          <FlowRoutinesProgress creation={creation} />
        </section>
      )}

      {planWaiting && (
        <section className="flex flex-col gap-6">
          <div className="text-base font-semibold">{copy.create.planTitle}</div>
          <p className="text-muted-foreground">{copy.create.planHint}</p>
          <FlowPlanView plan={creation.plan!} />
          <div className="flex gap-2">
            <Button onClick={() => run(api.confirmPlan(creation.id))}>
              {copy.create.planConfirm}
            </Button>
            <Button variant="outline" onClick={discard}>{copy.common.discard}</Button>
          </div>
        </section>
      )}

      {creation.trial && running && (
        <section className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.create.trialTitle}</div>
          <NodeProgressList nodes={[creation.trial]} />
        </section>
      )}

      {creation.status === "saved" && creation.savedFlowId && (
        <Notice
          title={copy.create.flowSavedTitle}
          actions={
            <ButtonLink href={`/flow?id=${creation.savedFlowId}`} variant="default">
              {copy.create.openFlow}
            </ButtonLink>
          }
        >
          {copy.create.flowSavedBody(creation.flowRoutines?.length ?? 0, creation.aiCalls)}
        </Notice>
      )}

      {creation.status === "waiting" && creation.needs?.kind === "samples" && <NeedsSamples creation={creation} onChange={setData} />}

      {creation.status === "waiting" && creation.question && (
        <ClarifyingQuestion
          question={creation.question}
          onAnswer={(optionId) => run(api.answerQuestion(creation.id, creation.question!.id, optionId))}
        />
      )}

      {creation.status === "failed" && (
        <CreationFailure
          creation={creation}
          onRetry={() => run(api.retryCreation(creation.id))}
          onContinue={() => run(api.continueCreation(creation.id))}
          onStartOver={startOver}
          onDiscard={discard}
          onChangeRequest={async () => {
            const t = creation.task;
            useShell.getState().setDraftTask({ request: t.request, references: t.references, folders: t.folders, appId: t.appId, documentId: t.documentId, apps: t.apps });
            await api.discardCreation(creation.id);
            router.push("/");
          }}
        />
      )}

      {creation.status === "cancelled" && (
        <Notice
          title={copy.create.cancelled}
          actions={
            <>
              {creation.canContinue && (
                <Button onClick={() => run(api.continueCreation(creation.id))}>
                  {copy.create.continue}
                </Button>
              )}
              <Button variant={creation.canContinue ? "outline" : "default"} onClick={() => run(api.retryCreation(creation.id))}>
                {creation.canContinue ? copy.create.startOver : copy.common.tryAgain}
              </Button>
              <ButtonLink href="/">{copy.create.newTask}</ButtonLink>
            </>
          }
        />
      )}

      {creation.mode === "refine" && creation.status === "ready" && creation.draft && creation.refine && (
        <RefineReview
          creation={creation}
          onSave={async () => {
            const result = await api.saveRoutine(creation.id, { name: creation.draft!.name });
            const v = result.routine!.version;
            router.push(creation.flowLink ? `/flow?id=${creation.flowLink.flowId}&node=${creation.flowLink.nodeId}&refined=${v}` : `/routine?id=${result.routine!.id}&refined=${v}`);
          }}
          onTryAgain={(instruction) => run(api.refineFollowUp(creation.id, instruction))}
          onDiscard={discard}
        />
      )}

      {creation.mode !== "refine" && (creation.status === "ready" || (creation.status === "saved" && creation.kind === "routine")) && creation.draft && (
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

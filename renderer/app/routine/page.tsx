"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ContractSections, RoutineBadges } from "@/components/routine/ContractView";
import { CostLine } from "@/components/routine/CostLine";
import { RoutineDetails } from "@/components/routine/RoutineDetails";
import { RoutineUsageList } from "@/components/routine/RoutineUsageList";
import { RunHistory } from "@/components/routine/RunHistory";
import { ScriptViewer } from "@/components/routine/ScriptViewer";
import { StepsList } from "@/components/routine/StepsList";
import { VersionHistory } from "@/components/routine/VersionHistory";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Loading } from "@/components/common/Progress";
import { Section } from "@/components/common/Section";
import { Tag } from "@/components/common/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/common/ButtonLink";
import { useConfirm } from "@/components/common/ConfirmDialog";

function RoutineScreen() {
  const [confirm, confirmDialog] = useConfirm();
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const version = params.get("version") ? Number(params.get("version")) : null;
  const apps = useShell((s) => s.apps);
  const [showBody, setShowBody] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: latest, loading, error: loadError } = useAsync(() => (id ? doppel().getRoutine(id) : Promise.resolve(null)), [id, params.get("restored")]);
  const { data: viewed } = useAsync(() => (id && version ? doppel().getRoutineVersion(id, version) : Promise.resolve(null)), [id, version]);
  const { data: blockUpdates } = useAsync(() => (id ? doppel().getBlockUpdates(id) : Promise.resolve([])), [id, params.get("refined"), params.get("restored")]);
  const [updating, setUpdating] = useState(false);
  const { data: adoptable } = useAsync(() => (id ? doppel().getAdoptableBlocks(id) : Promise.resolve([])), [id, params.get("refined")]);

  if (loading && latest === undefined) return <Loading />;
  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!latest) {
    return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;
  }
  // An earlier version opened read-only from the version history.
  const readOnly = !!version && version !== latest.version && !!viewed;
  const routine = readOnly ? viewed! : latest;
  const restore = async (v: number) => {
    if (!(await confirm({ title: copy.versions.restore, body: copy.versions.restoreConfirm(v), action: copy.versions.restore }))) return;
    setError(null);
    try {
      const restored = await doppel().restoreRoutineVersion(latest.id, v);
      router.push(`/routine?id=${latest.id}&restored=${v}&as=${restored.version}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const app = apps.find((a) => a.id === routine.appId);
  const starter = !!routine.starter;
  const legacy = !!app && (app.id === "figma" ? routine.kind !== "actions" : routine.kind !== "script");
  const repaired = params.get("repaired");
  const duplicate = async () => {
    setError(null);
    try {
      const copyOf = await doppel().duplicateRoutine(routine.id);
      router.push(`/routine?id=${copyOf.id}&duplicated=1`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      {confirmDialog}
      <div className="flex flex-col gap-4">
        <PageHeader
          back={{ href: "/routines", label: copy.nav.library }}
          title={routine.name}
          tags={
            <>
              <RoutineBadges appId={routine.appId} starter={starter} />
              <Tag>{copy.common.version(routine.version)}</Tag>
              {routine.experimental && <Tag tone="quiet">{copy.common.experimental}</Tag>}
            </>
          }
          subtitle={routine.description}
          actions={
            <>
              <Button variant="outline" onClick={() => setShowBody((s) => !s)} aria-expanded={showBody}>
                {routine.kind === "actions" ? (showBody ? copy.routine.hideActions : copy.routine.viewActions) : showBody ? copy.routine.hideScript : copy.routine.viewScript}
              </Button>
              {readOnly ? (
                <>
                  {!starter && <Button variant="outline" onClick={() => restore(routine.version)}>{copy.versions.restore}</Button>}
                  <ButtonLink href={`/routine?id=${latest.id}`}>{copy.versions.backToCurrent}</ButtonLink>
                </>
              ) : (
                <>
                  {starter && <Button variant="outline" onClick={duplicate}>{copy.routine.duplicate}</Button>}
                  <ButtonLink href={`/refine?routine=${routine.id}`}>{starter ? copy.refine.duplicateAndRefine : copy.refine.button}</ButtonLink>
                  <ButtonLink href={`/run?routine=${routine.id}`} variant="default">
                    {copy.routine.run}
                  </ButtonLink>
                </>
              )}
            </>
          }
        />
        {readOnly && <Notice tone="warning">{copy.versions.readOnly(routine.version, latest.version)}</Notice>}
        {!readOnly && !starter && blockUpdates && blockUpdates.length > 0 && (
          <Notice
            title={copy.blocks.improved}
            actions={
              <Button variant="outline"
                disabled={updating}
                onClick={async () => {
                  setUpdating(true);
                  setError(null);
                  try {
                    const creation = await doppel().updateRoutineBlocks(latest.id);
                    router.push(`/create?task=${creation.id}`);
                  } catch (e) {
                    setError((e as Error).message);
                    setUpdating(false);
                  }
                }}
              >
                {updating ? copy.blocks.updating : copy.blocks.update}
              </Button>
            }
          >
            {copy.blocks.improvedBody(blockUpdates.map((u) => `${u.call} ${u.from} → ${u.to}: ${u.summary}`).join("; "))}
          </Notice>
        )}
        {!readOnly && !starter && adoptable && adoptable.length > 0 && (
          <Notice
            title={copy.blocks.adoptTitle}
            actions={
              <ButtonLink href={`/refine?routine=${latest.id}&request=${encodeURIComponent(copy.blocks.adoptRequest(adoptable.map((b) => b.call)))}`}>{copy.blocks.adopt}</ButtonLink>
            }
          >
            {copy.blocks.adoptBody(adoptable.map((b) => `${b.call}: ${b.summary}`).join("; "))}
          </Notice>
        )}
        {params.get("saved") && <Notice>{copy.routine.savedNotice}</Notice>}
        {params.get("refined") && <Notice>{copy.refine.refined(Number(params.get("refined")))}</Notice>}
        {params.get("restored") && <Notice>{copy.versions.restored(Number(params.get("restored")), Number(params.get("as")))}</Notice>}
        {params.get("duplicated") && <Notice>{copy.routine.duplicated}</Notice>}
        {repaired && <Notice>{copy.routine.repairedNotice(Number(repaired))}</Notice>}
        {starter && <Notice>{copy.routine.starterNotice}</Notice>}
        {legacy && <Notice tone="warning">{copy.routine.legacy}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {routine.portabilityIssues?.length ? <Notice tone="warning">{copy.routine.portabilityWarning}</Notice> : null}
        {!starter && <CostLine aiCalls={routine.createdWithAiCalls} />}
        {routine.duplicatedFrom && <p className="text-sm text-muted-foreground">{copy.routine.copiedFrom(routine.duplicatedFrom.name, routine.duplicatedFrom.version)}</p>}
        {routine.appVersion && (
          <p className="text-sm text-muted-foreground">{copy.routine.environment(app?.name ?? appLabel(routine.appId), routine.appVersion, routine.requiredFonts)}</p>
        )}
      </div>

      {showBody && (
        <Section title={routine.kind === "actions" ? copy.routine.viewActions.replace("View ", "").replace(/^./, (c) => c.toUpperCase()) : copy.routine.scriptTitle}>
          <ScriptViewer
            script={routine.kind === "actions" ? JSON.stringify(routine.actions ?? [], null, 2) : routine.script}
            language={routine.kind === "actions" ? "Doppl action list (JSON)" : (app?.scriptLanguage ?? "ExtendScript")}
          />
        </Section>
      )}

      <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title={copy.routine.stepsTitle}>
            <StepsList steps={routine.steps} />
          </Section>

          {!starter && !readOnly && (
            <Section title={copy.usage.title}>
              <RoutineUsageList routineId={routine.id} />
            </Section>
          )}

          {!starter && !readOnly && (
            <Section title={copy.routine.historyTitle}>
              <RunHistory runs={routine.runs} />
            </Section>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <ContractSections routine={routine} />

          <Section title={copy.routine.versionsTitle}>
            <VersionHistory routineId={latest.id} versions={latest.versions} current={latest.version} viewing={readOnly ? routine.version : undefined} onRestore={starter ? undefined : restore} />
          </Section>

          {!starter && (
            <Section title={copy.details.title}>
              <div className="text-sm font-medium">{copy.details.madeWith}</div>
              <RoutineDetails routine={routine} />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RoutinePage() {
  return (
    <Suspense fallback={<Loading />}>
      <RoutineScreen />
    </Suspense>
  );
}

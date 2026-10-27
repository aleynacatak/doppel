"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CostLine } from "@/components/routine/CostLine";
import { ParamsList } from "@/components/routine/ParamsList";
import { RunHistory } from "@/components/routine/RunHistory";
import { ScriptViewer } from "@/components/routine/ScriptViewer";
import { StagesList } from "@/components/routine/StagesList";
import { StepsList } from "@/components/routine/StepsList";
import { VersionHistory } from "@/components/routine/VersionHistory";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { useShell } from "@/lib/store";

function RoutineScreen() {
  const params = useSearchParams();
  const id = params.get("id");
  const apps = useShell((s) => s.apps);
  const [showScript, setShowScript] = useState(false);
  const { data: routine, loading, error } = useAsync(() => (id ? doppel().getRoutine(id) : Promise.resolve(null)), [id]);

  if (loading && routine === undefined) return <Loading />;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!routine) {
    return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines">{copy.nav.library}</ButtonLink>} />;
  }

  const app = apps.find((a) => a.id === routine.appId);
  const repaired = params.get("repaired");
  const stages = routine.stages ?? [];
  const appIds = stages.length ? [...new Set(stages.map((s) => s.appId))] : [routine.appId];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <PageHeader
          back={{ href: "/routines", label: copy.nav.library }}
          title={routine.name}
          tags={
            <>
              {appIds.map((id) => (
                <Tag key={id} tone="strong">
                  {appLabel(id)}
                </Tag>
              ))}
              <Tag>{copy.common.version(routine.version)}</Tag>
              {routine.experimental && <Tag tone="quiet">{copy.common.experimental}</Tag>}
            </>
          }
          subtitle={routine.description}
          actions={
            <>
              <Button onClick={() => setShowScript((s) => !s)} aria-expanded={showScript}>
                {stages.length ? (showScript ? copy.routine.hideStages : copy.routine.viewStages) : showScript ? copy.routine.hideScript : copy.routine.viewScript}
              </Button>
              <ButtonLink href={`/run?routine=${routine.id}`} variant="primary">
                {copy.routine.run}
              </ButtonLink>
            </>
          }
        />
        {params.get("saved") && <Notice>{copy.routine.savedNotice}</Notice>}
        {repaired && <Notice>{copy.routine.repairedNotice(Number(repaired))}</Notice>}
        {routine.portabilityIssues?.length ? <Notice tone="warning">{copy.routine.portabilityWarning}</Notice> : null}
        <CostLine aiCalls={routine.createdWithAiCalls} />
        {!stages.length && (
          <p className="ui-small ui-muted">{copy.routine.environment(app?.name ?? appLabel(routine.appId), routine.appVersion, routine.requiredFonts)}</p>
        )}
      </div>

      {showScript && !stages.length && (
        <Section title={copy.routine.scriptTitle}>
          <ScriptViewer script={routine.script} language={app?.scriptLanguage ?? ""} />
        </Section>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title={stages.length ? copy.routine.stagesTitle : copy.routine.stepsTitle}>
          {stages.length ? <StagesList stages={stages} showBodies={showScript} /> : <StepsList steps={routine.steps} />}
        </Section>
        <Section title={copy.routine.paramsTitle}>
          <ParamsList params={routine.params} />
        </Section>
      </div>

      <Section title={copy.routine.historyTitle}>
        <RunHistory runs={routine.runs} />
      </Section>

      <Section title={copy.routine.versionsTitle}>
        <VersionHistory versions={routine.versions} />
      </Section>
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

"use client";

import type { Routine } from "@core/types";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { type LibraryView, LibraryToolbar } from "@/components/library/LibraryToolbar";
import { FlowCard, RoutineCard, RoutineTable } from "@/components/library/RoutineCard";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { flowApps } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { useShell } from "@/lib/store";

type Tab = "routines" | "flows";

function RoutineList({ routines, view }: { routines: Routine[]; view: LibraryView }) {
  return view === "grid" ? (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {routines.map((r) => (
        <RoutineCard key={r.id} routine={r} />
      ))}
    </div>
  ) : (
    <RoutineTable routines={routines} />
  );
}

function LibraryScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const apps = useShell((s) => s.apps);
  const [tab, setTab] = useState<Tab>(params.get("tab") === "flows" ? "flows" : "routines");
  const { data, loading, error } = useAsync(
    async () => {
      const api = doppel();
      const [mine, starters, flows] = await Promise.all([api.listRoutines(), api.listStarterRoutines(), api.listFlows()]);
      return { mine, starters, flows };
    },
    [],
  );
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState("all");
  const [view, setView] = useState<LibraryView>("grid");

  const q = query.trim().toLowerCase();
  const matches = (name: string, description: string, appIds: string[]) =>
    (appFilter === "all" || appIds.includes(appFilter)) && (!q || `${name} ${description}`.toLowerCase().includes(q));
  const mine = (data?.mine ?? []).filter((r) => matches(r.name, r.description, [r.appId]));
  const starters = (data?.starters ?? []).filter((r) => matches(r.name, r.description, [r.appId]));
  const flows = (data?.flows ?? []).filter((f) => matches(f.name, f.description, flowApps(f)));
  const empty = data && data.mine.length === 0 && data.starters.length === 0 && data.flows.length === 0;

  const newFlow = async () => {
    const flow = await doppel().createFlow(copy.flow.untitled);
    router.push(`/flow?id=${flow.id}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={copy.library.title}
        actions={
          <>
            <Button onClick={newFlow}>{copy.library.newFlow}</Button>
            <ButtonLink href="/">{copy.library.newTask}</ButtonLink>
          </>
        }
      />
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : empty ? (
        <EmptyState
          title={copy.library.emptyTitle}
          body={copy.library.emptyBody}
          action={
            <ButtonLink href="/" variant="primary">
              {copy.library.emptyAction}
            </ButtonLink>
          }
        />
      ) : (
        <>
          <div>
            <Segmented<Tab>
              label="Library"
              value={tab}
              onChange={setTab}
              options={[
                { value: "routines", label: copy.library.tabs.routines },
                { value: "flows", label: copy.library.tabs.flows },
              ]}
            />
          </div>
          <LibraryToolbar query={query} onQuery={setQuery} appFilter={appFilter} onAppFilter={setAppFilter} view={view} onView={setView} apps={apps} />
          {tab === "routines" ? (
            <div className="flex flex-col gap-8">
              <Section title={copy.library.myRoutines}>
                {mine.length ? <RoutineList routines={mine} view={view} /> : <p className="ui-muted">{data?.mine.length ? copy.library.noMatch : copy.library.noMyRoutines}</p>}
              </Section>
              <Section title={copy.library.starterRoutines}>
                {starters.length ? <RoutineList routines={starters} view={view} /> : <p className="ui-muted">{data?.starters.length ? copy.library.noMatch : copy.library.noStarters}</p>}
              </Section>
            </div>
          ) : data?.flows.length === 0 ? (
            <EmptyState
              title={copy.library.flowsEmptyTitle}
              body={copy.library.flowsEmptyBody}
              action={
                <div className="flex gap-2">
                  <Button variant="primary" onClick={newFlow}>
                    {copy.library.newFlow}
                  </Button>
                  <ButtonLink href="/">{copy.library.newTask}</ButtonLink>
                </div>
              }
            />
          ) : flows.length === 0 ? (
            <p className="ui-muted">{copy.library.noMatch}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {flows.map((f) => (
                <FlowCard key={f.id} flow={f} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <LibraryScreen />
    </Suspense>
  );
}

"use client";

import { useState } from "react";
import { type LibraryView, LibraryToolbar } from "@/components/library/LibraryToolbar";
import { RoutineCard, RoutineTable } from "@/components/library/RoutineCard";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading } from "@/components/ui/Progress";
import { copy } from "@/copy";
import { routineApps } from "@/lib/format";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";
import { useShell } from "@/lib/store";

export default function LibraryPage() {
  const apps = useShell((s) => s.apps);
  const { data: routines, loading, error } = useAsync(() => doppel().listRoutines(), []);
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState("all");
  const [view, setView] = useState<LibraryView>("grid");

  const q = query.trim().toLowerCase();
  const shown = (routines ?? []).filter(
    (r) => (appFilter === "all" || routineApps(r).includes(appFilter)) && (!q || `${r.name} ${r.description}`.toLowerCase().includes(q)),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={copy.library.title} actions={<ButtonLink href="/">{copy.library.newTask}</ButtonLink>} />
      {loading && !routines ? (
        <Loading />
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : routines && routines.length === 0 ? (
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
          <LibraryToolbar query={query} onQuery={setQuery} appFilter={appFilter} onAppFilter={setAppFilter} view={view} onView={setView} apps={apps} />
          {shown.length === 0 ? (
            <p className="ui-muted">{copy.library.noMatch}</p>
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((r) => (
                <RoutineCard key={r.id} routine={r} />
              ))}
            </div>
          ) : (
            <RoutineTable routines={shown} />
          )}
        </>
      )}
    </div>
  );
}

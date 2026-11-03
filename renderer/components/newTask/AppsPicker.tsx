"use client";

import type { TaskApp } from "@core/types";
import Link from "next/link";
import { useEffect } from "react";
import { copy } from "@/copy";
import { defaultDocument } from "@/lib/documents";
import { appLabel } from "@/lib/format";
import { useOpenDocuments } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { AppLogo } from "../common/AppLogo";
import { Notice } from "../common/Notice";
import { Spinner } from "../common/Progress";
import { Section } from "../common/Section";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";

/** Value of the "No document" option (an explicit choice, unlike an empty value). */
const NONE = "__none__";

/** The open document an app's stages work on (or none, for stages that open their own files). */
function DocumentSelect({
  appId,
  documentId,
  noDocument,
  onChange,
}: {
  appId: string;
  documentId: string | undefined;
  noDocument: boolean;
  onChange: (id: string | undefined, noDocument: boolean) => void;
}) {
  const { data: docs, connected, app, loading } = useOpenDocuments(appId);
  const allowNone = appId !== "figma";

  // Pick the active document until the designer chooses; "No document" is a choice too and stays.
  useEffect(() => {
    if (!docs || (noDocument && allowNone)) return;
    if (documentId && docs.some((d) => d.id === documentId)) return;
    const fallback = defaultDocument(docs)?.id;
    if (fallback !== documentId) onChange(fallback, false);
  }, [docs, documentId, noDocument, allowNone, onChange]);

  if (app && !connected) {
    return (
      <span className="text-sm">
        {copy.newTask.appNotConnected(app.name)}{" "}
        <Link href="/connect" className="text-primary underline-offset-4 hover:underline">
          {copy.common.connectApps}
        </Link>
      </span>
    );
  }
  return (
    <NativeSelect
      className="w-full max-w-md"
      aria-label={copy.newTask.documentLabel}
      value={noDocument && allowNone ? NONE : (documentId ?? "")}
      disabled={loading && !docs}
      onChange={(e) => (e.target.value === NONE ? onChange(undefined, true) : onChange(e.target.value || undefined, false))}
    >
      {(!docs || docs.length === 0) && !allowNone && <NativeSelectOption value="">{loading ? copy.common.loading : copy.newTask.noFigmaFiles}</NativeSelectOption>}
      {docs?.map((d) => (
        <NativeSelectOption key={d.id} value={d.id}>
          {d.name} {d.active ? copy.newTask.activeDocument : ""}
        </NativeSelectOption>
      ))}
      {allowNone && <NativeSelectOption value={NONE}>{copy.newTask.noDocumentNeeded}</NativeSelectOption>}
    </NativeSelect>
  );
}

/** Every app the routine uses, each with the document to work on. */
export function AppsPicker({ value, onChange }: { value: TaskApp[]; onChange: (apps: TaskApp[]) => void }) {
  const apps = useShell((s) => s.apps);
  const toggle = (appId: string) =>
    onChange(value.some((a) => a.appId === appId) ? value.filter((a) => a.appId !== appId) : [...value, { appId }]);
  const setDoc = (appId: string, documentId: string | undefined, noDocument: boolean) =>
    onChange(value.map((a) => (a.appId === appId ? { ...a, documentId, noDocument: noDocument || undefined } : a)));
  const figmaWithoutFile = value.some((a) => a.appId === "figma" && !a.documentId) && apps.find((a) => a.id === "figma")?.status === "connected";

  return (
    <Section title={copy.newTask.appsLabel}>
      <p className="text-sm text-muted-foreground">{copy.newTask.appsHint}</p>
      {apps.length === 0 && <Spinner />}
      <ul className="flex flex-col">
        {apps.map((a) => {
          const picked = value.find((v) => v.appId === a.id);
          return (
            <li key={a.id} className="border-t flex flex-wrap items-center gap-3 py-3 first:border-t-0 first:pt-0 last:pb-0">
              <label className="flex items-center gap-2 data-[disabled=true]:text-muted-foreground">
                <Checkbox checked={!!picked} onCheckedChange={() => toggle(a.id)} />
                <AppLogo appId={a.id} />
                <span>
                  {appLabel(a.id)} <span className="text-sm text-muted-foreground">— {copy.appStatus[a.status]}</span>
                </span>
              </label>
              {picked && (
                <DocumentSelect
                  appId={a.id}
                  documentId={picked.documentId}
                  noDocument={!!picked.noDocument}
                  onChange={(id, none) => setDoc(a.id, id, none)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {apps.length > 0 && value.length === 0 && <p className="text-sm">{copy.newTask.pickOneApp}</p>}
      {figmaWithoutFile && <Notice>{copy.newTask.addFigmaFile}</Notice>}
    </Section>
  );
}

"use client";

import type { TaskApp } from "@core/types";
import Link from "next/link";
import { useEffect } from "react";
import { copy } from "@/copy";
import { defaultDocument } from "@/lib/documents";
import { appLabel } from "@/lib/format";
import { useOpenDocuments } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { Notice } from "../ui/Notice";

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
      <span className="ui-small">
        {copy.newTask.appNotConnected(app.name)}{" "}
        <Link href="/connect" className="ui-link">
          {copy.common.connectApps}
        </Link>
      </span>
    );
  }
  return (
    <select
      className="ui-select max-w-md"
      aria-label={copy.newTask.documentLabel}
      value={noDocument && allowNone ? NONE : (documentId ?? "")}
      disabled={loading && !docs}
      onChange={(e) => (e.target.value === NONE ? onChange(undefined, true) : onChange(e.target.value || undefined, false))}
    >
      {(!docs || docs.length === 0) && !allowNone && <option value="">{loading ? copy.common.loading : copy.newTask.noFigmaFiles}</option>}
      {docs?.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} {d.active ? copy.newTask.activeDocument : ""}
        </option>
      ))}
      {allowNone && <option value={NONE}>{copy.newTask.noDocumentNeeded}</option>}
    </select>
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
    <div className="flex flex-col gap-2">
      <div className="ui-label">{copy.newTask.appsLabel}</div>
      <p className="ui-small ui-muted">{copy.newTask.appsHint}</p>
      <ul className="ui-card flex flex-col">
        {apps.map((a) => {
          const picked = value.find((v) => v.appId === a.id);
          return (
            <li key={a.id} className="ui-divider flex flex-wrap items-center gap-3 px-3 py-2 first:border-t-0">
              <label className="ui-choice w-56">
                <input type="checkbox" checked={!!picked} onChange={() => toggle(a.id)} />
                <span>
                  {appLabel(a.id)} <span className="ui-small ui-muted">— {copy.appStatus[a.status]}</span>
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
      {value.length === 0 && <p className="ui-small">{copy.newTask.pickOneApp}</p>}
      {figmaWithoutFile && <Notice>{copy.newTask.addFigmaFile}</Notice>}
    </div>
  );
}

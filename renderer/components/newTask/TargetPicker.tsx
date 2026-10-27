"use client";

import Link from "next/link";
import { useEffect } from "react";
import { copy } from "@/copy";
import { defaultDocument } from "@/lib/documents";
import { appLabel } from "@/lib/format";
import { useOpenDocuments } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { Field } from "../ui/Field";
import { Notice } from "../ui/Notice";

/** App selector + open-document selector (documents come from the app's adapter). */
export function TargetPicker({
  appId,
  documentId,
  onAppChange,
  onDocumentChange,
}: {
  appId: string;
  documentId: string | undefined;
  onAppChange: (appId: string) => void;
  onDocumentChange: (docId: string | undefined) => void;
}) {
  const apps = useShell((s) => s.apps);
  const { data: docs, connected, app, loading } = useOpenDocuments(appId);

  // Default to the active document; keep the choice when it is still open.
  useEffect(() => {
    if (!docs) return;
    if (!documentId || !docs.some((d) => d.id === documentId)) {
      onDocumentChange(defaultDocument(docs)?.id);
    }
  }, [docs, documentId, onDocumentChange]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={copy.newTask.appLabel} htmlFor="app">
          <select id="app" className="ui-select" value={appId} onChange={(e) => onAppChange(e.target.value)}>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {appLabel(a.id)} — {copy.appStatus[a.status]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={copy.newTask.documentLabel} htmlFor="document">
          <select
            id="document"
            className="ui-select"
            value={documentId ?? ""}
            disabled={!connected || !docs?.length}
            onChange={(e) => onDocumentChange(e.target.value || undefined)}
          >
            {(!docs || docs.length === 0) && (
              <option value="">{loading && connected ? copy.common.loading : appId === "figma" ? copy.newTask.noFigmaFiles : copy.newTask.noDocuments}</option>
            )}
            {docs?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} {d.active ? copy.newTask.activeDocument : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {app && connected && appId === "figma" && docs?.length === 0 && (
        <Notice>
          <Link href="/connect" className="ui-link">
            {copy.newTask.addFigmaFile}
          </Link>
        </Notice>
      )}
      {app && !connected && (
        <Notice tone="warning">
          <span>
            {copy.newTask.appNotConnected(app.name)}{" "}
            <Link href="/connect" className="ui-link">
              {copy.common.connectApps}
            </Link>
          </span>
        </Notice>
      )}
    </div>
  );
}

"use client";

import type { App, DocumentRef, RunOptions } from "@core/types";
import { useEffect } from "react";
import { copy } from "@/copy";
import { defaultDocument } from "@/lib/documents";
import { Field } from "../ui/Field";

export function TargetOptions({
  app,
  docs,
  documentId,
  onDocumentChange,
  target,
  onTargetChange,
  modifiesDocument,
}: {
  app: App;
  docs: DocumentRef[];
  documentId: string | undefined;
  onDocumentChange: (id: string | undefined) => void;
  target: RunOptions["target"];
  onTargetChange: (t: RunOptions["target"]) => void;
  modifiesDocument: boolean;
}) {
  useEffect(() => {
    if (!documentId || !docs.some((d) => d.id === documentId)) onDocumentChange(defaultDocument(docs)?.id);
  }, [docs, documentId, onDocumentChange]);

  const doc = docs.find((d) => d.id === documentId);
  return (
    <div className="flex flex-col gap-4">
      <Field label={copy.run.documentLabel} htmlFor="run-document">
        <select
          id="run-document"
          className="ui-select max-w-md"
          value={documentId ?? ""}
          disabled={docs.length === 0}
          onChange={(e) => onDocumentChange(e.target.value || undefined)}
        >
          {docs.length === 0 && <option value="">{copy.newTask.noDocuments}</option>}
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} {d.active ? copy.newTask.activeDocument : ""}
            </option>
          ))}
        </select>
      </Field>
      {app.connection === "script-bridge" && (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={copy.run.targetTitle}>
          <label className="ui-choice">
            <input type="radio" name="target" checked={target === "copy"} onChange={() => onTargetChange("copy")} />
            <span className="flex flex-col">
              {copy.run.onCopy}
              <span className="ui-small ui-muted">{copy.run.onCopyHint(doc?.name)}</span>
            </span>
          </label>
          <label className="ui-choice">
            <input type="radio" name="target" checked={target === "original"} onChange={() => onTargetChange("original")} />
            <span className="flex flex-col">
              {copy.run.onOriginal}
              <span className="ui-small ui-muted">{copy.run.onOriginalHint}</span>
            </span>
          </label>
          {!modifiesDocument && <p className="ui-small ui-muted">{copy.run.readOnlyHint}</p>}
        </div>
      )}
    </div>
  );
}

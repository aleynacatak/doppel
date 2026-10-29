"use client";

import type { Creation } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";

const DATA_EXTENSIONS = ["csv", "tsv", "txt", "json", "xlsx"];

/** Creation is waiting for sample files: attach files or a folder, and it goes on (no new AI call). */
export function NeedsSamples({ creation, onChange }: { creation: Creation; onChange: (c: Creation) => void }) {
  const needs = creation.needs!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const types = new Set(needs.inputs.map((i) => i.type));
  const extensions = [
    ...new Set(needs.inputs.flatMap((i) => (i.type === "rows" ? DATA_EXTENSIONS : i.type === "file" || i.type === "fileList" ? (i.extensions ?? []) : []))),
  ];
  const canPickFiles = types.has("file") || types.has("fileList") || types.has("rows");
  const canPickFolder = types.has("fileList") || types.has("folder") || types.has("rows");
  const attach = async (pick: () => Promise<{ files: string[]; folders: string[] }>) => {
    setError(null);
    const added = await pick();
    if (!added.files.length && !added.folders.length) return;
    setBusy(true);
    try {
      onChange(await doppel().addSamples(creation.id, added));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice
      tone="warning"
      title={copy.create.needsSamplesTitle}
      actions={
        <>
          {canPickFiles && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                attach(async () => ({ files: await doppel().pickFiles({ extensions: extensions.length ? extensions : undefined, multiple: true }), folders: [] }))
              }
            >
              {copy.create.attachFiles}
            </Button>
          )}
          {canPickFolder && (
            <Button
              variant={canPickFiles ? "secondary" : "primary"}
              disabled={busy}
              onClick={() =>
                attach(async () => {
                  const folder = await doppel().pickFolder();
                  return { files: [], folders: folder ? [folder] : [] };
                })
              }
            >
              {copy.create.attachFolder}
            </Button>
          )}
        </>
      }
    >
      <p>{needs.message}</p>
      {extensions.length > 0 && <p className="ui-small ui-muted">{copy.create.needsTypes(extensions)}</p>}
      <p className="ui-small ui-muted">{copy.create.needsHint}</p>
      {error && <p className="ui-small">{error}</p>}
    </Notice>
  );
}

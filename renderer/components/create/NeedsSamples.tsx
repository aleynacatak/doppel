"use client";

import type { Creation } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Notice } from "../common/Notice";
import { Button } from "@/components/ui/button";

const DATA_EXTENSIONS = ["csv", "tsv", "txt", "json", "xlsx"];

/**
 * Creation is waiting for sample files: the designer adds files or folders from as many places as needed, sees what
 * each fills, removes mistakes, and goes on with them. Files the AI asked for before planning can also be left out.
 */
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
  const added = needs.added ?? [];
  const filled = new Set(added.flatMap((a) => a.fills.map((f) => f.key)));
  const ready = added.length > 0 && (needs.optional || needs.inputs.every((i) => filled.has(i.key)));
  const act = async (call: () => Promise<Creation>) => {
    setError(null);
    setBusy(true);
    try {
      onChange(await call());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice
      tone="warning"
      title={needs.optional ? copy.create.askFilesTitle : copy.create.needsSamplesTitle}
      actions={
        <>
          {(!needs.optional || added.length > 0) && (
            <Button disabled={busy || !ready} onClick={() => act(() => doppel().confirmSamples(creation.id))}>
              {copy.create.useSamples}
            </Button>
          )}
          {canPickFiles && (
            <Button
              variant="outline"
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
              variant="outline"
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
          {needs.optional && added.length === 0 && (
            <Button variant="outline" disabled={busy} onClick={() => act(() => doppel().confirmSamples(creation.id))}>
              {copy.create.goOnWithoutFiles}
            </Button>
          )}
        </>
      }
    >
      <p>{needs.message}</p>
      <ul className="text-sm flex flex-col gap-1.5">
        {needs.inputs.map((i) => (
          <li key={i.key}>
            {filled.has(i.key) ? "✓" : "–"} {i.label}
            {!filled.has(i.key) && <span className="text-muted-foreground"> · {copy.create.samplesMissing}</span>}
          </li>
        ))}
      </ul>
      {added.length > 0 && (
        <ul className="flex flex-col gap-3">
          {added.map((a) => (
            <li key={a.path} className="flex flex-wrap items-center gap-2">
              <span>{a.path.split("/").pop()}</span>
              <span className="text-sm text-muted-foreground">{a.fills.length ? a.fills.map((f) => copy.create.samplesFills(f.label, f.count)).join(" · ") : copy.create.samplesFillsNothing}</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => doppel().removeSample(creation.id, a.path))}>
                {copy.create.removeSample}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {extensions.length > 0 && <p className="text-sm text-muted-foreground">{copy.create.needsTypes(extensions)}</p>}
      <p className="text-sm text-muted-foreground">{copy.create.needsHint}</p>
      {error && <p className="text-sm">{error}</p>}
    </Notice>
  );
}

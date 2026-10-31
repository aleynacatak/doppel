"use client";

import type { TaskApp } from "@core/types";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppsPicker } from "@/components/newTask/AppsPicker";
import { ExamplePrompts } from "@/components/newTask/ExamplePrompts";
import { ReferencePicker } from "@/components/newTask/ReferencePicker";
import { RequestInput } from "@/components/newTask/RequestInput";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";

export default function NewTaskPage() {
  const router = useRouter();
  const apps = useShell((s) => s.apps);
  // A request Doppl declined comes back here to be changed, with its files and apps.
  const [draft] = useState(() => {
    const task = useShell.getState().draftTask;
    useShell.getState().setDraftTask(null);
    return task;
  });
  const [request, setRequest] = useState(draft?.request ?? "");
  const [references, setReferences] = useState<string[]>(draft?.references ?? []);
  const [folders, setFolders] = useState<string[]>(draft?.folders ?? []);
  const [picked, setPicked] = useState<TaskApp[]>(() => {
    if (draft) return draft.apps?.length ? draft.apps : [{ appId: draft.appId, documentId: draft.documentId }];
    const first = apps.find((a) => a.status === "connected") ?? apps[0];
    return first ? [{ appId: first.id }] : [];
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setStarting(true);
    setError(null);
    try {
      const [first] = picked;
      const creation = await doppel().createRoutine({
        request,
        references,
        folders,
        appId: first.appId,
        documentId: first.documentId,
        apps: picked,
      });
      router.push(`/create?task=${creation.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={copy.newTask.title} subtitle={copy.newTask.subtitle} />
      <RequestInput value={request} onChange={setRequest} />
      <ExamplePrompts
        onPick={(ex) => {
          setRequest(ex.text);
          if (apps.some((a) => a.id === ex.appId) && !picked.some((p) => p.appId === ex.appId)) setPicked([{ appId: ex.appId }]);
        }}
      />
      <ReferencePicker files={references} onChange={setReferences} folders={folders} onFoldersChange={setFolders} />
      <AppsPicker value={picked} onChange={setPicked} />
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button variant="primary" onClick={create} disabled={!request.trim() || picked.length === 0 || starting}>
          {starting ? copy.newTask.creating : picked.length > 1 ? copy.newTask.planFlow : copy.newTask.create}
        </Button>
      </div>
    </div>
  );
}

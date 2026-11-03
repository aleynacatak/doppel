"use client";

import type { App, TaskApp } from "@core/types";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppsPicker } from "@/components/newTask/AppsPicker";
import { ExamplePrompts } from "@/components/newTask/ExamplePrompts";
import { ReferencePicker } from "@/components/newTask/ReferencePicker";
import { RequestInput } from "@/components/newTask/RequestInput";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Section } from "@/components/common/Section";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";
import { Button } from "@/components/ui/button";

/** The app a new task starts with: a connected one, or else the first. */
function defaultApps(apps: App[]): TaskApp[] {
  const first = apps.find((a) => a.status === "connected") ?? apps[0];
  return first ? [{ appId: first.id }] : [];
}

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
    return defaultApps(apps);
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // At launch this page can open before the apps are known: choose when they arrive, once, so an app the designer unticks stays unticked.
  const chosen = useRef(picked.length > 0);
  useEffect(() => {
    if (chosen.current || apps.length === 0) return;
    chosen.current = true;
    setPicked(defaultApps(apps));
  }, [apps]);

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
    <div className="flex flex-col gap-8">
      <PageHeader
        title={copy.newTask.title}
        subtitle={copy.newTask.subtitle}
        actions={
          <Button onClick={create} disabled={!request.trim() || picked.length === 0 || starting}>
            {starting ? copy.newTask.creating : picked.length > 1 ? copy.newTask.planFlow : copy.newTask.create}
          </Button>
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title={copy.newTask.requestLabel}>
            <RequestInput value={request} onChange={setRequest} />
            <ExamplePrompts
              onPick={(ex) => {
                setRequest(ex.text);
                if (apps.some((a) => a.id === ex.appId) && !picked.some((p) => p.appId === ex.appId)) setPicked([{ appId: ex.appId }]);
              }}
            />
          </Section>
          <ReferencePicker files={references} onChange={setReferences} folders={folders} onFoldersChange={setFolders} />
        </div>
        <AppsPicker value={picked} onChange={setPicked} />
      </div>
    </div>
  );
}

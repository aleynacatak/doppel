"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ExamplePrompts } from "@/components/newTask/ExamplePrompts";
import { ReferencePicker } from "@/components/newTask/ReferencePicker";
import { RequestInput } from "@/components/newTask/RequestInput";
import { TargetPicker } from "@/components/newTask/TargetPicker";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";

export default function NewTaskPage() {
  const router = useRouter();
  const apps = useShell((s) => s.apps);
  const [request, setRequest] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [appId, setAppId] = useState<string>(() => apps.find((a) => a.status === "connected")?.id ?? apps[0]?.id ?? "indesign");
  const [documentId, setDocumentId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setStarting(true);
    setError(null);
    try {
      const creation = await doppel().createRoutine({ request, references, appId, documentId });
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
          if (apps.some((a) => a.id === ex.appId)) setAppId(ex.appId);
        }}
      />
      <ReferencePicker files={references} onChange={setReferences} />
      <TargetPicker appId={appId} documentId={documentId} onAppChange={setAppId} onDocumentChange={setDocumentId} />
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button variant="primary" onClick={create} disabled={!request.trim() || starting}>
          {starting ? copy.newTask.creating : copy.newTask.create}
        </Button>
      </div>
    </div>
  );
}

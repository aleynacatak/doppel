"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AiAccessSettings } from "@/components/settings/AiAccessSettings";
import { AiModelsSettings } from "@/components/settings/AiModelsSettings";
import { AppStatusChip } from "@/components/shell/AppStatusChip";
import { Field } from "@/components/common/Field";
import { PageHeader } from "@/components/common/PageHeader";
import { Section } from "@/components/common/Section";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export default function SettingsPage() {
  const { settings, setSettings, apps } = useShell();
  const [timeout, setTimeoutSec] = useState("");
  const [port, setPort] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setTimeoutSec(String(settings.scriptTimeoutSec));
    setPort(String(settings.figmaPort));
  }, [settings]);

  if (!settings) return null;

  const save = async () => {
    setSettings(await doppel().saveSettings({ scriptTimeoutSec: Number(timeout), figmaPort: Number(port) }));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex max-w-2xl flex-col gap-10">
      <PageHeader title={copy.settings.title} />

      <Section title={copy.settings.aiTitle}>
        <AiAccessSettings />
      </Section>

      <Section title={copy.settings.timeoutTitle}>
        <Field label={copy.settings.timeoutTitle} htmlFor="timeout" hint={copy.settings.timeoutHint}>
          <div className="flex items-center gap-2">
            <Input id="timeout" type="number" min={10} max={3600} className="max-w-32" value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} />
            <span className="text-muted-foreground">{copy.settings.seconds}</span>
          </div>
        </Field>
        <Field label={copy.settings.figmaPortTitle} htmlFor="figma-port" hint={copy.settings.figmaPortHint}>
          <Input id="figma-port" type="number" min={1024} max={65535} className="max-w-32" value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
        <div className="flex items-center gap-3">
          <Button onClick={save}>
            {copy.settings.saveButton}
          </Button>
          {saved && <span className="text-muted-foreground">{copy.common.saved}</span>}
        </div>
      </Section>

      <Section title={copy.settings.appsTitle}>
        <ul className="flex max-w-xs flex-col gap-1.5">
          {apps.map((a) => (
            <li key={a.id}>
              <AppStatusChip app={a} />
            </li>
          ))}
        </ul>
        <Link href="/connect" className="text-primary underline-offset-4 hover:underline">
          {copy.settings.appsLink}
        </Link>
      </Section>

      <Section title={copy.settings.advancedTitle}>
        <Collapsible>
          <CollapsibleTrigger className="text-primary underline-offset-4 hover:underline">{copy.aiModels.title}</CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-4 pt-4">
            <p className="text-sm text-muted-foreground">{copy.settings.advancedHint}</p>
            <AiModelsSettings />
          </CollapsibleContent>
        </Collapsible>
      </Section>
    </div>
  );
}

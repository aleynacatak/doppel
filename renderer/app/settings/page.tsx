"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AiAccessSettings } from "@/components/settings/AiAccessSettings";
import { AppStatusChip } from "@/components/shell/AppStatusChip";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";

export default function SettingsPage() {
  const { settings, setSettings, apps } = useShell();
  const [timeout, setTimeoutSec] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setTimeoutSec(String(settings.scriptTimeoutSec));
  }, [settings]);

  if (!settings) return null;

  const save = async () => {
    setSettings(await doppel().saveSettings({ scriptTimeoutSec: Number(timeout) }));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <PageHeader title={copy.settings.title} />

      <Section title={copy.settings.aiTitle}>
        <AiAccessSettings />
      </Section>

      <Section title={copy.settings.timeoutTitle}>
        <Field label={copy.settings.timeoutTitle} htmlFor="timeout" hint={copy.settings.timeoutHint}>
          <div className="flex items-center gap-2">
            <input id="timeout" type="number" min={10} max={3600} className="ui-input max-w-32" value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} />
            <span className="ui-muted">{copy.settings.seconds}</span>
          </div>
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save}>
            {copy.settings.saveButton}
          </Button>
          {saved && <span className="ui-muted">{copy.common.saved}</span>}
        </div>
      </Section>

      <Section title={copy.settings.appsTitle}>
        <ul className="flex max-w-xs flex-col gap-1">
          {apps.map((a) => (
            <li key={a.id}>
              <AppStatusChip app={a} />
            </li>
          ))}
        </ul>
        <Link href="/connect" className="ui-link">
          {copy.settings.appsLink}
        </Link>
      </Section>
    </div>
  );
}

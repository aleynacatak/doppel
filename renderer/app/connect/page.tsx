"use client";

import { useRouter } from "next/navigation";
import { AppConnectCard } from "@/components/connect/AppConnectCard";
import { PageHeader } from "@/components/common/PageHeader";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";
import { Button } from "@/components/ui/button";

export default function ConnectPage() {
  const { apps, settings, setSettings } = useShell();
  const router = useRouter();
  const anyConnected = apps.some((a) => a.status === "connected");
  const onboarded = settings?.onboarded;

  const finish = async () => {
    if (!onboarded) setSettings(await doppel().saveSettings({ onboarded: true }));
    router.push(onboarded ? "/settings" : "/");
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={copy.connect.title} subtitle={copy.connect.subtitle} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {apps.map((app) => (
          <AppConnectCard key={app.id} app={app} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={finish} disabled={!anyConnected && !onboarded}>
          {onboarded ? copy.connect.done : copy.connect.continue}
        </Button>
        {!anyConnected && !onboarded && <span className="text-muted-foreground">{copy.connect.continueHint}</span>}
      </div>
    </div>
  );
}

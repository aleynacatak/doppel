"use client";

import type { App } from "@core/types";
import { cn } from "cn";
import { copy } from "@/copy";
import { useOpenDocuments } from "@/lib/hooks";
import { AppLogo } from "../common/AppLogo";
import { Spinner } from "../common/Progress";
import { Tag } from "../common/Tag";
import { FigmaSetup } from "./FigmaSetup";
import { PermissionHelp } from "./PermissionHelp";
import { Card, CardContent } from "@/components/ui/card";

function ScriptBridgeBody({ app }: { app: App }) {
  const { data: docs } = useOpenDocuments(app.id);
  if (app.status === "connected") {
    return (
      <div className="flex flex-col gap-1.5">
        <div>{copy.connect.adobe.detected(app.name.replace(/^Adobe /, ""), app.version)}</div>
        <div className="text-muted-foreground">{copy.connect.adobe.documents(docs?.length ?? 0)}</div>
        {docs && docs.length > 0 && (
          <ul className="text-sm text-muted-foreground list-disc pl-5">
            {docs.map((d) => (
              <li key={d.id}>{d.name}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const short = app.name.replace(/^Adobe /, "");
  if (app.status === "permission-denied") return <PermissionHelp appName={app.name} />;
  if (app.status === "awaiting-permission") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center gap-2 font-semibold">
          <Spinner label={copy.connect.adobe.awaitingTitle} /> {copy.connect.adobe.awaitingTitle}
        </p>
        <p>{copy.connect.adobe.awaiting(short)}</p>
        <p className="text-sm text-muted-foreground">{copy.connect.adobe.awaitingStarting(short)}</p>
      </div>
    );
  }
  if (app.status === "not-installed") return <p className="text-muted-foreground">{copy.connect.adobe.notInstalled(short)}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground flex items-center gap-2">
        <Spinner label={copy.connect.adobe.notRunning(short)} /> {copy.connect.adobe.notRunning(short)}
      </p>
      <p className="text-sm text-muted-foreground">{copy.connect.adobe.promptHint(short)}</p>
    </div>
  );
}

export function AppConnectCard({ app }: { app: App }) {
  return (
    // Figma has the most to set up: it takes the whole row, with its two parts side by side.
    <Card data-selected={app.status === "connected"} className={cn("data-[selected=true]:ring-2 data-[selected=true]:ring-primary", app.connection === "links-and-plugin" && "@3xl:col-span-2")}>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <AppLogo appId={app.id} className="size-10" />
            <div className="min-w-0">
              <div className="text-base font-semibold">{app.name}</div>
              <div className="text-sm text-muted-foreground">
                {app.connection === "script-bridge" ? copy.connect.scriptBridge : copy.connect.linksAndPlugin} · {app.scriptLanguage}
              </div>
            </div>
          </div>
          <Tag tone={app.status === "connected" ? "filled" : "default"}>{copy.appStatus[app.status]}</Tag>
        </div>
        {app.connection === "script-bridge" ? <ScriptBridgeBody app={app} /> : <FigmaSetup />}
      </CardContent>
    </Card>
  );
}

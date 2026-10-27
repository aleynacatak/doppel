"use client";

import type { App } from "@core/types";
import { useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useOpenDocuments } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Progress";
import { Tag } from "../ui/Tag";
import { PermissionHelp } from "./PermissionHelp";

function ScriptBridgeBody({ app }: { app: App }) {
  const { data: docs } = useOpenDocuments(app.id);
  if (app.status === "connected") {
    return (
      <div className="flex flex-col gap-1">
        <div>{copy.connect.indesign.detected(app.version)}</div>
        <div className="ui-muted">{copy.connect.indesign.documents(docs?.length ?? 0)}</div>
        {docs && docs.length > 0 && (
          <ul className="ui-small ui-muted list-disc pl-5">
            {docs.map((d) => (
              <li key={d.id}>{d.name}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (app.status === "permission-denied") return <PermissionHelp />;
  if (app.status === "not-installed") return <p className="ui-muted">{copy.connect.indesign.notInstalled}</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className="ui-muted flex items-center gap-2">
        <Spinner label={copy.connect.indesign.notRunning} /> {copy.connect.indesign.notRunning}
      </p>
      <p className="ui-small ui-muted">{copy.connect.indesign.promptHint}</p>
    </div>
  );
}

function PluginBody({ app }: { app: App }) {
  const setApps = useShell((s) => s.setApps);
  const [checking, setChecking] = useState(false);
  if (app.status === "connected") return <p>{copy.connect.figma.connected}</p>;
  const check = async () => {
    setChecking(true);
    try {
      await doppel().checkApp(app.id);
      setApps(await doppel().listApps());
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-h3">{copy.connect.figma.installTitle}</div>
      <ol className="list-decimal pl-5">
        {copy.connect.figma.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div>
        <Button onClick={check} disabled={checking}>
          {checking && <Spinner />} {copy.connect.figma.checkAgain}
        </Button>
      </div>
    </div>
  );
}

export function AppConnectCard({ app }: { app: App }) {
  return (
    <div className="ui-card flex flex-col gap-3 p-4" data-selected={app.status === "connected"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="ui-h2">{app.name}</div>
          <div className="ui-small ui-muted">
            {app.connection === "script-bridge" ? copy.connect.scriptBridge : copy.connect.inAppPlugin} · {app.scriptLanguage}
          </div>
        </div>
        <Tag tone={app.status === "connected" ? "filled" : "default"}>{copy.appStatus[app.status]}</Tag>
      </div>
      {app.connection === "script-bridge" ? <ScriptBridgeBody app={app} /> : <PluginBody app={app} />}
    </div>
  );
}

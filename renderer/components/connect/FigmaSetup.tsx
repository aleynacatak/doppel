"use client";

import type { FigmaSetup as Setup } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { formatRelative } from "@/lib/format";
import { useShell } from "@/lib/store";
import { Spinner } from "../common/Progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Connect apps → Figma: the Doppl plugin (open files, pairing code), and optionally files by link. */
export function FigmaSetup() {
  const apps = useShell((s) => s.apps);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [token, setToken] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"token" | "link" | null>(null);
  const [error, setError] = useState<{ where: "token" | "link"; message: string } | null>(null);

  // Reload when the app status changes (the plugin connects or disconnects).
  const figmaApp = apps.find((a) => a.id === "figma");
  useEffect(() => {
    doppel().getFigmaSetup().then(setSetup);
  }, [figmaApp?.status, figmaApp?.detail]);

  if (!setup) return <Spinner />;

  const saveToken = async () => {
    setBusy("token");
    setError(null);
    const r = await doppel().saveFigmaToken(token);
    setBusy(null);
    if (r.ok) {
      setSetup(r.value);
      setToken("");
    } else setError({ where: "token", message: r.error.message });
  };
  const addLink = async () => {
    setBusy("link");
    setError(null);
    const r = await doppel().addFigmaLink(link);
    setBusy(null);
    if (r.ok) {
      setSetup(r.value);
      setLink("");
    } else setError({ where: "link", message: r.error.message });
  };

  const f = copy.connect.figma;
  const linked = new Set(setup.sessions.map((x) => x.documentId));
  return (
    <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-2">
      <section className="flex flex-col gap-3">
        <div className="text-sm font-medium">{f.pluginTitle}</div>
        <p className="text-sm">{f.pluginHelp}</p>
        <ol className="text-sm list-decimal pl-5">
          {f.pluginSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => doppel().showFigmaPlugin()}>
            {f.showPluginFiles}
          </Button>
          <span className="text-sm">
            {f.pairingCode}: <strong className="select-all">{setup.pairingCode}</strong>
          </span>
          <span className="text-sm text-muted-foreground">{f.port(setup.port)}</span>
        </div>
        <p className="text-sm text-muted-foreground">{f.pluginKeepOpen}</p>
        <div className="text-sm font-medium mt-1">{f.sessionsTitle}</div>
        {setup.sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{f.noSessions}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {setup.sessions.map((x) => (
              <li key={x.id} className="flex items-center gap-2">
                <span className="inline-block size-2 shrink-0 rounded-full border border-primary data-[on=true]:bg-primary" data-on aria-hidden />
                <span className="min-w-0 truncate">{f.session(x.fileName, x.pageName, x.pluginVersion)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="text-sm font-medium">{f.linksTitle}</div>
        <p className="text-sm text-muted-foreground">{f.linksHelp}</p>
        <div className="text-sm font-medium">{f.tokenTitle}</div>
        {setup.token.saved ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>{f.tokenSaved(setup.token.hint ?? "")}</span>
            <Button size="sm" variant="ghost" onClick={async () => setSetup(await doppel().clearFigmaToken())}>
              {f.removeToken}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{f.tokenHelp}</p>
            <div className="flex gap-2">
              <Input
                type="password"
                aria-label={f.tokenTitle}
                placeholder={f.tokenPlaceholder}
                value={token}
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && token.trim() && saveToken()}
              />
              <Button variant="outline" onClick={saveToken} disabled={!token.trim() || busy !== null}>
                {busy === "token" ? <Spinner /> : f.checkToken}
              </Button>
            </div>
          </>
        )}
        {error?.where === "token" && (
          <p className="text-sm" role="alert">
            {error.message}
          </p>
        )}

        <div className="text-sm font-medium mt-2">{f.filesTitle}</div>
        <p className="text-sm text-muted-foreground">{f.filesHelp}</p>
        {setup.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{f.noFiles}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {setup.files.map((file) => (
              <li key={file.key} className="flex flex-wrap items-center gap-2">
                <span className="inline-block size-2 shrink-0 rounded-full border border-primary data-[on=true]:bg-primary" data-on={linked.has(`figma:${file.key}`)} aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={file.url}>
                  {file.name}
                  {linked.has(`figma:${file.key}`) && <span className="text-sm text-muted-foreground"> · {f.pluginOpen}</span>}
                  {file.lastModified && <span className="text-sm text-muted-foreground"> · edited {formatRelative(file.lastModified)}</span>}
                </span>
                <Button size="sm" variant="ghost" onClick={() => doppel().openDocument("figma", `figma:${file.key}`)}>
                  {f.openInFigma}
                </Button>
                <Button size="sm" variant="ghost" onClick={async () => setSetup(await doppel().removeFigmaFile(file.key))}>
                  {f.removeFile}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Input
            aria-label={f.filesTitle}
            placeholder={f.linkPlaceholder}
            value={link}
            disabled={!setup.token.saved}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && link.trim() && addLink()}
          />
          <Button variant="outline" onClick={addLink} disabled={!setup.token.saved || !link.trim() || busy !== null}>
            {busy === "link" ? f.adding : f.addLink}
          </Button>
        </div>
        {error?.where === "link" && (
          <p className="text-sm" role="alert">
            {error.message}
          </p>
        )}
      </section>
    </div>
  );
}

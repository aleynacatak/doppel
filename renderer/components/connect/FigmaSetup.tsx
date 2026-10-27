"use client";

import type { FigmaSetup as Setup } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { formatRelative } from "@/lib/format";
import { useShell } from "@/lib/store";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Progress";

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
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="ui-h3">{f.pluginTitle}</div>
        <p className="ui-small">{f.pluginHelp}</p>
        <ol className="ui-small list-decimal pl-5">
          {f.pluginSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="small" onClick={() => doppel().showFigmaPlugin()}>
            {f.showPluginFiles}
          </Button>
          <span className="ui-small">
            {f.pairingCode}: <strong className="select-all">{setup.pairingCode}</strong>
          </span>
          <span className="ui-small ui-muted">{f.port(setup.port)}</span>
        </div>
        <p className="ui-small ui-muted">{f.pluginKeepOpen}</p>
        <div className="ui-label mt-1">{f.sessionsTitle}</div>
        {setup.sessions.length === 0 ? (
          <p className="ui-small ui-muted">{f.noSessions}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {setup.sessions.map((x) => (
              <li key={x.id} className="flex items-center gap-2">
                <span className="ui-dot" data-on aria-hidden />
                <span className="min-w-0 truncate">{f.session(x.fileName, x.pageName, x.pluginVersion)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="ui-h3">{f.linksTitle}</div>
        <p className="ui-small ui-muted">{f.linksHelp}</p>
        <div className="ui-label">{f.tokenTitle}</div>
        {setup.token.saved ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>{f.tokenSaved(setup.token.hint ?? "")}</span>
            <Button size="small" variant="ghost" onClick={async () => setSetup(await doppel().clearFigmaToken())}>
              {f.removeToken}
            </Button>
          </div>
        ) : (
          <>
            <p className="ui-small ui-muted">{f.tokenHelp}</p>
            <div className="flex gap-2">
              <input
                type="password"
                className="ui-input"
                aria-label={f.tokenTitle}
                placeholder={f.tokenPlaceholder}
                value={token}
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && token.trim() && saveToken()}
              />
              <Button onClick={saveToken} disabled={!token.trim() || busy !== null}>
                {busy === "token" ? <Spinner /> : f.checkToken}
              </Button>
            </div>
          </>
        )}
        {error?.where === "token" && (
          <p className="ui-small" role="alert">
            {error.message}
          </p>
        )}

        <div className="ui-label mt-2">{f.filesTitle}</div>
        <p className="ui-small ui-muted">{f.filesHelp}</p>
        {setup.files.length === 0 ? (
          <p className="ui-small ui-muted">{f.noFiles}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {setup.files.map((file) => (
              <li key={file.key} className="flex flex-wrap items-center gap-2">
                <span className="ui-dot" data-on={linked.has(`figma:${file.key}`)} aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={file.url}>
                  {file.name}
                  {linked.has(`figma:${file.key}`) && <span className="ui-small ui-muted"> · {f.pluginOpen}</span>}
                  {file.lastModified && <span className="ui-small ui-muted"> · edited {formatRelative(file.lastModified)}</span>}
                </span>
                <Button size="small" variant="ghost" onClick={() => doppel().openDocument("figma", `figma:${file.key}`)}>
                  {f.openInFigma}
                </Button>
                <Button size="small" variant="ghost" onClick={async () => setSetup(await doppel().removeFigmaFile(file.key))}>
                  {f.removeFile}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            className="ui-input"
            aria-label={f.filesTitle}
            placeholder={f.linkPlaceholder}
            value={link}
            disabled={!setup.token.saved}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && link.trim() && addLink()}
          />
          <Button onClick={addLink} disabled={!setup.token.saved || !link.trim() || busy !== null}>
            {busy === "link" ? f.adding : f.addLink}
          </Button>
        </div>
        {error?.where === "link" && (
          <p className="ui-small" role="alert">
            {error.message}
          </p>
        )}
      </section>
    </div>
  );
}

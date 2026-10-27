"use client";

import type { AiProvider } from "@core/types";
import { type ReactNode, useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { formatDateUtc } from "@/lib/format";
import { useShell } from "@/lib/store";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Notice } from "../ui/Notice";
import { Tag } from "../ui/Tag";

function Option({
  checked,
  disabled,
  label,
  hint,
  tag,
  onSelect,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  tag?: ReactNode;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="ui-card flex flex-col gap-3 p-3" data-selected={checked}>
      <label className="ui-choice" data-disabled={disabled}>
        <input type="radio" name="ai-provider" checked={checked} disabled={disabled} onChange={onSelect} />
        <span className="flex flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <span className="ui-h3">{label}</span>
            {tag}
          </span>
          <span className="ui-small ui-muted">{hint}</span>
        </span>
      </label>
      {checked && children && <div className="flex flex-col gap-3 pl-6">{children}</div>}
    </div>
  );
}

/** Settings → AI access: demo access code, own Meta API key, or (later) a local model. */
export function AiAccessSettings() {
  const { aiAccess, setAiAccess, setSettings } = useShell();
  const [code, setCode] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"code" | "key" | "refresh" | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyOk, setKeyOk] = useState(false);
  const [limit, setLimit] = useState("");

  useEffect(() => {
    if (aiAccess) setLimit(String(aiAccess.ownKeySpend.limit));
  }, [aiAccess]);

  // Show current quota when the page opens.
  useEffect(() => {
    doppel()
      .refreshDemoSession()
      .then((r) => (r.ok ? setAiAccess(r.value) : r.error.code !== "no_access" && setCodeError(r.error.message)));
  }, [setAiAccess]);

  if (!aiAccess) return null;
  const choose = async (provider: AiProvider) => setAiAccess(await doppel().setAiProvider(provider));

  const checkCode = async () => {
    setBusy("code");
    setCodeError(null);
    const r = await doppel().saveAccessCode(code);
    setBusy(null);
    if (r.ok) {
      setAiAccess(r.value);
      setCode("");
    } else setCodeError(r.error.message);
  };
  const refresh = async () => {
    setBusy("refresh");
    setCodeError(null);
    const r = await doppel().refreshDemoSession();
    setBusy(null);
    if (r.ok) setAiAccess(r.value);
    else setCodeError(r.error.message);
  };
  const checkKey = async () => {
    setBusy("key");
    setKeyError(null);
    setKeyOk(false);
    const r = await doppel().saveApiKey(key);
    setBusy(null);
    if (r.ok) {
      setAiAccess(r.value);
      setKey("");
      setKeyOk(true);
    } else setKeyError(r.error.message);
  };
  const saveLimit = async () => {
    setSettings(await doppel().saveSettings({ monthlySpendLimit: Number(limit) || 0 }));
    setAiAccess(await doppel().getAiAccess());
  };

  const s = aiAccess.session;
  return (
    <div className="flex flex-col gap-3">
      <p className="ui-muted">{copy.settings.aiSubtitle}</p>
      {!aiAccess.encryptionAvailable && <Notice tone="warning">{copy.settings.noEncryption}</Notice>}

      <div className="flex flex-col gap-2" role="radiogroup" aria-label={copy.settings.aiTitle}>
        <Option
          checked={aiAccess.provider === "doppl-demo"}
          label={copy.settings.options.demo.label}
          hint={copy.settings.options.demo.hint}
          onSelect={() => choose("doppl-demo")}
        >
          {aiAccess.accessCode.saved && (
            <div className="flex flex-wrap items-center gap-3">
              <span>{copy.settings.codeSaved(aiAccess.accessCode.hint ?? "")}</span>
              <Button size="small" onClick={refresh} disabled={busy !== null}>
                {busy === "refresh" ? copy.settings.checking : copy.settings.refresh}
              </Button>
              <Button size="small" variant="ghost" onClick={async () => setAiAccess(await doppel().clearAccessCode())}>
                {copy.settings.removeCode}
              </Button>
            </div>
          )}
          {s && (
            <p className="ui-small">
              {copy.settings.session({ label: s.label, creations: s.creations, samImages: s.samImages, expires: formatDateUtc(s.expiresAt) })}
            </p>
          )}
          {s && !s.demoEnabled && <p className="ui-small">{copy.settings.demoPaused}</p>}
          <div className="flex max-w-md gap-2">
            <input
              className="ui-input"
              aria-label={copy.settings.options.demo.label}
              placeholder={copy.settings.codePlaceholder}
              value={code}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && code.trim() && checkCode()}
            />
            <Button onClick={checkCode} disabled={!code.trim() || busy !== null}>
              {busy === "code" ? copy.settings.checking : copy.settings.checkCode}
            </Button>
          </div>
          {codeError && (
            <p className="ui-small" role="alert">
              {codeError}
            </p>
          )}
        </Option>

        <Option
          checked={aiAccess.provider === "meta-api"}
          label={copy.settings.options.ownKey.label}
          hint={copy.settings.options.ownKey.hint}
          onSelect={() => choose("meta-api")}
        >
          {aiAccess.ownKey.saved && (
            <div className="flex flex-wrap items-center gap-3">
              <span>{copy.settings.keySaved(aiAccess.ownKey.hint ?? "")}</span>
              <Button size="small" variant="ghost" onClick={async () => setAiAccess(await doppel().clearApiKey())}>
                {copy.settings.removeKey}
              </Button>
            </div>
          )}
          <div className="flex max-w-md gap-2">
            <input
              type="password"
              className="ui-input"
              aria-label={copy.settings.options.ownKey.label}
              placeholder={copy.settings.keyPlaceholder}
              value={key}
              autoComplete="off"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && checkKey()}
            />
            <Button onClick={checkKey} disabled={!key.trim() || busy !== null}>
              {busy === "key" ? copy.settings.checking : copy.settings.checkKey}
            </Button>
          </div>
          {keyOk && <p className="ui-small">{copy.settings.keyWorks}</p>}
          {keyError && (
            <p className="ui-small" role="alert">
              {keyError}
            </p>
          )}
          <Field label={copy.settings.spendTitle} htmlFor="spend" hint={copy.settings.spendHint}>
            <div className="flex items-center gap-2">
              <span className="ui-muted">$</span>
              <input id="spend" type="number" min={0} className="ui-input max-w-32" value={limit} onChange={(e) => setLimit(e.target.value)} onBlur={saveLimit} />
            </div>
          </Field>
          <p className="ui-small ui-muted">{copy.settings.spendSoFar(`$${aiAccess.ownKeySpend.estUsd.toFixed(2)}`)}</p>
        </Option>

        <Option
          checked={false}
          disabled
          label={copy.settings.options.local.label}
          hint={copy.settings.options.local.hint}
          tag={<Tag tone="quiet">{copy.common.comingSoon}</Tag>}
          onSelect={() => undefined}
        />
      </div>
      <p className="ui-small ui-muted">
        {copy.settings.modelLine(aiAccess.model)} · {copy.settings.secretsNote}
      </p>
    </div>
  );
}

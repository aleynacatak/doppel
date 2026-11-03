"use client";

import type { AiProvider } from "@core/types";
import { type ReactNode, useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { formatDateUtc } from "@/lib/format";
import { useShell } from "@/lib/store";
import { Field } from "../common/Field";
import { Notice } from "../common/Notice";
import { Tag } from "../common/Tag";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

function Option({
  checked,
  disabled,
  label,
  hint,
  tag,
  value,
  children,
}: {
  value: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  tag?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card data-selected={checked} size="sm" className="data-[selected=true]:ring-2 data-[selected=true]:ring-primary">
      <CardContent className="flex flex-col gap-4">
        <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground" data-disabled={disabled}>
          <RadioGroupItem className="mt-0.5" value={value} disabled={disabled} />
          <span className="flex flex-col">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{label}</span>
              {tag}
            </span>
            <span className="text-sm text-muted-foreground">{hint}</span>
          </span>
        </label>
        {/* Arrow keys in a text field here move its cursor, not the choice of option. */}
        {checked && children && (
          <div className="flex flex-col gap-4 pl-6" onKeyDown={(e) => e.stopPropagation()}>
            {children}
          </div>
        )}
      </CardContent>
    </Card>
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

  // Show the saved code and key and the current quota when the page opens.
  useEffect(() => {
    const api = doppel();
    api.getAiAccess().then(setAiAccess);
    api.refreshDemoSession().then((r) => (r.ok ? setAiAccess(r.value) : r.error.code !== "no_access" && setCodeError(r.error.message)));
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
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">{copy.settings.aiSubtitle}</p>
      {!aiAccess.encryptionAvailable && <Notice tone="warning">{copy.settings.noEncryption}</Notice>}

      <RadioGroup className="flex flex-col gap-3" aria-label={copy.settings.aiTitle} value={aiAccess.provider} onValueChange={(next) => choose(next as AiProvider)}>
        <Option
          checked={aiAccess.provider === "doppl-demo"}
          label={copy.settings.options.demo.label}
          hint={copy.settings.options.demo.hint}
          value="doppl-demo"
        >
          {aiAccess.accessCode.saved && (
            <div className="flex flex-wrap items-center gap-3">
              <span>{copy.settings.codeSaved(aiAccess.accessCode.hint ?? "")}</span>
              <Button variant="outline" size="sm" onClick={refresh} disabled={busy !== null}>
                {busy === "refresh" ? copy.settings.checking : copy.settings.refresh}
              </Button>
              <Button size="sm" variant="ghost" onClick={async () => setAiAccess(await doppel().clearAccessCode())}>
                {copy.settings.removeCode}
              </Button>
            </div>
          )}
          {s && (
            <p className="text-sm">
              {copy.settings.session({ label: s.label, creations: s.creations, samImages: s.samImages, expires: formatDateUtc(s.expiresAt) })}
            </p>
          )}
          {s && !s.demoEnabled && <p className="text-sm">{copy.settings.demoPaused}</p>}
          <div className="flex max-w-md gap-2">
            <Input
              aria-label={copy.settings.options.demo.label}
              placeholder={copy.settings.codePlaceholder}
              value={code}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && code.trim() && checkCode()}
            />
            <Button variant="outline" onClick={checkCode} disabled={!code.trim() || busy !== null}>
              {busy === "code" ? copy.settings.checking : copy.settings.checkCode}
            </Button>
          </div>
          {codeError && (
            <p className="text-sm" role="alert">
              {codeError}
            </p>
          )}
        </Option>

        <Option
          checked={aiAccess.provider === "meta-api"}
          label={copy.settings.options.ownKey.label}
          hint={copy.settings.options.ownKey.hint}
          value="meta-api"
        >
          {aiAccess.ownKey.saved && (
            <div className="flex flex-wrap items-center gap-3">
              <span>{copy.settings.keySaved(aiAccess.ownKey.hint ?? "")}</span>
              <Button size="sm" variant="ghost" onClick={async () => setAiAccess(await doppel().clearApiKey())}>
                {copy.settings.removeKey}
              </Button>
            </div>
          )}
          <div className="flex max-w-md gap-2">
            <Input
              type="password"
              aria-label={copy.settings.options.ownKey.label}
              placeholder={copy.settings.keyPlaceholder}
              value={key}
              autoComplete="off"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && checkKey()}
            />
            <Button variant="outline" onClick={checkKey} disabled={!key.trim() || busy !== null}>
              {busy === "key" ? copy.settings.checking : copy.settings.checkKey}
            </Button>
          </div>
          {keyOk && <p className="text-sm">{copy.settings.keyWorks}</p>}
          {keyError && (
            <p className="text-sm" role="alert">
              {keyError}
            </p>
          )}
          <Field label={copy.settings.spendTitle} htmlFor="spend" hint={copy.settings.spendHint}>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">$</span>
              <Input id="spend" type="number" min={0} className="max-w-32" value={limit} onChange={(e) => setLimit(e.target.value)} onBlur={saveLimit} />
            </div>
          </Field>
          <p className="text-sm text-muted-foreground">{copy.settings.spendSoFar(`$${aiAccess.ownKeySpend.estUsd.toFixed(2)}`)}</p>
        </Option>

        <Option
          checked={false}
          disabled
          label={copy.settings.options.local.label}
          hint={copy.settings.options.local.hint}
          tag={<Tag tone="quiet">{copy.common.comingSoon}</Tag>}
          value="local"
        />
      </RadioGroup>
      <p className="text-sm text-muted-foreground">
        {copy.settings.modelLine(aiAccess.model)} · {copy.settings.secretsNote}
      </p>
    </div>
  );
}

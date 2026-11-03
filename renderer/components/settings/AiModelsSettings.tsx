"use client";

import type { AiEndpointInput, AiModelsInfo, AiReasoningEffort, AiRole } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Field } from "../common/Field";
import { Notice } from "../common/Notice";
import { Tag } from "../common/Tag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";

const ROLES: AiRole[] = ["planner", "coder", "reviewer", "segmenter"];
const EMPTY_ENDPOINT: AiEndpointInput = { displayName: "", baseUrl: "", model: "", structuredOutput: true, vision: false, key: "" };

/** Settings → Advanced → AI models: which model serves each role, custom endpoints, spend per provider. */
export function AiModelsSettings() {
  const [info, setInfo] = useState<AiModelsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiEndpointInput | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});

  useEffect(() => {
    doppel()
      .getAiModels()
      .then(setInfo)
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (info) setLimits(Object.fromEntries(info.providerSpend.map((p) => [p.provider, String(p.limit)])));
  }, [info]);
  if (!info) return error ? <Notice tone="error">{error}</Notice> : null;

  const run = async (fn: () => Promise<AiModelsInfo>) => {
    setError(null);
    try {
      setInfo(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Models that can serve a role: never one that trains on data; segmentation only for the segmenter; vision to review.
  const fits = (role: AiRole) => info.models.filter((m) => !m.trainsOnData && (role === "segmenter") === m.segmentation && (role !== "reviewer" || m.vision));
  const modelName = (id: string) => info.models.find((m) => m.id === id)?.displayName ?? id;

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted-foreground">{copy.aiModels.intro}</p>
      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-col gap-4">
        <div className="text-sm font-medium">{copy.aiModels.rolesTitle}</div>
        {ROLES.map((role) => {
          const override = info.overrides[role];
          const current = override ?? info.defaults[role];
          const efforts = info.models.find((m) => m.id === current.model)?.reasoningEffort ?? [];
          return (
            <div key={role} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium w-24">{copy.aiModels.roles[role].label}</span>
                <NativeSelect
                  className="w-full max-w-72"
                  aria-label={copy.aiModels.roles[role].label}
                  value={override?.model ?? ""}
                  onChange={(e) => run(() => doppel().setAiRoleOverrides({ [role]: e.target.value ? { model: e.target.value } : null }))}
                >
                  <NativeSelectOption value="">{copy.aiModels.dopplPicks(modelName(info.defaults[role].model))}</NativeSelectOption>
                  {fits(role).map((m) => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      {m.displayName}
                      {m.experimental ? ` · ${copy.aiModels.experimental}` : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {override && efforts.length > 0 && (
                  <NativeSelect
                    className="w-full max-w-40"
                    aria-label={copy.aiModels.effortLabel}
                    value={override.reasoningEffort ?? ""}
                    onChange={(e) => run(() => doppel().setAiRoleOverrides({ [role]: { model: override.model, ...(e.target.value ? { reasoningEffort: e.target.value as AiReasoningEffort } : {}) } }))}
                  >
                    <NativeSelectOption value="">{copy.aiModels.effortDefault}</NativeSelectOption>
                    {efforts.map((e) => (
                      <NativeSelectOption key={e} value={e}>
                        {copy.aiModels.effort(e)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </div>
              <span className="text-sm text-muted-foreground">{copy.aiModels.roles[role].hint}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{copy.aiModels.endpointsTitle}</span>
          <Tag tone="quiet">{copy.aiModels.experimental}</Tag>
        </div>
        <p className="text-sm text-muted-foreground">{copy.aiModels.endpointsHint}</p>
        {info.customEndpoints.map((c) => (
          <div key={c.id} className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{c.displayName}</span>
              <span className="text-sm text-muted-foreground">
                {c.baseUrl} · {c.model}
              </span>
              {c.key.saved && <Tag tone="quiet">{copy.aiModels.keySaved(c.key.hint ?? "")}</Tag>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline"
                size="sm"
                onClick={async () => {
                  const res = await doppel().testAiEndpoint(c.id);
                  setTested((t) => ({ ...t, [c.id]: res.ok ? copy.aiModels.testOk(res.value) : res.error.message }));
                }}
              >
                {copy.aiModels.test}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDraft({ ...c, key: undefined })}>
                {copy.aiModels.edit}
              </Button>
              <Button variant="outline" size="sm" onClick={() => run(() => doppel().removeAiEndpoint(c.id))}>
                {copy.aiModels.remove}
              </Button>
              {tested[c.id] && <span className="text-sm">{tested[c.id]}</span>}
            </div>
          </div>
        ))}
        {draft ? (
          <div className="flex flex-col gap-4 border-t pt-4">
              <Field label={copy.aiModels.nameLabel} htmlFor="ep-name">
                <Input id="ep-name" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="OpenRouter" />
              </Field>
              <Field label={copy.aiModels.baseUrlLabel} htmlFor="ep-url" hint={copy.aiModels.baseUrlHint}>
                <Input id="ep-url" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://openrouter.ai/api/v1" />
              </Field>
              <Field label={copy.aiModels.modelLabel} htmlFor="ep-model">
                <Input id="ep-model" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </Field>
              <Field label={copy.aiModels.keyLabel} htmlFor="ep-key" hint={copy.aiModels.keyHint}>
                <Input id="ep-key" type="password" value={draft.key ?? ""} onChange={(e) => setDraft({ ...draft, key: e.target.value })} autoComplete="off" />
              </Field>
              <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
                <Checkbox className="mt-0.5" checked={draft.structuredOutput} onCheckedChange={(checked) => setDraft({ ...draft, structuredOutput: checked })} />
                <span>{copy.aiModels.structuredOutput}</span>
              </label>
              <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
                <Checkbox className="mt-0.5" checked={draft.vision} onCheckedChange={(checked) => setDraft({ ...draft, vision: checked })} />
                <span>{copy.aiModels.vision}</span>
              </label>
              <div className="flex gap-2">
                <Button
                  onClick={async () => {
                    const input = { ...draft, ...(draft.key === undefined || (draft.id && draft.key === "") ? { key: undefined } : {}) };
                    await run(() => doppel().saveAiEndpoint(input));
                    setDraft(null);
                  }}
                >
                  {copy.aiModels.save}
                </Button>
                <Button variant="outline" onClick={() => setDraft(null)}>{copy.common.cancel}</Button>
              </div>
          </div>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setDraft({ ...EMPTY_ENDPOINT })}>{copy.aiModels.add}</Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">{copy.aiModels.spendTitle}</div>
        <Table>
          <TableBody>
            {info.providerSpend.map((p) => (
              <TableRow key={p.provider}>
                <TableCell className="py-3 pr-4">{p.displayName}</TableCell>
                <TableCell className="text-muted-foreground py-3 pr-4">{copy.aiModels.spent(`$${p.estUsd.toFixed(2)}`)}</TableCell>
                <TableCell className="py-3">
                  <span className="flex items-center gap-2">
                    <Input
                      className="max-w-24"
                      type="number"
                      min={0}
                      aria-label={copy.aiModels.limitLabel(p.displayName)}
                      value={limits[p.provider] ?? ""}
                      onChange={(e) => setLimits((l) => ({ ...l, [p.provider]: e.target.value }))}
                      onBlur={() => run(() => doppel().setAiProviderLimit(p.provider, Number(limits[p.provider]) || 0))}
                    />
                    <span className="text-sm text-muted-foreground">{copy.aiModels.limitHint}</span>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

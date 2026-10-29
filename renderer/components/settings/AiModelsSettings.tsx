"use client";

import type { AiEndpointInput, AiModelsInfo, AiReasoningEffort, AiRole } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Notice } from "../ui/Notice";
import { Tag } from "../ui/Tag";

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
    <div className="flex flex-col gap-6">
      <p className="ui-small ui-muted">{copy.aiModels.intro}</p>
      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-col gap-3">
        <div className="ui-label">{copy.aiModels.rolesTitle}</div>
        {ROLES.map((role) => {
          const override = info.overrides[role];
          const current = override ?? info.defaults[role];
          const efforts = info.models.find((m) => m.id === current.model)?.reasoningEffort ?? [];
          return (
            <div key={role} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-h3 w-24">{copy.aiModels.roles[role].label}</span>
                <select
                  className="ui-input max-w-72"
                  aria-label={copy.aiModels.roles[role].label}
                  value={override?.model ?? ""}
                  onChange={(e) => run(() => doppel().setAiRoleOverrides({ [role]: e.target.value ? { model: e.target.value } : null }))}
                >
                  <option value="">{copy.aiModels.dopplPicks(modelName(info.defaults[role].model))}</option>
                  {fits(role).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                      {m.experimental ? ` · ${copy.aiModels.experimental}` : ""}
                    </option>
                  ))}
                </select>
                {override && efforts.length > 0 && (
                  <select
                    className="ui-input max-w-40"
                    aria-label={copy.aiModels.effortLabel}
                    value={override.reasoningEffort ?? ""}
                    onChange={(e) => run(() => doppel().setAiRoleOverrides({ [role]: { model: override.model, ...(e.target.value ? { reasoningEffort: e.target.value as AiReasoningEffort } : {}) } }))}
                  >
                    <option value="">{copy.aiModels.effortDefault}</option>
                    {efforts.map((e) => (
                      <option key={e} value={e}>
                        {copy.aiModels.effort(e)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <span className="ui-small ui-muted">{copy.aiModels.roles[role].hint}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="ui-label">{copy.aiModels.endpointsTitle}</span>
          <Tag tone="quiet">{copy.aiModels.experimental}</Tag>
        </div>
        <p className="ui-small ui-muted">{copy.aiModels.endpointsHint}</p>
        {info.customEndpoints.map((c) => (
          <div key={c.id} className="ui-card flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="ui-h3">{c.displayName}</span>
              <span className="ui-small ui-muted">
                {c.baseUrl} · {c.model}
              </span>
              {c.key.saved && <Tag tone="quiet">{copy.aiModels.keySaved(c.key.hint ?? "")}</Tag>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="small"
                onClick={async () => {
                  const res = await doppel().testAiEndpoint(c.id);
                  setTested((t) => ({ ...t, [c.id]: res.ok ? copy.aiModels.testOk(res.value) : res.error.message }));
                }}
              >
                {copy.aiModels.test}
              </Button>
              <Button size="small" onClick={() => setDraft({ ...c, key: undefined })}>
                {copy.aiModels.edit}
              </Button>
              <Button size="small" onClick={() => run(() => doppel().removeAiEndpoint(c.id))}>
                {copy.aiModels.remove}
              </Button>
              {tested[c.id] && <span className="ui-small">{tested[c.id]}</span>}
            </div>
          </div>
        ))}
        {draft ? (
          <div className="ui-card flex flex-col gap-3 p-3">
            <Field label={copy.aiModels.nameLabel} htmlFor="ep-name">
              <input id="ep-name" className="ui-input" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="OpenRouter" />
            </Field>
            <Field label={copy.aiModels.baseUrlLabel} htmlFor="ep-url" hint={copy.aiModels.baseUrlHint}>
              <input id="ep-url" className="ui-input" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://openrouter.ai/api/v1" />
            </Field>
            <Field label={copy.aiModels.modelLabel} htmlFor="ep-model">
              <input id="ep-model" className="ui-input" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            </Field>
            <Field label={copy.aiModels.keyLabel} htmlFor="ep-key" hint={copy.aiModels.keyHint}>
              <input id="ep-key" type="password" className="ui-input" value={draft.key ?? ""} onChange={(e) => setDraft({ ...draft, key: e.target.value })} autoComplete="off" />
            </Field>
            <label className="ui-choice">
              <input type="checkbox" checked={draft.structuredOutput} onChange={(e) => setDraft({ ...draft, structuredOutput: e.target.checked })} />
              <span>{copy.aiModels.structuredOutput}</span>
            </label>
            <label className="ui-choice">
              <input type="checkbox" checked={draft.vision} onChange={(e) => setDraft({ ...draft, vision: e.target.checked })} />
              <span>{copy.aiModels.vision}</span>
            </label>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={async () => {
                  const input = { ...draft, ...(draft.key === undefined || (draft.id && draft.key === "") ? { key: undefined } : {}) };
                  await run(() => doppel().saveAiEndpoint(input));
                  setDraft(null);
                }}
              >
                {copy.aiModels.save}
              </Button>
              <Button onClick={() => setDraft(null)}>{copy.common.cancel}</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button onClick={() => setDraft({ ...EMPTY_ENDPOINT })}>{copy.aiModels.add}</Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="ui-label">{copy.aiModels.spendTitle}</div>
        <table className="ui-table">
          <tbody>
            {info.providerSpend.map((p) => (
              <tr key={p.provider}>
                <td className="py-2 pr-4">{p.displayName}</td>
                <td className="ui-muted py-2 pr-4">{copy.aiModels.spent(`$${p.estUsd.toFixed(2)}`)}</td>
                <td className="py-2">
                  <span className="flex items-center gap-2">
                    <input
                      className="ui-input max-w-24"
                      type="number"
                      min={0}
                      aria-label={copy.aiModels.limitLabel(p.displayName)}
                      value={limits[p.provider] ?? ""}
                      onChange={(e) => setLimits((l) => ({ ...l, [p.provider]: e.target.value }))}
                      onBlur={() => run(() => doppel().setAiProviderLimit(p.provider, Number(limits[p.provider]) || 0))}
                    />
                    <span className="ui-small ui-muted">{copy.aiModels.limitHint}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

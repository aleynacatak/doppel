"use client";

import type { AppId, ParamValue, ParamValues, QcMode, QcOptions, Routine, RunOptions } from "@core/types";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { useAiReviewAvailable, useShell } from "@/lib/store";
import { AiCallCounter } from "../ui/AiCallCounter";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";
import { Spinner } from "../ui/Progress";
import { Section } from "../ui/Section";
import { Tag } from "../ui/Tag";
import { ParamForm, initialValues } from "./ParamForm";
import { QcModePicker } from "./QcModePicker";

const DEFAULT_QC: QcOptions = { minPpiPrint: 300, minPpiWeb: 150 };

/** Run screen for multi-app routines: every app connected with its document, then the stages in order. */
export function StagedRunForm({ routine }: { routine: Routine }) {
  const router = useRouter();
  const aiReviewAvailable = useAiReviewAvailable();
  const apps = useShell((s) => s.apps);
  const [values, setValues] = useState<ParamValues>(() => initialValues(routine.params, routine.lastParams));
  const [qcMode, setQcMode] = useState<QcMode>("auto");
  const [qcOptions, setQcOptions] = useState<QcOptions>(DEFAULT_QC);
  const [target, setTarget] = useState<RunOptions["target"]>("copy");
  const [documents, setDocuments] = useState<Partial<Record<AppId, string>>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Readiness follows the apps: re-check when one connects, disconnects or opens another file.
  const appsKey = apps.map((a) => `${a.id}:${a.status}:${a.detail ?? ""}`).join("|");
  const { data: readiness, loading } = useAsync(() => doppel().checkReadiness(routine.id, documents), [routine.id, appsKey, JSON.stringify(documents)]);
  useEffect(() => {
    if (qcMode === "auto_ai" && !aiReviewAvailable) setQcMode("auto");
  }, [qcMode, aiReviewAvailable]);
  const setValue = useCallback((key: string, value: ParamValue) => setValues((v) => ({ ...v, [key]: value })), []);

  const stageApps = useMemo(() => new Set((routine.stages ?? []).map((s) => s.appId)), [routine.stages]);
  const canChooseTarget = stageApps.has("figma") || stageApps.has("indesign");
  const blocked = !readiness || readiness.some((r) => !r.ok);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const picked = Object.fromEntries((readiness ?? []).filter((r) => r.documentId).map((r) => [r.appId, r.documentId!]));
      const run = await doppel().runRoutine(routine.id, values, qcMode, { target, documents: { ...picked, ...documents }, qcOptions });
      router.replace(`/run?routine=${routine.id}&run=${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Section title={copy.run.readinessTitle}>
        {!readiness && loading ? (
          <Spinner />
        ) : (
          <ul className="flex flex-col gap-3">
            {readiness?.map((r) => (
              <li key={r.appId} className="ui-card flex flex-col gap-2 p-3" data-selected={r.ok}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Tag tone="strong">{appLabel(r.appId)}</Tag>
                    <span className="ui-small ui-muted">{copy.run.readinessStages(r.stages)}</span>
                  </div>
                  <Tag tone={r.ok ? "filled" : "default"}>{r.ok ? copy.run.readinessOk : copy.appStatus[r.status]}</Tag>
                </div>
                {r.needsDocument ? (
                  r.documents.length > 0 && (
                    <select
                      className="ui-select max-w-md"
                      aria-label={`${appLabel(r.appId)} ${copy.run.documentLabel}`}
                      value={r.documentId ?? ""}
                      onChange={(e) => setDocuments((d) => ({ ...d, [r.appId]: e.target.value }))}
                    >
                      {r.documents.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} {d.active ? copy.newTask.activeDocument : ""}
                        </option>
                      ))}
                    </select>
                  )
                ) : (
                  <span className="ui-small ui-muted">{copy.run.noDocumentNeeded}</span>
                )}
                {!r.ok && r.message && <p className="ui-small">{r.message}</p>}
                {r.appId === "photoshop" && <p className="ui-small ui-muted">{copy.run.photoshopSafety}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={copy.run.inputsTitle}>
        <ParamForm
          routineId={routine.id}
          documentId={readiness?.find((r) => r.appId === routine.appId)?.documentId}
          params={routine.params}
          values={values}
          onChange={setValue}
        />
      </Section>

      {canChooseTarget && (
        <Section title={copy.run.targetTitle}>
          <div className="flex flex-col gap-2">
            <label className="ui-choice">
              <input type="radio" name="target" checked={target === "copy"} onChange={() => setTarget("copy")} />
              <span>
                {stageApps.has("figma") ? copy.run.figmaOnCopy : copy.run.onCopy}
                <span className="ui-small ui-muted block">{stageApps.has("figma") ? copy.run.figmaOnCopyHint() : copy.run.onCopyHint()}</span>
              </span>
            </label>
            <label className="ui-choice">
              <input type="radio" name="target" checked={target === "original"} onChange={() => setTarget("original")} />
              <span>
                {stageApps.has("figma") ? copy.run.figmaOnOriginal : copy.run.onOriginal}
                <span className="ui-small ui-muted block">{stageApps.has("figma") ? copy.run.figmaOnOriginalHint : copy.run.onOriginalHint}</span>
              </span>
            </label>
          </div>
        </Section>
      )}

      <Section title={copy.run.qcTitle}>
        <QcModePicker mode={qcMode} onModeChange={setQcMode} options={qcOptions} onOptionsChange={setQcOptions} showResolution={false} aiReviewAvailable={aiReviewAvailable} />
      </Section>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-wrap items-center gap-4">
        <Button variant="primary" onClick={start} disabled={blocked || starting}>
          {starting ? copy.run.starting : copy.run.runButton}
        </Button>
        <div className="w-72">
          <AiCallCounter count={0} label={copy.run.aiCounterLabel} hint={qcMode === "auto_ai" ? copy.run.aiCounterReview : copy.run.aiCounterZero} />
        </div>
      </div>
    </div>
  );
}

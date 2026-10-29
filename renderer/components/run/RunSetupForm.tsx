"use client";

import type { AppId, FlowNode, InputValue, MatchRule, ParamValue, QcMode, QcOptions, RunOptions, RunSetup } from "@core/types";
import { isListType } from "@shared/ports";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel, fileName } from "@/lib/format";
import { useAsync, useLiveReload } from "@/lib/hooks";
import { useAiReviewAvailable, useShell } from "@/lib/store";
import { MatchRuleEditor } from "../flow/MatchRuleEditor";
import { PreflightReport } from "./PreflightReport";
import { AiCallCounter } from "../ui/AiCallCounter";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Notice";
import { Spinner } from "../ui/Progress";
import { Section } from "../ui/Section";
import { Tag } from "../ui/Tag";
import { EnvironmentWarning } from "./EnvironmentWarning";
import { InputValueField } from "./InputValueField";
import { ParamField } from "./ParamField";
import { QcModePicker } from "./QcModePicker";

const DEFAULT_QC: QcOptions = { minPpiPrint: 300, minPpiWeb: 150 };
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

type Input = Extract<FlowNode, { kind: "input" }>;
type Output = Extract<FlowNode, { kind: "output" }>;

/**
 * What a run asks for, for a routine or a flow: every app connected with its document, a value for each input,
 * (routines) settings and how lists pair, a folder for each result, and quality checks. Runs use no AI.
 * Files, folders and values start empty each time; settings and pairing rules keep what was used last.
 * `keepPicks`: the flow editor just handed over the inputs picked on its canvas.
 */
export function RunSetupForm({ setup, keepPicks = false }: { setup: RunSetup; keepPicks?: boolean }) {
  const router = useRouter();
  const aiReviewAvailable = useAiReviewAvailable();
  const apps = useShell((s) => s.apps);
  const { flow, target } = setup;
  const routine = target.kind === "routine" ? setup.routines.routine : undefined;
  const inputNodes = flow.nodes.filter((n): n is Input => n.kind === "input");
  const outputNodes = flow.nodes.filter((n): n is Output => n.kind === "output" && flow.edges.some((e) => e.to.nodeId === n.id));
  const [inputs, setInputs] = useState<Record<string, InputValue>>(() => (keepPicks ? setup.last.inputs : {}));
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, ParamValue>>(() =>
    Object.fromEntries(setup.settings.map((s) => [s.key, (setup.last.settings[s.key] ?? s.default ?? (s.type === "formatList" ? [] : s.type === "boolean" ? false : null)) as ParamValue])),
  );
  const [matches, setMatches] = useState<Record<string, MatchRule>>(() => ({ ...(routine?.matches ?? {}), ...setup.last.matches }));
  const [columns, setColumns] = useState<Record<string, Record<string, string>>>(() => setup.last.columns ?? {});
  const [documents, setDocuments] = useState<Partial<Record<AppId, string>>>({});
  const [qcMode, setQcMode] = useState<QcMode>("auto");
  const [qcOptions, setQcOptions] = useState<QcOptions>(DEFAULT_QC);
  const [target2, setTarget2] = useState<RunOptions["target"]>("copy");
  const [envAccepted, setEnvAccepted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appsKey = apps.map((a) => `${a.id}:${a.status}:${a.detail ?? ""}`).join("|");
  const { data: readiness, loading, reload } = useAsync(() => doppel().checkReadiness(target, documents), [target.id, appsKey, JSON.stringify(documents)]);
  useLiveReload(reload, true);
  const { data: env } = useAsync(() => (routine ? doppel().checkEnvironment(routine.id) : Promise.resolve(null)), [routine?.id, appsKey]);
  const envProblem = !!env && (env.versionMismatch || env.missingFonts.length > 0);
  useEffect(() => {
    if (qcMode === "auto_ai" && !aiReviewAvailable) setQcMode("auto");
  }, [qcMode, aiReviewAvailable]);
  const setSetting = useCallback((key: string, value: ParamValue) => setSettings((v) => ({ ...v, [key]: value })), []);

  // The check before the run, whenever the picks change (no AI).
  const picked = inputNodes.some((n) => !isEmpty(inputs[n.id]));
  const { data: preflight, loading: checking } = useAsync(
    () => (picked ? doppel().preflightRun(target, { inputs, matches, columns }) : Promise.resolve(null)),
    [target.id, JSON.stringify(inputs), JSON.stringify(matches), JSON.stringify(columns)],
  );
  const unusable = (preflight?.needs ?? []).filter((i) => i.kind !== "partner");

  const appIds = useMemo(() => new Set(Object.values(setup.routines).map((r) => r.appId)), [setup.routines]);
  const canChooseTarget = [...appIds].some((a) => a === "figma" || a === "indesign") && Object.values(setup.routines).some((r) => r.inputs.some((p) => p.type === "document"));
  const joins = routine?.iterate
    ? flow.edges.filter((e) => {
        const port = routine.inputs.find((p) => p.key === e.to.port);
        return e.to.nodeId === "routine" && port && port.key !== routine.iterate!.input && isListType(port.type);
      })
    : [];
  const missing = [
    ...inputNodes.filter((n) => n.port.required && isEmpty(inputs[n.id])).map((n) => n.port.label),
    ...(target.kind === "flow" ? outputNodes.filter((n) => !folders[n.id]).map((n) => n.port.label) : []),
  ];
  const blocked = setup.issues.length > 0 || !readiness || readiness.some((r) => !r.ok) || missing.length > 0 || unusable.length > 0 || (envProblem && !envAccepted);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const picked = Object.fromEntries((readiness ?? []).filter((r) => r.documentId).map((r) => [r.appId, r.documentId!]));
      const run = await doppel().startRun(target, {
        inputs,
        outputFolders: folders,
        ...(routine ? { settings } : {}),
        matches,
        columns,
        qcMode,
        options: { target: target2, documents: { ...picked, ...documents }, qcOptions },
      });
      router.replace(`/run?${target.kind}=${target.id}&run=${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {setup.issues.length > 0 && (
        <Notice tone="error" title={copy.run.blockedBy}>
          <ul className="ui-small flex flex-col gap-0.5">
            {setup.issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      {envProblem && !envAccepted && env && routine && (
        <EnvironmentWarning
          env={env}
          appName={appLabel(routine.appId)}
          onRunAnyway={() => setEnvAccepted(true)}
          onRepair={async () => router.push(`/create?task=${(await doppel().repairRoutine(routine.id)).id}`)}
        />
      )}

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
                    <span className="ui-small ui-muted">{copy.run.readinessStages(r.uses)}</span>
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

      {inputNodes.length > 0 && (
        <Section title={copy.run.inputsTitle}>
          <div className="flex flex-col gap-4">
            {inputNodes.map((n) => (
              <InputValueField key={n.id} id={`in-${n.id}`} port={n.port} value={inputs[n.id]} onChange={(v) => setInputs((x) => ({ ...x, [n.id]: v }))} />
            ))}
          </div>
        </Section>
      )}

      {joins.length > 0 && routine && (
        <Section title={copy.run.joinsTitle}>
          {joins.map((e) => {
            const iterPort = routine.inputs.find((p) => p.key === routine.iterate!.input)!;
            const port = routine.inputs.find((p) => p.key === e.to.port)!;
            return (
              <div key={e.id} className="flex flex-col gap-2">
                <p className="ui-small ui-muted">{copy.flow.joinHint(routine.name, iterPort.label)}</p>
                <MatchRuleEditor
                  flow={{ ...flow, edges: flow.edges.map((x) => (x.id === e.id ? { ...x, match: matches[port.key] ?? x.match } : x)) }}
                  edgeId={e.id}
                  rule={matches[port.key] ?? e.match}
                  onChange={(rule) => setMatches((m) => ({ ...m, [port.key]: rule }))}
                  iterPort={iterPort}
                  joinedPort={port}
                  inputs={inputs}
                />
              </div>
            );
          })}
        </Section>
      )}

      {picked && (
        <Section title={copy.run.preflightTitle}>
          <PreflightReport
            report={preflight ?? null}
            loading={checking}
            canPickPartners
            onPickPartner={(issue, file) =>
              setMatches((m) => {
                // Routine runs pair per input; flow runs per connection.
                const edge = flow.edges.find((e) => e.to.nodeId === issue.nodeId && e.to.port === issue.port);
                const key = routine ? issue.port : edge?.id;
                const rule = key ? (m[key] ?? (routine ? routine.matches?.[issue.port] : undefined) ?? edge?.match) : undefined;
                return key && rule ? { ...m, [key]: { ...rule, pairs: { ...(rule.pairs ?? {}), [issue.key]: file } } } : m;
              })
            }
            onPickColumn={(issue, column) => setColumns((c) => ({ ...c, [issue.inputNodeId]: { ...(c[issue.inputNodeId] ?? {}), [issue.column]: column } }))}
          />
        </Section>
      )}

      {setup.settings.length > 0 && routine && (
        <Section title={copy.run.settingsTitle}>
          <div className="flex flex-col gap-4">
            {setup.settings.map((s) => (
              <ParamField key={s.key} routineId={routine.id} documentId={readiness?.find((r) => r.appId === routine.appId)?.documentId} param={s} value={settings[s.key]} onChange={(v) => setSetting(s.key, v)} />
            ))}
          </div>
        </Section>
      )}

      {outputNodes.length > 0 && (
        <Section title={copy.run.outputsTitle}>
          <p className="ui-small ui-muted">{target.kind === "flow" ? copy.run.outputsHintFlow : copy.run.outputsHint}</p>
          <div className="flex flex-col gap-3">
            {outputNodes.map((n) => (
              <div key={n.id} className="flex flex-wrap items-center gap-3">
                <span className="w-48">{n.port.label}</span>
                <Button
                  onClick={async () => {
                    const folder = await doppel().pickFolder();
                    if (folder) setFolders((f) => ({ ...f, [n.id]: folder }));
                  }}
                >
                  {folders[n.id] ? copy.run.change : copy.run.choose}
                </Button>
                <span className={folders[n.id] ? "truncate" : "ui-muted"} title={folders[n.id]}>
                  {folders[n.id] ? fileName(folders[n.id]) : copy.run.notChosen}
                </span>
                {folders[n.id] && target.kind === "routine" && (
                  <button type="button" className="ui-small ui-link" onClick={() => setFolders((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== n.id)))}>
                    {copy.run.clear}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {canChooseTarget && (
        <Section title={copy.run.targetTitle}>
          <div className="flex flex-col gap-2">
            <label className="ui-choice">
              <input type="radio" name="target" checked={target2 === "copy"} onChange={() => setTarget2("copy")} />
              <span>
                {appIds.has("figma") ? copy.run.figmaOnCopy : copy.run.onCopy}
                <span className="ui-small ui-muted block">{appIds.has("figma") ? copy.run.figmaOnCopyHint() : copy.run.onCopyHint()}</span>
              </span>
            </label>
            <label className="ui-choice">
              <input type="radio" name="target" checked={target2 === "original"} onChange={() => setTarget2("original")} />
              <span>
                {appIds.has("figma") ? copy.run.figmaOnOriginal : copy.run.onOriginal}
                <span className="ui-small ui-muted block">{appIds.has("figma") ? copy.run.figmaOnOriginalHint : copy.run.onOriginalHint}</span>
              </span>
            </label>
          </div>
        </Section>
      )}

      <Section title={copy.run.qcTitle}>
        <QcModePicker
          mode={qcMode}
          onModeChange={setQcMode}
          options={qcOptions}
          onOptionsChange={setQcOptions}
          showResolution={appIds.has("indesign")}
          aiReviewAvailable={aiReviewAvailable}
        />
      </Section>

      {error && <Notice tone="error">{error}</Notice>}
      {missing.length > 0 && <p className="ui-small ui-muted">{`Pick ${missing.map((m) => `“${m}”`).join(", ")} first.`}</p>}

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

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
import { AiCallCounter } from "../common/AiCallCounter";
import { AppTag } from "../common/AppLogo";
import { Notice } from "../common/Notice";
import { Spinner } from "../common/Progress";
import { Section } from "../common/Section";
import { Tag } from "../common/Tag";
import { EnvironmentWarning } from "./EnvironmentWarning";
import { InputValueField } from "./InputValueField";
import { ParamField } from "./ParamField";
import { QcModePicker } from "./QcModePicker";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
  // Columns Doppl matched with AI on this screen, and the AI calls that took.
  const [aiColumns, setAiColumns] = useState<Record<string, Record<string, string>>>({});
  const [aiCalls, setAiCalls] = useState(0);
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

  // The check before the run, whenever the picks change (AI only for a column no name rule can place).
  const picked = inputNodes.some((n) => !isEmpty(inputs[n.id]));
  const { data: preflight, loading: checking } = useAsync(
    () => (picked ? doppel().preflightRun(target, { inputs, matches, columns, aiColumns }) : Promise.resolve(null)),
    [target.id, JSON.stringify(inputs), JSON.stringify(matches), JSON.stringify(columns)],
  );
  const unusable = (preflight?.needs ?? []).filter((i) => i.kind !== "partner");
  // Columns Doppl matched with AI are kept like picked ones: the next check and the run use them without AI.
  useEffect(() => {
    if (preflight?.aiCalls) setAiCalls((n) => n + preflight.aiCalls!);
    const found = preflight?.columns;
    if (!found) return;
    setAiColumns((c) => {
      const next = { ...c };
      for (const [node, map] of Object.entries(found)) next[node] = { ...(next[node] ?? {}), ...map };
      return next;
    });
    setColumns((c) => {
      const next = { ...c };
      let changed = false;
      for (const [node, map] of Object.entries(found)) {
        for (const [expected, header] of Object.entries(map)) {
          if (next[node]?.[expected] !== undefined) continue;
          next[node] = { ...(next[node] ?? {}), [expected]: header };
          changed = true;
        }
      }
      return changed ? next : c;
    });
  }, [preflight]);

  // Results saved into the folder an input reads would be read with it next time (cutouts of cutouts).
  const sameFolderAs = (folder: string) => {
    const trim = (p: string) => p.replace(/\/+$/, "");
    return inputNodes.find((n) => (n.port.type === "fileList" || n.port.type === "folder") && typeof inputs[n.id] === "string" && trim(String(inputs[n.id])) === trim(folder))?.port.label;
  };
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
    <div className="flex flex-col gap-6">
      {setup.issues.length > 0 && (
        <Notice tone="error" title={copy.run.blockedBy}>
          <ul className="text-sm flex flex-col gap-1">
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

      <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title={copy.run.readinessTitle}>
            {!readiness && loading ? (
              <Spinner />
            ) : (
              <ul className="flex flex-col">
                {readiness?.map((r) => (
                  <li key={r.appId} className="flex flex-col gap-3 border-t py-4 first:border-t-0 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <AppTag appId={r.appId} />
                        <span className="text-sm text-muted-foreground">{copy.run.readinessStages(r.uses)}</span>
                      </div>
                      <Tag tone={r.ok ? "filled" : "default"}>{r.ok ? copy.run.readinessOk : copy.appStatus[r.status]}</Tag>
                    </div>
                    {r.needsDocument ? (
                      r.documents.length > 0 && (
                        <NativeSelect
                          className="w-full max-w-md"
                          aria-label={`${appLabel(r.appId)} ${copy.run.documentLabel}`}
                          value={r.documentId ?? ""}
                          onChange={(e) => setDocuments((d) => ({ ...d, [r.appId]: e.target.value }))}
                        >
                          {r.documents.map((d) => (
                            <NativeSelectOption key={d.id} value={d.id}>
                              {d.name} {d.active ? copy.newTask.activeDocument : ""}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      )
                    ) : (
                      <span className="text-sm text-muted-foreground">{copy.run.noDocumentNeeded}</span>
                    )}
                    {!r.ok && r.message && <p className="text-sm">{r.message}</p>}
                    {r.appId === "photoshop" && <p className="text-sm text-muted-foreground">{copy.run.photoshopSafety}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {inputNodes.length > 0 && (
            <Section title={copy.run.inputsTitle}>
              <div className="flex flex-col gap-6">
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
                  <div key={e.id} className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">{copy.flow.joinHint(routine.name, iterPort.label)}</p>
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
                // Other files picked: a new check, with nothing skipped or suggested yet.
                key={JSON.stringify(inputs)}
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
                aiCalls={aiCalls}
                onPickColumn={(issue, column) => {
                  setColumns((c) => ({ ...c, [issue.inputNodeId]: { ...(c[issue.inputNodeId] ?? {}), [issue.column]: column } }));
                  setAiColumns((c) => ({ ...c, [issue.inputNodeId]: Object.fromEntries(Object.entries(c[issue.inputNodeId] ?? {}).filter(([k]) => k !== issue.column)) }));
                }}
                onSuggestPartners={(ids) => doppel().suggestPartners(target, { inputs, matches, columns }, ids)}
              />
            </Section>
          )}

        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {setup.settings.length > 0 && routine && (
            <Section title={copy.run.settingsTitle}>
              <div className="flex flex-col gap-6">
                {setup.settings.map((s) => (
                  <ParamField key={s.key} routineId={routine.id} documentId={readiness?.find((r) => r.appId === routine.appId)?.documentId} param={s} value={settings[s.key]} onChange={(v) => setSetting(s.key, v)} />
                ))}
              </div>
            </Section>
          )}

          {outputNodes.length > 0 && (
            <Section title={copy.run.outputsTitle}>
              <p className="text-sm text-muted-foreground">{target.kind === "flow" ? copy.run.outputsHintFlow : copy.run.outputsHint}</p>
              <div className="flex flex-col gap-4">
                {outputNodes.map((n) => (
                  <div key={n.id} className="flex flex-wrap items-center gap-3">
                    <span className="w-48">{n.port.label}</span>
                    <Button variant="outline"
                      onClick={async () => {
                        const folder = await doppel().pickFolder();
                        if (folder) setFolders((f) => ({ ...f, [n.id]: folder }));
                      }}
                    >
                      {folders[n.id] ? copy.run.change : copy.run.choose}
                    </Button>
                    <span className={folders[n.id] ? "truncate" : "text-muted-foreground"} title={folders[n.id]}>
                      {folders[n.id] ? fileName(folders[n.id]) : copy.run.notChosen}
                    </span>
                    {folders[n.id] && sameFolderAs(folders[n.id]) && <span className="text-sm w-full">⚠ {copy.run.sameFolder(sameFolderAs(folders[n.id])!)}</span>}
                    {folders[n.id] && target.kind === "routine" && (
                      <Button variant="link" className="h-auto p-0 text-sm" onClick={() => setFolders((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== n.id)))}>
                        {copy.run.clear}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {canChooseTarget && (
            <Section title={copy.run.targetTitle}>
              <RadioGroup className="flex flex-col gap-3" aria-label={copy.run.targetTitle} value={target2} onValueChange={(next) => setTarget2(next as typeof target2)}>
                <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
                  <RadioGroupItem className="mt-0.5" value="copy" />
                  <span>
                    {appIds.has("figma") ? copy.run.figmaOnCopy : copy.run.onCopy}
                    <span className="text-sm text-muted-foreground block">{appIds.has("figma") ? copy.run.figmaOnCopyHint() : copy.run.onCopyHint()}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
                  <RadioGroupItem className="mt-0.5" value="original" />
                  <span>
                    {appIds.has("figma") ? copy.run.figmaOnOriginal : copy.run.onOriginal}
                    <span className="text-sm text-muted-foreground block">{appIds.has("figma") ? copy.run.figmaOnOriginalHint : copy.run.onOriginalHint}</span>
                  </span>
                </label>
              </RadioGroup>
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
          {missing.length > 0 && <p className="text-sm text-muted-foreground">{`Pick ${missing.map((m) => `“${m}”`).join(", ")} first.`}</p>}

          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={start} disabled={blocked || starting}>
              {starting ? copy.run.starting : copy.run.runButton}
            </Button>
            <div className="min-w-64 flex-1">
              <AiCallCounter count={0} label={copy.run.aiCounterLabel} hint={qcMode === "auto_ai" ? copy.run.aiCounterReview : copy.run.aiCounterZero} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

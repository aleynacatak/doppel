"use client";

import type {
  BlockCandidate,
  BlockInfo,
  ConnectionLogEntry,
  CreationTranscript,
  DevRunResult,
  DocumentRef,
  ExecutionPlan,
  Flow,
  HelperTestResult,
  Routine,
  ValidationResult,
} from "@core/types";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Progress";
import { Section } from "@/components/ui/Section";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";
import { useShell } from "@/lib/store";

// Hidden dev panel (Cmd+Shift+D). Developer tool: plain labels, raw JSON.

function DocumentPicker({ docs, value, onChange, allowNone }: { docs: DocumentRef[]; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <select className="ui-select max-w-md" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">No document</option>}
      {docs.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

function RunResult({ result }: { result: DevRunResult }) {
  return (
    <div className="flex flex-col gap-2">
      <Notice tone={result.ok ? "info" : "error"} title={result.ok ? `OK · ${result.ms} ms` : `Failed · ${result.ms} ms`}>
        {result.error && <pre className="ui-small whitespace-pre-wrap">{result.error}</pre>}
      </Notice>
      {result.findings.length > 0 && (
        <ul className="ui-small list-disc pl-5">
          {result.findings.map((f, i) => (
            <li key={i}>
              {f.type}: {f.message}
            </li>
          ))}
        </ul>
      )}
      {result.files.length > 0 && (
        <ul className="ui-small">
          {result.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {result.previews.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {result.previews.map((p, i) => (
            <img key={i} src={p.src} alt={p.label} className="ui-card max-h-48" />
          ))}
        </div>
      )}
      {result.log.length > 0 && <pre className="ui-code max-h-40 p-2">{result.log.join("\n")}</pre>}
      {result.data !== undefined && result.data !== null && <pre className="ui-code max-h-80 p-2">{JSON.stringify(result.data, null, 2)}</pre>}
    </div>
  );
}

function FigmaRunner() {
  const apps = useShell((s) => s.apps);
  const figma = apps.find((a) => a.id === "figma");
  const { data: docs = [] } = useAsync(() => doppel().listOpenDocuments("figma"), [figma?.status, figma?.detail]);
  const [doc, setDoc] = useState("");
  const [actions, setActions] = useState('[\n  { "action": "getSelection", "id": "sel" }\n]');
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DevRunResult | null>(null);
  useEffect(() => {
    if (!doc && docs[0]) setDoc(docs[0].id);
  }, [docs, doc]);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await doppel().devRunFigmaActions(doc, actions, item));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message, log: [], findings: [], previews: [], files: [], ms: 0 });
    }
    setBusy(false);
  };
  return (
    <Section title="Figma action runner">
      <p className="ui-small ui-muted">Runs on the current page of the file (one undo step in Figma). Placeholders: {"{{item.<field>}}"} from the sample item.</p>
      {docs.length === 0 ? <p className="ui-small">Start the Doppl plugin in a Figma file.</p> : <DocumentPicker docs={docs} value={doc} onChange={setDoc} />}
      <Field label="Action list (JSON)" htmlFor="dev-actions">
        <textarea id="dev-actions" className="ui-input ui-code h-56" value={actions} onChange={(e) => setActions(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Sample item (JSON, optional)" htmlFor="dev-item">
        <textarea id="dev-item" className="ui-input ui-code h-20" value={item} onChange={(e) => setItem(e.target.value)} spellCheck={false} placeholder='{ "name": "…" }' />
      </Field>
      <div>
        <Button variant="primary" onClick={run} disabled={!doc || busy}>
          {busy ? <Spinner /> : "Run actions"}
        </Button>
      </div>
      {result && <RunResult result={result} />}
    </Section>
  );
}

function PhotoshopRunner() {
  const apps = useShell((s) => s.apps);
  const ps = apps.find((a) => a.id === "photoshop");
  const { data: docs = [] } = useAsync(() => (ps?.status === "connected" ? doppel().listOpenDocuments("photoshop") : Promise.resolve([])), [ps?.status]);
  const [doc, setDoc] = useState("");
  const [script, setScript] = useState('ctx.log(doc ? doc.name + " · " + doc.layers.length + " layers" : "no document");\nreturn { ok: true };');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DevRunResult | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await doppel().devRunPhotoshopScript(doc || null, script));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message, log: [], findings: [], previews: [], files: [], ms: 0 });
    }
    setBusy(false);
  };
  return (
    <Section title="Photoshop script runner">
      <p className="ui-small ui-muted">Runs on a working copy of the document (never saved; closed afterwards). The helper library is loaded: openDocument, findLayer, replaceSmartObject, setTextLayer, setLayerVisible, exportImage, saveCopy, closeWithoutSaving.</p>
      {ps?.status !== "connected" ? <p className="ui-small">Photoshop isn't connected.</p> : <DocumentPicker docs={docs} value={doc} onChange={setDoc} allowNone />}
      <Field label="Script (function body: doc, params, ctx)" htmlFor="dev-script">
        <textarea id="dev-script" className="ui-input ui-code h-56" value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
      </Field>
      <div>
        <Button variant="primary" onClick={run} disabled={ps?.status !== "connected" || busy}>
          {busy ? <Spinner /> : "Run script"}
        </Button>
      </div>
      {result && <RunResult result={result} />}
    </Section>
  );
}

function BarcodeTester() {
  const [type, setType] = useState("ean13");
  const [value, setValue] = useState("400638133393");
  const [result, setResult] = useState<{ ok: boolean; value?: string; svg?: string; error?: string } | null>(null);
  return (
    <Section title="Barcode tester">
      <div className="flex flex-wrap items-center gap-2">
        <select className="ui-select max-w-40" value={type} onChange={(e) => setType(e.target.value)}>
          {["ean13", "ean8", "upca", "code128"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input className="ui-input max-w-xs" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Barcode value" />
        <Button onClick={async () => setResult(await doppel().devBarcode(type, value))}>Draw</Button>
      </div>
      {result && !result.ok && <Notice tone="error">{result.error}</Notice>}
      {result?.ok && (
        <div className="flex flex-col gap-1">
          <span className="ui-small">Encoded: {result.value}</span>
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg!)}`} alt={`Barcode ${result.value}`} className="max-w-xs bg-white p-2" />
        </div>
      )}
    </Section>
  );
}

/** Run a flow with every app simulated, forced failures, and the execution plan first. */
function FlowLab() {
  const router = useRouter();
  const { data: flows = [] } = useAsync(() => doppel().listFlows(), []);
  const [flowId, setFlowId] = useState("");
  const flow: Flow | undefined = flows.find((f) => f.id === flowId) ?? flows[0];
  const [mocked, setMocked] = useState(true);
  const [failNodes, setFailNodes] = useState<string[]>([]);
  const [failItems, setFailItems] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: ctx } = useAsync(() => (flow ? doppel().getFlowContext(flow) : Promise.resolve(null)), [flow?.id]);
  const routineNodes = flow?.nodes.filter((n) => n.kind === "routine") ?? [];
  const items = (text: string) =>
    text
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  const run = async () => {
    if (!flow) return;
    setError(null);
    try {
      const setup = await doppel().getRunSetup({ kind: "flow", id: flow.id });
      const r = await doppel().devRunFlow(
        flow.id,
        { inputs: mocked ? {} : setup.last.inputs, outputFolders: mocked ? {} : setup.last.outputFolders, qcMode: "auto", options: { target: "copy" } },
        { mocked, failNodes, failItems: Object.fromEntries(Object.entries(failItems).map(([k, v]) => [k, items(v)])) },
      );
      router.push(`/run?flow=${flow.id}&run=${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Section title="Flow runner">
      <p className="ui-small ui-muted">
        Runs a flow without AI. Simulated apps write placeholder files for each output, so handoffs, joins, partial failure and cancel can be tried without InDesign,
        Photoshop or Figma. Inputs nothing is picked for get three sample rows or files. Real apps use the values picked last time.
      </p>
      {flows.length === 0 ? (
        <p className="ui-small">No flows yet.</p>
      ) : (
        <>
          <select className="ui-select max-w-md" value={flow?.id ?? ""} onChange={(e) => setFlowId(e.target.value)}>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <label className="ui-choice">
            <input type="checkbox" checked={mocked} onChange={(e) => setMocked(e.target.checked)} />
            <span>Simulate every app</span>
          </label>
          {routineNodes.length > 0 && (
            <table className="ui-table ui-small">
              <thead>
                <tr>
                  <th className="py-1 pr-3">Routine node</th>
                  <th className="py-1 pr-3">Fail the node</th>
                  <th className="py-1">Fail items (1-based, e.g. 2, 4)</th>
                </tr>
              </thead>
              <tbody>
                {routineNodes.map((n) => (
                  <tr key={n.id}>
                    <td className="py-1 pr-3">{ctx?.routines[n.id]?.name ?? n.id}</td>
                    <td className="py-1 pr-3">
                      <input
                        type="checkbox"
                        checked={failNodes.includes(n.id)}
                        onChange={(e) => setFailNodes((f) => (e.target.checked ? [...f, n.id] : f.filter((x) => x !== n.id)))}
                        aria-label={`Fail ${n.id}`}
                      />
                    </td>
                    <td className="py-1">
                      <input className="ui-input max-w-40" value={failItems[n.id] ?? ""} onChange={(e) => setFailItems((f) => ({ ...f, [n.id]: e.target.value }))} aria-label={`Fail items of ${n.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex gap-2">
            <Button onClick={async () => flow && setPlan(await doppel().devExecutionPlan(flow.id, {}))}>Show execution plan</Button>
            <Button variant="primary" onClick={run}>
              Run flow
            </Button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {plan && (
            <div className="flex flex-col gap-2">
              <table className="ui-table ui-small">
                <thead>
                  <tr>
                    <th className="py-1 pr-3">#</th>
                    <th className="py-1 pr-3">Node</th>
                    <th className="py-1 pr-3">Items</th>
                    <th className="py-1">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.steps.map((s, i) => (
                    <tr key={s.nodeId}>
                      <td className="py-1 pr-3">{i + 1}</td>
                      <td className="py-1 pr-3">
                        {s.kind} · {s.name}
                        {s.appId ? ` · ${s.appId}` : ""}
                        {s.iterates ? ` · per item of ${s.iterates}` : ""}
                      </td>
                      <td className="py-1 pr-3">{s.items ?? "?"}</td>
                      <td className="ui-muted py-1">{s.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.joins.map((j) => (
                <div key={j.edgeId} className="ui-small">
                  <div className="ui-label">
                    Join into {j.into}: {JSON.stringify(j.rule)}
                  </div>
                  {j.preview.note ? (
                    <p className="ui-muted">{j.preview.note}</p>
                  ) : (
                    <ul>
                      {j.preview.pairs.map((p, i) => (
                        <li key={i}>
                          {p.item} → {p.match ?? `none (${p.problem})`}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {plan.issues.length > 0 && <pre className="ui-code p-2">{plan.issues.map((i) => `${i.code}: ${i.message}`).join("\n")}</pre>}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** One of my routines in the starter format, for resources/starters/. */
function ExportStarter() {
  const { data: routines = [] } = useAsync(() => doppel().listRoutines(), []);
  const [id, setId] = useState("");
  const [converter, setConverter] = useState(false);
  const [result, setResult] = useState<{ path: string | null; removed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const routine: Routine | undefined = routines.find((r) => r.id === id) ?? routines[0];
  return (
    <Section title="Export as starter">
      <p className="ui-small ui-muted">
        Writes one of your routines in the starter format (run history, request notes and locations on this Mac taken out; inputs and outputs checked). Put the
        file into resources/starters/ to ship it as “Made by Doppl”. A converter has one input and one output and is offered for incompatible connections.
      </p>
      {routines.length === 0 ? (
        <p className="ui-small">No routines yet.</p>
      ) : (
        <>
          <select className="ui-select max-w-md" value={routine?.id ?? ""} onChange={(e) => setId(e.target.value)}>
            {routines.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} (v{r.version})
              </option>
            ))}
          </select>
          <label className="ui-choice">
            <input type="checkbox" checked={converter} onChange={(e) => setConverter(e.target.checked)} />
            <span>Tag as converter</span>
          </label>
          <div>
            <Button
              onClick={async () => {
                if (!routine) return;
                setError(null);
                try {
                  setResult(await doppel().devExportStarter(routine.id, { converter }));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Export…
            </Button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {result && (
            <Notice title={result.path ? `Saved ${result.path}` : "Not saved"}>
              {result.removed.length > 0 && <p className="ui-small">Taken out: {result.removed.join("; ")}</p>}
            </Notice>
          )}
        </>
      )}
    </Section>
  );
}

function RoutineBuilder() {
  const router = useRouter();
  const [json, setJson] = useState("");
  const [validation, setValidation] = useState<{ validation: ValidationResult; parseError?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Routine builder">
      <p className="ui-small ui-muted">
        Paste a routine in the model&apos;s format: {"{"} name, app, inputs, outputs, settings, iterate, actions (Figma) or script {"}"}. Validate, then save it to the library.
        Saving and running use no AI.
      </p>
      <textarea className="ui-input ui-code h-72" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} aria-label="Routine JSON" />
      <div className="flex gap-2">
        <Button onClick={async () => setValidation(await doppel().devValidateRoutine(json))}>Validate</Button>
        <Button
          variant="primary"
          onClick={async () => {
            setError(null);
            try {
              const res = await doppel().devSaveRoutine(json);
              router.push(`/routine?id=${res.routine!.id}&saved=1`);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Save routine
        </Button>
      </div>
      {validation?.parseError && <Notice tone="error">{validation.parseError}</Notice>}
      {validation && !validation.parseError && (
        <Notice tone={validation.validation.ok ? "info" : "error"} title={validation.validation.ok ? "Valid" : `${validation.validation.errors.length} problems`}>
          <ul className="ui-small">
            {validation.validation.errors.map((e, i) => (
              <li key={i}>
                <code>{e.path}</code> [{e.code}] {e.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

function LastCreation() {
  const [t, setT] = useState<CreationTranscript | null | undefined>(undefined);
  const load = async () => setT(await doppel().devLastCreationTranscript());
  return (
    <Section title="Last creation: the AI's answers" aside={<Button size="small" onClick={load}>{t === undefined ? "Show" : "Refresh"}</Button>}>
      <p className="ui-small ui-muted">The latest creation (its plan and every routine), turn by turn: what the AI answered and what Doppl replied. Kept in memory only.</p>
      {t === null && <p className="ui-small">No creation since Doppl started.</p>}
      {t && (
        <div className="flex flex-col gap-2">
          <p className="ui-small">
            {t.at.slice(0, 19).replace("T", " ")} · “{t.request.slice(0, 120)}{t.request.length > 120 ? "…" : ""}”
          </p>
          {t.entries.map((e, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="ui-label">{e.role === "ai" ? `AI answer` : i === 0 ? "Doppl: the task" : "Doppl's reply"}</div>
              <pre className="ui-code max-h-72 whitespace-pre-wrap p-2">{e.text}</pre>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ConnectionLog() {
  const [entries, setEntries] = useState<ConnectionLogEntry[]>([]);
  useEffect(() => {
    const api = doppel();
    api.getConnectionLog().then(setEntries);
    return api.onConnectionLog((e) => setEntries((list) => [...list.slice(-299), e]));
  }, []);
  return (
    <Section
      title="Connection log"
      aside={
        <Button
          size="small"
          onClick={async () => {
            await doppel().clearConnectionLog();
            setEntries([]);
          }}
        >
          Clear
        </Button>
      }
    >
      <p className="ui-small ui-muted">AppleScript and plugin traffic: metadata only, never file contents.</p>
      <pre className="ui-code max-h-80 p-2">
        {entries
          .slice()
          .reverse()
          .map((e) => `${e.at.slice(11, 19)} ${e.channel.padEnd(11)} ${e.app.padEnd(9)} ${e.direction.padEnd(5)} ${e.kind}${e.ok === false ? " FAILED" : ""}${e.ms !== undefined ? ` ${e.ms}ms` : ""}${e.bytes !== undefined ? ` ${e.bytes}B` : ""}${e.note ? ` · ${e.note}` : ""}`)
          .join("\n") || "Nothing yet."}
      </pre>
    </Section>
  );
}

function TestResults({ results }: { results: HelperTestResult[] }) {
  return (
    <ul className="ui-small flex flex-col gap-0.5">
      {results.map((r, i) => (
        <li key={i}>
          {r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL"} {r.helper} v{r.version} · {r.test}
          {r.skipped ? ` (${r.skipped})` : r.passed ? "" : `: ${r.detail}`}
        </li>
      ))}
    </ul>
  );
}

function BuildingBlocks() {
  const { settings, setSettings } = useShell();
  const { data: library } = useAsync<BlockInfo[]>(() => doppel().listBlocks(), []);
  const { data: candidates, reload } = useAsync<BlockCandidate[]>(() => doppel().listBlockCandidates(), []);
  const [tests, setTests] = useState<HelperTestResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<BlockCandidate | { file: string; warnings: string[] } | null>) => {
    setBusy(id);
    setNote(null);
    try {
      const res = await fn();
      if (res && "file" in res) setNote(`Exported to ${res.file}${res.warnings.length ? ` · ${res.warnings.join(" · ")}` : ""}`);
      reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="Building blocks">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ui-label">Library</span>
          <Button
            size="small"
            disabled={busy === "tests"}
            onClick={async () => {
              setBusy("tests");
              setTests(await doppel().runBlockTests().finally(() => setBusy(null)));
            }}
          >
            {busy === "tests" ? "Running tests…" : "Run all tests in the apps"}
          </Button>
        </div>
        <table className="ui-table ui-small">
          <tbody>
            {(library ?? []).map((b) => (
              <tr key={b.id}>
                <td className="py-1 pr-3">{b.call}</td>
                <td className="ui-muted py-1 pr-3">
                  {b.id} v{b.version}
                  {b.versions.length > 1 ? ` (versions ${b.versions.join(", ")})` : ""}
                </td>
                <td className="ui-muted py-1 pr-3">{b.set}</td>
                <td className="ui-muted py-1 pr-3">{b.source === "promoted" ? "yours" : "built-in"}</td>
                <td className="ui-muted py-1">{b.tests} test(s)</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tests && <TestResults results={tests} />}
      </div>

      <div className="flex flex-col gap-2">
        <span className="ui-label">Candidates (custom code from saved routines, best first)</span>
        <label className="ui-choice">
          <input
            type="checkbox"
            checked={!!settings?.autoPromoteBlocks}
            onChange={async (e) => setSettings(await doppel().saveSettings({ autoPromoteBlocks: e.target.checked }))}
          />
          <span>Promote automatically: used successfully in 2+ routines, 5+ items, no "This isn't right" or refine changes, tests pass (off by default; uses AI only when a routine is saved)</span>
        </label>
        {note && <Notice>{note}</Notice>}
        {(candidates ?? []).length === 0 && <p className="ui-small ui-muted">None yet. Steps written as custom code show up here after a routine is saved.</p>}
        {(candidates ?? []).map((c) => (
          <div key={c.id} className="ui-card flex flex-col gap-2 p-3" data-selected={c.status === "promoted"}>
            <div className="ui-small">
              <strong>score {c.score}</strong> · {c.app} · {c.status} · written in {new Set(c.occurrences.map((o) => o.routineId)).size} routine(s)
            </div>
            <ul className="ui-small ui-muted flex flex-col">
              {c.occurrences.map((o, i) => (
                <li key={i}>
                  “{o.step}” in {o.routineName} v{o.version} · trial {o.trial.ok}/{o.trial.items}
                </li>
              ))}
            </ul>
            <div className="ui-small ui-muted">
              {c.evidence.successfulItems} successful items · {c.evidence.inputKeys.length} distinct inputs · checks {c.evidence.qcPassed}/{c.evidence.qcChecked} · OK {c.evidence.markedOk} · not right {c.evidence.notRight} · refine changes {c.evidence.refineTouches}
            </div>
            <details>
              <summary className="ui-small ui-link">Code</summary>
              <pre className="ui-small overflow-x-auto whitespace-pre-wrap">{c.code}</pre>
            </details>
            {c.draft && (
              <div className="flex flex-col gap-1">
                <div className="ui-small">
                  Generalized: <strong>{c.draft.def.call}</strong> ({c.draft.def.id} v{c.draft.def.version}) · {c.draft.def.summary}
                </div>
                {c.draft.lint.length > 0 && <Notice tone="warning">{c.draft.lint.join(" · ")}</Notice>}
                {c.draft.tests.length > 0 && <TestResults results={c.draft.tests} />}
                <details>
                  <summary className="ui-small ui-link">Block code and docs</summary>
                  <pre className="ui-small overflow-x-auto whitespace-pre-wrap">{`${c.draft.def.doc}\n\n${c.draft.def.code}`}</pre>
                </details>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {c.status !== "promoted" && c.status !== "dismissed" && (
                <Button size="small" disabled={!!busy} onClick={() => act(c.id, () => doppel().generalizeBlockCandidate(c.id))}>
                  {busy === c.id ? "Working…" : c.draft ? "Generalize again" : "Generalize (1 AI call)"}
                </Button>
              )}
              {c.status === "generalized" && (
                <Button size="small" variant="primary" disabled={!!busy} onClick={() => act(c.id, () => doppel().approveBlockCandidate(c.id))}>
                  Approve into my library
                </Button>
              )}
              {c.status === "promoted" && (
                <Button size="small" disabled={!!busy} onClick={() => act(c.id, () => doppel().exportBlockCandidate(c.id))}>
                  Export as built-in…
                </Button>
              )}
              {c.status !== "dismissed" && c.status !== "promoted" && (
                <Button size="small" disabled={!!busy} onClick={() => act(c.id, () => doppel().dismissBlockCandidate(c.id))}>
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function DevPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Dev panel" subtitle="Hidden tools for building and checking routines. Cmd+Shift+D." />
      <FigmaRunner />
      <PhotoshopRunner />
      <BarcodeTester />
      <FlowLab />
      <ExportStarter />
      <RoutineBuilder />
      <BuildingBlocks />
      <LastCreation />
      <ConnectionLog />
    </div>
  );
}

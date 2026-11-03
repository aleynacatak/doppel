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
import { Field } from "@/components/common/Field";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { Spinner } from "@/components/common/Progress";
import { Section } from "@/components/common/Section";
import { doppel } from "@/lib/doppel";
import { useAsync } from "@/lib/hooks";
import { useShell } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// Hidden dev panel (Cmd+Shift+D). Developer tool: plain labels, raw JSON.

function DocumentPicker({ docs, value, onChange, allowNone }: { docs: DocumentRef[]; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <NativeSelect className="w-full max-w-md" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <NativeSelectOption value="">No document</NativeSelectOption>}
      {docs.map((d) => (
        <NativeSelectOption key={d.id} value={d.id}>
          {d.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function RunResult({ result }: { result: DevRunResult }) {
  return (
    <div className="flex flex-col gap-3">
      <Notice tone={result.ok ? "info" : "error"} title={result.ok ? `OK · ${result.ms} ms` : `Failed · ${result.ms} ms`}>
        {result.error && <pre className="text-sm whitespace-pre-wrap">{result.error}</pre>}
      </Notice>
      {result.findings.length > 0 && (
        <ul className="text-sm list-disc pl-5">
          {result.findings.map((f, i) => (
            <li key={i}>
              {f.type}: {f.message}
            </li>
          ))}
        </ul>
      )}
      {result.files.length > 0 && (
        <ul className="text-sm">
          {result.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {result.previews.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {result.previews.map((p, i) => (
            <img key={i} src={p.src} alt={p.label} className="rounded-2xl bg-card text-card-foreground ring-1 ring-foreground/10 max-h-48" />
          ))}
        </div>
      )}
      {result.log.length > 0 && <pre className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre max-h-40 p-3">{result.log.join("\n")}</pre>}
      {result.data !== undefined && result.data !== null && <pre className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre max-h-80 p-3">{JSON.stringify(result.data, null, 2)}</pre>}
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
      <p className="text-sm text-muted-foreground">Runs on the current page of the file (one undo step in Figma). Placeholders: {"{{item.<field>}}"} from the sample item.</p>
      {docs.length === 0 ? <p className="text-sm">Start the Doppl plugin in a Figma file.</p> : <DocumentPicker docs={docs} value={doc} onChange={setDoc} />}
      <Field label="Action list (JSON)" htmlFor="dev-actions">
        <Textarea id="dev-actions" className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre h-56" value={actions} onChange={(e) => setActions(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Sample item (JSON, optional)" htmlFor="dev-item">
        <Textarea id="dev-item" className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre h-20" value={item} onChange={(e) => setItem(e.target.value)} spellCheck={false} placeholder='{ "name": "…" }' />
      </Field>
      <div>
        <Button onClick={run} disabled={!doc || busy}>
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
      <p className="text-sm text-muted-foreground">Runs on a working copy of the document (never saved; closed afterwards). The helper library is loaded: openDocument, findLayer, replaceSmartObject, setTextLayer, setLayerVisible, exportImage, saveCopy, closeWithoutSaving.</p>
      {ps?.status !== "connected" ? <p className="text-sm">Photoshop isn't connected.</p> : <DocumentPicker docs={docs} value={doc} onChange={setDoc} allowNone />}
      <Field label="Script (function body: doc, params, ctx)" htmlFor="dev-script">
        <Textarea id="dev-script" className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre h-56" value={script} onChange={(e) => setScript(e.target.value)} spellCheck={false} />
      </Field>
      <div>
        <Button onClick={run} disabled={ps?.status !== "connected" || busy}>
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
        <NativeSelect className="w-full max-w-40" value={type} onChange={(e) => setType(e.target.value)}>
          {["ean13", "ean8", "upca", "code128"].map((t) => (
            <NativeSelectOption key={t}>{t}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Input className="max-w-xs" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Barcode value" />
        <Button variant="outline" onClick={async () => setResult(await doppel().devBarcode(type, value))}>Draw</Button>
      </div>
      {result && !result.ok && <Notice tone="error">{result.error}</Notice>}
      {result?.ok && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm">Encoded: {result.value}</span>
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg!)}`} alt={`Barcode ${result.value}`} className="max-w-xs bg-white p-3" />
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
      <p className="text-sm text-muted-foreground">
        Runs a flow without AI. Simulated apps write placeholder files for each output, so handoffs, joins, partial failure and cancel can be tried without InDesign,
        Photoshop or Figma. Inputs nothing is picked for get three sample rows or files. Real apps use the values picked last time.
      </p>
      {flows.length === 0 ? (
        <p className="text-sm">No flows yet.</p>
      ) : (
        <>
          <NativeSelect className="w-full max-w-md" value={flow?.id ?? ""} onChange={(e) => setFlowId(e.target.value)}>
            {flows.map((f) => (
              <NativeSelectOption key={f.id} value={f.id}>
                {f.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
            <Checkbox className="mt-0.5" checked={mocked} onCheckedChange={(checked) => setMocked(checked)} />
            <span>Simulate every app</span>
          </label>
          {routineNodes.length > 0 && (
            <Table className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="py-1.5 pr-3">Routine node</TableHead>
                  <TableHead className="py-1.5 pr-3">Fail the node</TableHead>
                  <TableHead className="py-1.5">Fail items (1-based, e.g. 2, 4)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routineNodes.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="py-1.5 pr-3">{ctx?.routines[n.id]?.name ?? n.id}</TableCell>
                    <TableCell className="py-1.5 pr-3">
                      <Checkbox className="mt-0.5"
                        checked={failNodes.includes(n.id)}
                        onCheckedChange={(checked) => setFailNodes((f) => (checked ? [...f, n.id] : f.filter((x) => x !== n.id)))}
                        aria-label={`Fail ${n.id}`}
                      />
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Input className="max-w-40" value={failItems[n.id] ?? ""} onChange={(e) => setFailItems((f) => ({ ...f, [n.id]: e.target.value }))} aria-label={`Fail items of ${n.id}`} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={async () => flow && setPlan(await doppel().devExecutionPlan(flow.id, {}))}>Show execution plan</Button>
            <Button onClick={run}>
              Run flow
            </Button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {plan && (
            <div className="flex flex-col gap-3">
              <Table className="text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead className="py-1.5 pr-3">#</TableHead>
                    <TableHead className="py-1.5 pr-3">Node</TableHead>
                    <TableHead className="py-1.5 pr-3">Items</TableHead>
                    <TableHead className="py-1.5">Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.steps.map((s, i) => (
                    <TableRow key={s.nodeId}>
                      <TableCell className="py-1.5 pr-3">{i + 1}</TableCell>
                      <TableCell className="py-1.5 pr-3">
                        {s.kind} · {s.name}
                        {s.appId ? ` · ${s.appId}` : ""}
                        {s.iterates ? ` · per item of ${s.iterates}` : ""}
                      </TableCell>
                      <TableCell className="py-1.5 pr-3">{s.items ?? "?"}</TableCell>
                      <TableCell className="text-muted-foreground py-1.5">{s.note}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {plan.joins.map((j) => (
                <div key={j.edgeId} className="text-sm">
                  <div className="text-sm font-medium">
                    Join into {j.into}: {JSON.stringify(j.rule)}
                  </div>
                  {j.preview.note ? (
                    <p className="text-muted-foreground">{j.preview.note}</p>
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
              {plan.issues.length > 0 && <pre className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre p-3">{plan.issues.map((i) => `${i.code}: ${i.message}`).join("\n")}</pre>}
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
      <p className="text-sm text-muted-foreground">
        Writes one of your routines in the starter format (run history, request notes and locations on this Mac taken out; inputs and outputs checked). Put the
        file into resources/starters/ to ship it as “Made by Doppl”. A converter has one input and one output and is offered for incompatible connections.
      </p>
      {routines.length === 0 ? (
        <p className="text-sm">No routines yet.</p>
      ) : (
        <>
          <NativeSelect className="w-full max-w-md" value={routine?.id ?? ""} onChange={(e) => setId(e.target.value)}>
            {routines.map((r) => (
              <NativeSelectOption key={r.id} value={r.id}>
                {r.name} (v{r.version})
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
            <Checkbox className="mt-0.5" checked={converter} onCheckedChange={(checked) => setConverter(checked)} />
            <span>Tag as converter</span>
          </label>
          <div>
            <Button variant="outline"
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
              {result.removed.length > 0 && <p className="text-sm">Taken out: {result.removed.join("; ")}</p>}
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
      <p className="text-sm text-muted-foreground">
        Paste a routine in the model&apos;s format: {"{"} name, app, inputs, outputs, settings, iterate, actions (Figma) or script {"}"}. Validate, then save it to the library.
        Saving and running use no AI.
      </p>
      <Textarea className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre h-72" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} aria-label="Routine JSON" />
      <div className="flex gap-2">
        <Button variant="outline" onClick={async () => setValidation(await doppel().devValidateRoutine(json))}>Validate</Button>
        <Button
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
          <ul className="text-sm">
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
    <Section title="Last creation: the AI's answers" aside={<Button variant="outline" size="sm" onClick={load}>{t === undefined ? "Show" : "Refresh"}</Button>}>
      <p className="text-sm text-muted-foreground">The latest creation (its plan and every routine), turn by turn: what the AI answered and what Doppl replied. Kept in memory only.</p>
      {t === null && <p className="text-sm">No creation since Doppl started.</p>}
      {t && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t.at.slice(0, 19).replace("T", " ")} · “{t.request.slice(0, 120)}{t.request.length > 120 ? "…" : ""}”
          </p>
          {t.entries.map((e, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="text-sm font-medium">{e.role === "ai" ? `AI answer` : i === 0 ? "Doppl: the task" : "Doppl's reply"}</div>
              <pre className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre max-h-72 whitespace-pre-wrap p-3">{e.text}</pre>
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
        <Button variant="outline"
          size="sm"
          onClick={async () => {
            await doppel().clearConnectionLog();
            setEntries([]);
          }}
        >
          Clear
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">AppleScript and plugin traffic: metadata only, never file contents.</p>
      <pre className="overflow-auto rounded-lg border bg-muted font-mono text-xs/relaxed whitespace-pre max-h-80 p-3">
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
    <ul className="text-sm flex flex-col gap-1">
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
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Library</span>
          <Button variant="outline"
            size="sm"
            disabled={busy === "tests"}
            onClick={async () => {
              setBusy("tests");
              setTests(await doppel().runBlockTests().finally(() => setBusy(null)));
            }}
          >
            {busy === "tests" ? "Running tests…" : "Run all tests in the apps"}
          </Button>
        </div>
        <Table className="text-sm">
          <TableBody>
            {(library ?? []).map((b) => (
              <TableRow key={b.id}>
                <TableCell className="py-1.5 pr-3">{b.call}</TableCell>
                <TableCell className="text-muted-foreground py-1.5 pr-3">
                  {b.id} v{b.version}
                  {b.versions.length > 1 ? ` (versions ${b.versions.join(", ")})` : ""}
                </TableCell>
                <TableCell className="text-muted-foreground py-1.5 pr-3">{b.set}</TableCell>
                <TableCell className="text-muted-foreground py-1.5 pr-3">{b.source === "promoted" ? "yours" : "built-in"}</TableCell>
                <TableCell className="text-muted-foreground py-1.5">{b.tests} test(s)</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {tests && <TestResults results={tests} />}
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Candidates (custom code from saved routines, best first)</span>
        <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
          <Checkbox className="mt-0.5"
            checked={!!settings?.autoPromoteBlocks}
            onCheckedChange={async (checked) => setSettings(await doppel().saveSettings({ autoPromoteBlocks: checked }))}
          />
          <span>Promote automatically: used successfully in 2+ routines, 5+ items, no "This isn't right" or refine changes, tests pass (off by default; uses AI only when a routine is saved)</span>
        </label>
        {note && <Notice>{note}</Notice>}
        {(candidates ?? []).length === 0 && <p className="text-sm text-muted-foreground">None yet. Steps written as custom code show up here after a routine is saved.</p>}
        {(candidates ?? []).map((c) => (
          <Card key={c.id} data-selected={c.status === "promoted"} size="sm" className="data-[selected=true]:ring-2 data-[selected=true]:ring-primary">
            <CardContent className="flex flex-col gap-3">
              <div className="text-sm">
                <strong>score {c.score}</strong> · {c.app} · {c.status} · written in {new Set(c.occurrences.map((o) => o.routineId)).size} routine(s)
              </div>
              <ul className="text-sm text-muted-foreground flex flex-col">
                {c.occurrences.map((o, i) => (
                  <li key={i}>
                    “{o.step}” in {o.routineName} v{o.version} · trial {o.trial.ok}/{o.trial.items}
                  </li>
                ))}
              </ul>
              <div className="text-sm text-muted-foreground">
                {c.evidence.successfulItems} successful items · {c.evidence.inputKeys.length} distinct inputs · checks {c.evidence.qcPassed}/{c.evidence.qcChecked} · OK {c.evidence.markedOk} · not right {c.evidence.notRight} · refine changes {c.evidence.refineTouches}
              </div>
              <Collapsible>
                <CollapsibleTrigger className="text-sm text-primary underline-offset-4 hover:underline">Code</CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="text-sm overflow-x-auto whitespace-pre-wrap">{c.code}</pre>
                </CollapsibleContent>
              </Collapsible>
              {c.draft && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-sm">
                    Generalized: <strong>{c.draft.def.call}</strong> ({c.draft.def.id} v{c.draft.def.version}) · {c.draft.def.summary}
                  </div>
                  {c.draft.lint.length > 0 && <Notice tone="warning">{c.draft.lint.join(" · ")}</Notice>}
                  {c.draft.tests.length > 0 && <TestResults results={c.draft.tests} />}
                  <Collapsible>
                    <CollapsibleTrigger className="text-sm text-primary underline-offset-4 hover:underline">Block code and docs</CollapsibleTrigger>
                    <CollapsibleContent>
                    <pre className="text-sm overflow-x-auto whitespace-pre-wrap">{`${c.draft.def.doc}\n\n${c.draft.def.code}`}</pre>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {c.status !== "promoted" && c.status !== "dismissed" && (
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act(c.id, () => doppel().generalizeBlockCandidate(c.id))}>
                    {busy === c.id ? "Working…" : c.draft ? "Generalize again" : "Generalize (1 AI call)"}
                  </Button>
                )}
                {c.status === "generalized" && (
                  <Button size="sm" disabled={!!busy} onClick={() => act(c.id, () => doppel().approveBlockCandidate(c.id))}>
                    Approve into my library
                  </Button>
                )}
                {c.status === "promoted" && (
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act(c.id, () => doppel().exportBlockCandidate(c.id))}>
                    Export as built-in…
                  </Button>
                )}
                {c.status !== "dismissed" && c.status !== "promoted" && (
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act(c.id, () => doppel().dismissBlockCandidate(c.id))}>
                    Dismiss
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}

export default function DevPage() {
  return (
    <div className="flex flex-col gap-10">
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

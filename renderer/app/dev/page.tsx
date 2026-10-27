"use client";

import type { ConnectionLogEntry, CreationTranscript, DevRunResult, DocumentRef, ValidationResult } from "@core/types";
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

function RoutineBuilder() {
  const router = useRouter();
  const [json, setJson] = useState("");
  const [validation, setValidation] = useState<{ validation: ValidationResult; parseError?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="Routine builder">
      <p className="ui-small ui-muted">Paste a routine (params + stages, in the model's format or Doppl's). Validate, then save it to the library. Saving and running use no AI.</p>
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
      <p className="ui-small ui-muted">The latest multi-app creation, turn by turn: what the AI answered and what Doppl replied. Kept in memory only.</p>
      {t === null && <p className="ui-small">No multi-app creation since Doppl started.</p>}
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

export default function DevPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Dev panel" subtitle="Hidden tools for building and checking routines. Cmd+Shift+D." />
      <FigmaRunner />
      <PhotoshopRunner />
      <BarcodeTester />
      <RoutineBuilder />
      <LastCreation />
      <ConnectionLog />
    </div>
  );
}

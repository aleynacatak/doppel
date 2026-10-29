"use client";

import type { Flow, FlowContext, FlowNode, InputValue, PortDef, PortType, Routine, Run } from "@core/types";
import { wouldCreateCycle } from "@shared/flowGraph";
import { describeSpec, isListType } from "@shared/ports";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { type DragItem, FlowCanvas, type Selection } from "@/components/flow/FlowCanvas";
import { FlowInspector } from "@/components/flow/FlowInspector";
import { FlowListView } from "@/components/flow/FlowListView";
import { type AddChoice, AddNodeMenu, LibraryPanel } from "@/components/flow/LibraryPanel";
import { type PortView, newId } from "@/components/flow/flowView";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { Loading } from "@/components/ui/Progress";
import { Segmented } from "@/components/ui/Segmented";
import { Tag } from "@/components/ui/Tag";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";

const INPUT_LABELS: Record<PortType, { key: string; label: string }> = {
  rows: { key: "data", label: "Data file" },
  fileList: { key: "files", label: "Files" },
  file: { key: "file", label: "File" },
  folder: { key: "folder", label: "Folder" },
  document: { key: "document", label: "Document" },
  text: { key: "text", label: "Text" },
  number: { key: "number", label: "Number" },
  boolean: { key: "choice", label: "Yes / no" },
};

type Menu = { at: { x: number; y: number }; flowAt: { x: number; y: number }; from: { nodeId: string; port: string; view: PortView } } | null;

function FlowEditor({ initial, routines }: { initial: Flow; routines: { mine: Routine[]; starters: Routine[] } }) {
  const router = useRouter();
  const params = useSearchParams();
  const apps = useShell((s) => s.apps);
  const [flow, setFlowState] = useState<Flow>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ctx, setCtx] = useState<FlowContext | null>(null);
  const [selection, setSelection] = useState<Selection>(params.get("node") ? { kind: "node", id: params.get("node")! } : null);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [menu, setMenu] = useState<Menu>(null);
  const [notice, setNotice] = useState<string | null>(
    params.get("updated") ? copy.flow.saved : params.get("refined") ? copy.flow.refinedNotice(Number(params.get("refined"))) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [picked, setPicked] = useState<Record<string, InputValue>>({});
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const all = useMemo(() => [...routines.mine, ...routines.starters], [routines]);

  const setFlow = useCallback((next: Flow | ((f: Flow) => Flow)) => {
    setFlowState((f) => (typeof next === "function" ? next(f) : next));
    setDirty(true);
  }, []);

  // Pinned routines and validation follow every change (unsaved changes too).
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      doppel()
        .getFlowContext(flow)
        .then((c) => alive && setCtx(c))
        .catch((e) => alive && setError((e as Error).message));
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [flow]);

  useEffect(() => {
    const api = doppel();
    if (initial.runs[0]) api.getRun(initial.runs[0].id).then(setLastRun).catch(() => undefined);
  }, [initial.id, initial.runs]);

  const updates = useMemo(() => {
    const out: Record<string, number> = {};
    for (const n of flow.nodes) if (n.kind === "routine" && ctx?.latest[n.routineId] && ctx.latest[n.routineId] > n.routineVersion) out[n.id] = ctx.latest[n.routineId];
    return out;
  }, [flow.nodes, ctx]);

  const latestOf = (routineId: string) => all.find((r) => r.id === routineId);

  const addNode = (node: FlowNode) => {
    setFlow((f) => ({ ...f, nodes: [...f.nodes, node] }));
    setSelection({ kind: "node", id: node.id });
  };
  const nodeFor = (item: DragItem, position: { x: number; y: number }): FlowNode | null => {
    const at = { x: Math.round(position.x / 16) * 16, y: Math.round(position.y / 16) * 16 };
    if (item.kind === "input") {
      const { key, label } = INPUT_LABELS[item.type];
      return { id: newId(), kind: "input", port: { key, label, type: item.type, required: true }, position: at };
    }
    if (item.kind === "output") return { id: newId(), kind: "output", port: { key: "results", label: "Results", type: "fileList", required: false }, position: at };
    const routine = latestOf(item.routineId);
    return routine ? { id: newId(), kind: "routine", routineId: routine.id, routineVersion: routine.version, position: at } : null;
  };

  /** A new edge; one that fed the same input before is replaced. Joins get a suggested rule. */
  const connect = async (from: { nodeId: string; port: string }, to: { nodeId: string; port: string }, base = flow) => {
    if (wouldCreateCycle(base.edges, from.nodeId, to.nodeId)) {
      setNotice(copy.flow.noCycle);
      return;
    }
    const replaced = base.edges.some((e) => e.to.nodeId === to.nodeId && e.to.port === to.port);
    const edge = { id: newId(), from, to };
    const next: Flow = { ...base, edges: [...base.edges.filter((e) => !(e.to.nodeId === to.nodeId && e.to.port === to.port)), edge] };
    setFlow(next);
    if (replaced) setNotice(copy.flow.replaced);
    const target = next.nodes.find((n) => n.id === to.nodeId);
    const routine = target?.kind === "routine" ? (ctx?.routines[target.id] ?? latestOf(target.routineId)) : undefined;
    const port = routine?.inputs.find((p) => p.key === to.port);
    if (routine?.iterate && port && port.key !== routine.iterate.input && isListType(port.type)) {
      setSelection({ kind: "edge", id: edge.id });
      const rule = routine.matches?.[port.key] ?? (await doppel().previewMatch(next, edge.id, null, picked).catch(() => null))?.rule;
      if (rule) setFlow((f) => ({ ...f, edges: f.edges.map((e) => (e.id === edge.id ? { ...e, match: rule } : e)) }));
    }
  };

  const onPickChoice = (choice: AddChoice) => {
    if (!menu) return;
    const position = { x: menu.flowAt.x, y: menu.flowAt.y - 40 };
    const node = choice.kind === "output" ? nodeFor({ kind: "output" }, position) : nodeFor({ kind: "routine", routineId: choice.routineId }, position);
    setMenu(null);
    if (!node) return;
    const base = { ...flow, nodes: [...flow.nodes, node] };
    void connect(menu.from, { nodeId: node.id, port: choice.kind === "output" ? (node as { port: PortDef }).port.key : choice.port }, base);
    setSelection({ kind: "node", id: node.id });
  };

  const remove = () => {
    if (!selection) return;
    if (selection.kind === "edge") setFlow((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== selection.id) }));
    else setFlow((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== selection.id), edges: f.edges.filter((e) => e.from.nodeId !== selection.id && e.to.nodeId !== selection.id) }));
    setSelection(null);
  };

  const save = async (): Promise<Flow | null> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await doppel().saveFlow(flow);
      await doppel().rememberInputs({ kind: "flow", id: saved.id }, picked);
      setFlowState(saved);
      setDirty(false);
      return saved;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    if (dirty && !(await save())) return;
    await doppel().rememberInputs({ kind: "flow", id: flow.id }, picked);
    router.push(`/run?flow=${flow.id}${Object.keys(picked).length ? "&picked=1" : ""}`);
  };

  const makeCompatible = async (edgeId: string, side: "source" | "target") => {
    if (dirty && !(await save())) return;
    try {
      const creation = await doppel().makeCompatible(flow.id, edgeId, side);
      router.push(`/create?task=${creation.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const insertConverter = async (edgeId: string, routineId: string) => {
    try {
      setFlow(await doppel().insertConverter(flow, edgeId, routineId));
      setSelection(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pickInput = async (nodeId: string) => {
    const node = flow.nodes.find((n) => n.id === nodeId);
    if (node?.kind !== "input") return;
    const api = doppel();
    const t = node.port.type;
    let value: InputValue = null;
    if (t === "folder") value = await api.pickFolder();
    else if (t === "fileList") value = await api.pickFiles({ extensions: node.port.extensions, multiple: true });
    else if (t === "rows") value = (await api.pickFiles({ extensions: ["csv", "tsv", "txt", "json", "xlsx"] }))[0] ?? null;
    else if (t === "file") value = (await api.pickFiles({ extensions: node.port.extensions }))[0] ?? null;
    else {
      setSelection({ kind: "node", id: nodeId });
      return;
    }
    if (value && (!Array.isArray(value) || value.length)) setPicked((p) => ({ ...p, [nodeId]: value }));
  };

  const del = async () => {
    if (!window.confirm(copy.flow.confirmDelete)) return;
    await doppel().deleteFlow(flow.id);
    router.push("/routines?tab=flows");
  };

  const issues = ctx?.validation.issues ?? [];
  const empty = flow.nodes.length === 0;
  const routineCount = flow.nodes.filter((n) => n.kind === "routine").length;

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/routines?tab=flows" className="ui-small ui-muted ui-link">
          ← {copy.nav.library}
        </Link>
        <input className="ui-input ui-h2 w-72" aria-label={copy.flow.nameLabel} value={flow.name} onChange={(e) => setFlow({ ...flow, name: e.target.value })} />
        <Tag>{copy.common.version(flow.version)}</Tag>
        <span className="ui-small ui-muted">{saving ? copy.flow.saving : dirty ? copy.flow.unsaved : copy.flow.saved}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented<"canvas" | "list">
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "canvas", label: copy.flow.viewCanvas },
              { value: "list", label: copy.flow.viewList },
            ]}
          />
          <Button onClick={() => void save()} disabled={!dirty || saving}>
            {copy.flow.save}
          </Button>
          {issues.length > 0 ? (
            <Button onClick={() => setShowIssues((s) => !s)} aria-expanded={showIssues}>
              {copy.flow.issuesTitle(issues.length)}
            </Button>
          ) : (
            ctx && <span className="ui-small ui-muted">{copy.flow.ready}</span>
          )}
          <Button variant="primary" onClick={run} disabled={!ctx || issues.length > 0 || saving} title={issues.length ? issues.map((i) => i.message).join("\n") : undefined}>
            {copy.flow.run}
          </Button>
          <Button variant="ghost" onClick={del}>
            {copy.flow.delete}
          </Button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && (
        <Notice actions={<Button size="small" onClick={() => setNotice(null)}>{copy.common.close}</Button>}>{notice}</Notice>
      )}
      {showIssues && issues.length > 0 && (
        <Notice tone="warning" title={copy.flow.runBlocked}>
          <ul className="ui-small flex flex-col gap-0.5">
            {issues.map((i, n) => (
              <li key={n}>
                <button type="button" className="ui-link text-left" onClick={() => (i.nodeId ? setSelection({ kind: "node", id: i.nodeId }) : i.edgeId ? setSelection({ kind: "edge", id: i.edgeId }) : undefined)}>
                  {i.message}
                </button>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="w-60 shrink-0 overflow-y-auto pr-1">
          <LibraryPanel mine={routines.mine} starters={routines.starters} onAdd={(item) => {
            const node = nodeFor(item, { x: 64 + flow.nodes.length * 32, y: 64 + flow.nodes.length * 32 });
            if (node) addNode(node);
          }} />
        </aside>
        <main className="min-w-0 flex-1">
          {view === "canvas" ? (
            <FlowCanvas
              className="h-full"
              flow={flow}
              ctx={ctx}
              apps={apps}
              mode="edit"
              run={lastRun}
              updates={updates}
              selection={selection}
              onSelect={setSelection}
              pickedInputs={picked}
              onPickInput={pickInput}
              onUpdateNode={(id) => setFlow((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id && n.kind === "routine" && updates[id] ? { ...n, routineVersion: updates[id] } : n)) }))}
              onSelectEdge={(id) => setSelection({ kind: "edge", id })}
              onFlowChange={(change) => {
                if (change.nodes) setFlow((f) => ({ ...f, nodes: change.nodes! }));
                if (change.removeNodes?.length) {
                  const gone = new Set(change.removeNodes);
                  setFlow((f) => ({ ...f, nodes: f.nodes.filter((n) => !gone.has(n.id)), edges: f.edges.filter((e) => !gone.has(e.from.nodeId) && !gone.has(e.to.nodeId)) }));
                  setSelection(null);
                }
                if (change.removeEdges?.length) {
                  const gone = new Set(change.removeEdges);
                  setFlow((f) => ({ ...f, edges: f.edges.filter((e) => !gone.has(e.id)) }));
                  setSelection(null);
                }
              }}
              onConnect={(from, to) => void connect(from, to)}
              onConnectToEmpty={(from, at) => setMenu({ at: at.client, flowAt: at.flow, from })}
              onDropItem={(item, at) => {
                const node = nodeFor(item, at);
                if (node) addNode(node);
              }}
              overlay={
                empty ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="ui-card pointer-events-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center">
                      <div className="ui-h2">{copy.flow.emptyTitle}</div>
                      <p className="ui-small ui-muted">{copy.flow.emptyBody}</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button variant="primary" onClick={() => addNode(nodeFor({ kind: "input", type: "rows" }, { x: 0, y: 0 })!)}>
                          {copy.flow.emptyStart}
                        </Button>
                        <ButtonLink href="/">{copy.flow.emptyRequest}</ButtonLink>
                      </div>
                    </div>
                  </div>
                ) : null
              }
            />
          ) : (
            <div className="h-full overflow-y-auto">
              <FlowListView flow={flow} ctx={ctx} run={lastRun} selectedId={selection?.kind === "node" ? selection.id : undefined} onSelect={(id) => setSelection({ kind: "node", id })} />
            </div>
          )}
        </main>
        <aside className="w-80 shrink-0 overflow-y-auto pl-1">
          <FlowInspector
            flow={flow}
            ctx={ctx}
            selection={selection}
            picked={picked}
            onPick={(nodeId, value) => setPicked((p) => ({ ...p, [nodeId]: value }))}
            onChange={setFlow}
            onUpdateNode={(id) => setFlow((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id && n.kind === "routine" && updates[id] ? { ...n, routineVersion: updates[id] } : n)) }))}
            onMakeCompatible={makeCompatible}
            onInsertConverter={insertConverter}
            onRemove={remove}
          />
          <p className="ui-small ui-muted pt-4">
            {copy.library.flowNodes(routineCount)} · {copy.routine.cost(flow.createdWithAiCalls)}
          </p>
        </aside>
      </div>
      {menu && (
        <AddNodeMenu at={menu.at} spec={menu.from.view.spec} what={describeSpec(menu.from.view.spec)} routines={all} onPick={onPickChoice} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function FlowScreen() {
  const id = useSearchParams().get("id");
  const [state, setState] = useState<{ flow: Flow | null; routines: { mine: Routine[]; starters: Routine[] } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const api = doppel();
    Promise.all([api.getFlow(id), api.listRoutines(), api.listStarterRoutines()])
      .then(([flow, mine, starters]) => setState({ flow, routines: { mine, starters } }))
      .catch((e) => setError((e as Error).message));
  }, [id]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!state) return <Loading />;
  if (!state.flow) return <EmptyState title={copy.common.notFound} action={<ButtonLink href="/routines?tab=flows">{copy.nav.library}</ButtonLink>} />;
  return <FlowEditor key={state.flow.id} initial={state.flow} routines={state.routines} />;
}

export default function FlowPage() {
  return (
    <Suspense fallback={<Loading />}>
      <FlowScreen />
    </Suspense>
  );
}

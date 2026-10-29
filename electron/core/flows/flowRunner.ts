import fs from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { topoOrder } from "../../shared/flowGraph";
import { countLabel, isListType } from "../../shared/ports";
import type { DesignAppAdapter } from "../../adapters/types";
import type { AppId, EdgeProgress, Flow, FlowIssue, FlowNode, InputValue, MatchRule, NodeProgress, ParamValue, Routine, RuleFinding, RunOutput, StageItemProgress } from "../types";
import { errorMessage } from "../util";
import { type AdapterSource, type FailureInfo, type ItemRecord, NodeRunner } from "./nodeRunner";
import { type FlowRoutines, routineOf, sourceSpec, validateFlow } from "./validateFlow";
import { InputValueError, type PortValue, adaptValue, countOf, resolveInput } from "./values";

// Runs a flow: nodes in topological order (one at a time; apps are single-instance). Every node works in its own
// folder (runs/<runId>/<nodeId>/) and later nodes read from there; "Save to folder" nodes copy the results to the
// folder the designer picked. A failed item is left out of everything after it, with its reason; the other
// items go on. Cancel stops between items, and what was finished stays in the run folder.

export class FlowInvalidError extends Error {
  constructor(readonly issues: FlowIssue[]) {
    super(issues.map((i) => i.message).join(" "));
  }
}

export interface FlowRunSpec {
  runId: string;
  flow: Flow;
  info: FlowRoutines;
  /** Per input node: what was picked. */
  inputs: Record<string, InputValue>;
  /** Per input node: columns the designer picked for ones Doppl couldn't find (expected name → the file's column). */
  columns?: Record<string, Record<string, string>>;
  /** Per output node: where to save. Without a folder, the files stay in the run folder. */
  outputFolders: Record<string, string>;
  /** Per app: the document routines with a document input work on. */
  documents: Partial<Record<AppId, string>>;
  target: "copy" | "original" | "trial";
  /** runs/<runId>/ */
  runDir: string;
  copiesDir: string;
  isCancelled: () => boolean;
  /** Only these items (running failed items again). */
  onlyItems?: Set<string>;
  /** Only this item of the lists picked for the flow (trials). */
  sampleIndex?: number;
  /** Dev panel: forced failures per routine node. */
  forceFail?: Record<string, { node?: boolean; items?: number[] }>;
  /** Quality checks on a routine node's outputs, right after it ran. */
  checkNode?: (nodeId: string, routine: Routine, outputs: RunOutput[], findings: RuleFinding[]) => Promise<void>;
}

export interface FlowRunHooks {
  onProgress: (nodes: NodeProgress[], edges: EdgeProgress[], phase: string) => void;
  onOutputs: (outputs: RunOutput[]) => void;
}

export interface FlowRunResult {
  status: "succeeded" | "partial" | "failed" | "cancelled";
  nodes: NodeProgress[];
  edges: EdgeProgress[];
  outputs: RunOutput[];
  findings: RuleFinding[];
  /** Per node, per port: what it produced. */
  values: Record<string, Record<string, PortValue>>;
  /** Per routine node: what happened to each item. */
  items: Record<string, ItemRecord[]>;
  log: string[];
  error?: string;
}

/** The name a node shows in a run. */
export function nodeName(node: FlowNode, routine: Routine | undefined): string {
  if (node.kind === "routine") return routine?.name ?? "Missing routine";
  return node.port.label;
}

/** A file name that isn't taken in the folder yet ("label.png", "label-2.png", …). */
async function freeName(folder: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

const safeName = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").trim() || "result";

export class FlowRunner {
  private readonly nodes: NodeRunner;

  constructor(private readonly adapters: AdapterSource) {
    this.nodes = new NodeRunner(adapters);
  }

  async run(spec: FlowRunSpec, hooks: FlowRunHooks): Promise<FlowRunResult> {
    const { flow, info } = spec;
    const validation = validateFlow(flow, info);
    if (!validation.ok) throw new FlowInvalidError(validation.issues);

    const { order } = topoOrder(
      flow.nodes.map((n) => n.id),
      flow.edges,
    );
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const progress: NodeProgress[] = order.map((id) => {
      const node = byId.get(id)!;
      const routine = node.kind === "routine" ? routineOf(info, id) : undefined;
      return { nodeId: id, kind: node.kind, name: nodeName(node, routine), appId: routine?.appId, status: "pending", total: 0, done: 0, failed: 0, items: [] };
    });
    const progressOf = (id: string) => progress.find((p) => p.nodeId === id)!;
    const edges: EdgeProgress[] = [];
    const outputs: RunOutput[] = [];
    const findings: RuleFinding[] = [];
    const values: Record<string, Record<string, PortValue>> = {};
    const items: Record<string, ItemRecord[]> = {};
    const log: string[] = [];
    const failed = new Map<string, FailureInfo>();
    const usedAdapters = new Set<DesignAppAdapter>();
    let cancelled = false;
    let phase = "Starting";
    const emit = (text = phase) => {
      phase = text;
      hooks.onProgress(progress, edges, phase);
    };
    const publish = () => hooks.onOutputs(outputs);
    const noteEdges = (nodeId: string) => {
      const node = byId.get(nodeId)!;
      const routine = node.kind === "routine" ? routineOf(info, nodeId) : undefined;
      for (const e of flow.edges.filter((x) => x.from.nodeId === nodeId)) {
        const value = values[nodeId]?.[e.from.port];
        const src = sourceSpec(node, e.from.port, routine);
        const count = countOf(value);
        const entry = { edgeId: e.id, count, label: src ? countLabel(value?.kind === "list" ? { ...src.spec, type: value.type } : src.spec, count) : String(count) };
        const i = edges.findIndex((x) => x.edgeId === e.id);
        if (i >= 0) edges[i] = entry;
        else edges.push(entry);
      }
    };

    try {
      for (const id of order) {
        const node = byId.get(id)!;
        const sp = progressOf(id);
        if (spec.isCancelled()) {
          cancelled = true;
          break;
        }
        if (node.kind === "input") {
          await this.runInput(node, spec, sp, values, failed, outputs);
          noteEdges(id);
          publish();
          emit(`${sp.name} · ${sp.status === "failed" ? "couldn't be read" : "ready"}`);
          continue;
        }
        if (node.kind === "output") {
          await this.runOutput(node, spec, sp, values, outputs);
          publish();
          emit(`${sp.name} · ${sp.status === "done" ? "saved" : "nothing saved"}`);
          continue;
        }

        // A routine node: gather its inputs from the edges into it.
        const routine = routineOf(info, id)!;
        const inputs: Record<string, PortValue | undefined> = {};
        const joins: Record<string, MatchRule> = {};
        const waitingFor: string[] = [];
        for (const port of routine.inputs) {
          const edge = flow.edges.find((e) => e.to.nodeId === id && e.to.port === port.key);
          if (edge) {
            const src = values[edge.from.nodeId]?.[edge.from.port];
            if (src) inputs[port.key] = await adaptValue(src, port);
            else if (port.required) waitingFor.push(progressOf(edge.from.nodeId).name);
            if (edge.match && routine.iterate && port.key !== routine.iterate.input && isListType(port.type)) joins[port.key] = edge.match;
          } else if (node.values?.[port.key] !== undefined) {
            inputs[port.key] = { kind: "value", type: port.type, value: node.values[port.key] };
          } else if (port.type === "document" && spec.documents[routine.appId]) {
            inputs[port.key] = { kind: "value", type: "document", value: spec.documents[routine.appId]! };
          }
        }
        if (waitingFor.length) {
          sp.status = "skipped";
          sp.error = `Skipped: ${[...new Set(waitingFor)].join(", ")} didn't produce what it needs.`;
          emit(`${sp.name} · skipped`);
          continue;
        }
        const docInput = routine.inputs.find((p) => p.type === "document");
        const docValue = docInput ? inputs[docInput.key] : undefined;
        const documentId = docValue?.kind === "value" && docValue.value ? String(docValue.value) : spec.documents[routine.appId];
        const settings: Record<string, ParamValue> = {};
        for (const s of routine.settings) settings[s.key] = (node.settings?.[s.key] ?? s.default ?? null) as ParamValue;
        const allowedFolders = routine.inputs
          .filter((p) => p.type === "folder")
          .map((p) => inputs[p.key])
          .filter((v): v is Extract<PortValue, { kind: "value" }> => v?.kind === "value" && typeof v.value === "string")
          .map((v) => String(v.value));
        usedAdapters.add(this.adapters.get(routine.appId));
        // A sample run takes one item of the lists picked for the flow; what follows has only that item already.
        const iterEdge = routine.iterate ? flow.edges.find((e) => e.to.nodeId === id && e.to.port === routine.iterate!.input) : undefined;
        const fromInput = !!iterEdge && byId.get(iterEdge.from.nodeId)?.kind === "input";
        const res = await this.nodes.run(
          {
            runId: spec.runId,
            nodeId: id,
            name: sp.name,
            routine,
            inputs,
            joins,
            settings,
            documentId,
            target: spec.target,
            workDir: path.join(spec.runDir, id),
            copiesDir: spec.copiesDir,
            allowedFolders,
            isCancelled: spec.isCancelled,
            failed,
            sampleIndex: fromInput ? spec.sampleIndex : undefined,
            onlyItems: spec.onlyItems,
            forceFail: spec.forceFail?.[id],
          },
          {
            onProgress: (p, text) => {
              Object.assign(sp, p);
              emit(text);
            },
            onOutputs: (mine) => {
              outputs.splice(0, outputs.length, ...outputs.filter((o) => o.node !== id), ...mine);
              publish();
            },
          },
        );
        Object.assign(sp, res.progress);
        values[id] = res.values;
        items[id] = res.items;
        log.push(...res.log);
        findings.push(...res.findings);
        outputs.splice(0, outputs.length, ...outputs.filter((o) => o.node !== id), ...res.outputs);
        noteEdges(id);
        if (res.cancelled) {
          cancelled = true;
          break;
        }
        if (spec.checkNode && res.outputs.length) {
          emit(`${sp.name} · checking quality`);
          await spec.checkNode(id, routine, res.outputs, res.findings);
        }
        publish();
        emit(`${sp.name} · finished`);
      }
    } finally {
      for (const adapter of usedAdapters) await adapter.endRun?.(spec.runId).catch(() => undefined);
    }

    for (const sp of progress) if (sp.status === "pending") sp.status = cancelled ? "skipped" : sp.status;
    const anyFailed = progress.some((p) => p.failed > 0 || p.status === "failed" || (p.kind === "routine" && p.status === "skipped" && !!p.error));
    const anyDone = progress.some((p) => p.kind === "routine" && p.done > 0);
    const status: FlowRunResult["status"] = cancelled ? "cancelled" : !anyFailed ? "succeeded" : anyDone ? "partial" : "failed";
    emit(status === "cancelled" ? "Cancelled" : "Finished");
    const firstError = progress.find((p) => p.error && p.status === "failed")?.error ?? outputs.find((o) => o.status === "failed")?.error;
    return { status, nodes: progress, edges, outputs, findings, values, items, log, error: status === "failed" ? firstError : undefined };
  }

  /** Reads what was picked for an input node; rows with errors fail here, the rest go on. */
  private async runInput(
    node: Extract<FlowNode, { kind: "input" }>,
    spec: FlowRunSpec,
    sp: NodeProgress,
    values: Record<string, Record<string, PortValue>>,
    failed: Map<string, FailureInfo>,
    outputs: RunOutput[],
  ) {
    // Data rows must have the columns every routine they feed relies on.
    const columns = new Set(node.port.columns ?? []);
    const uses = new Set(node.port.uses ?? []);
    for (const e of spec.flow.edges.filter((x) => x.from.nodeId === node.id)) {
      const port = routineOf(spec.info, e.to.nodeId)?.inputs.find((p) => p.key === e.to.port);
      if (port?.type === "rows") {
        for (const c of port.columns ?? []) columns.add(c);
        for (const c of port.uses ?? []) uses.add(c);
      }
    }
    let resolved;
    try {
      resolved = await resolveInput(node.port.type === "rows" ? { ...node.port, columns: [...columns], uses: [...uses] } : node.port, spec.inputs[node.id], { aliases: spec.columns?.[node.id] });
    } catch (err) {
      sp.status = "failed";
      sp.error = err instanceof InputValueError ? err.message : errorMessage(err);
      return;
    }
    if (!resolved.value) {
      sp.status = node.port.required && spec.flow.edges.some((e) => e.from.nodeId === node.id) ? "failed" : "skipped";
      sp.error = sp.status === "failed" ? `Nothing was picked for “${node.port.label}”.` : undefined;
      return;
    }
    let value = resolved.value;
    if (value.kind === "list" && spec.onlyItems) {
      const only = spec.onlyItems;
      value = { ...value, items: value.items.filter((i) => only.has(i.key) || [...only].some((k) => i.key.startsWith(`${k}-`))) };
    }
    values[node.id] = { [node.port.key]: value };
    // Rows with problems fail here (not in a sample run, which only takes one item).
    const problems = spec.sampleIndex !== undefined ? [] : resolved.problems.filter((p) => !spec.onlyItems || spec.onlyItems.has(p.key));
    const list: StageItemProgress[] = value.kind === "list" ? value.items.map((i) => ({ key: i.key, label: i.label, status: "done" })) : [];
    for (const p of problems) {
      list.push({ key: p.key, label: p.label, status: "failed", error: p.error });
      failed.set(p.key, { node: sp.name, reason: p.error });
      outputs.push({ id: `${node.id}:${p.key}`, label: p.label, status: "failed", error: p.error, node: node.id, itemKey: p.key, itemLabel: p.label });
    }
    sp.items = list;
    sp.total = value.kind === "list" ? list.length : 1;
    sp.done = value.kind === "list" ? value.items.length : 1;
    sp.failed = problems.length;
    sp.status = problems.length ? "partial" : "done";
  }

  /** Copies what reaches a "Save to folder" node into the picked folder (files never overwrite each other). */
  private async runOutput(
    node: Extract<FlowNode, { kind: "output" }>,
    spec: FlowRunSpec,
    sp: NodeProgress,
    values: Record<string, Record<string, PortValue>>,
    outputs: RunOutput[],
  ) {
    const edge = spec.flow.edges.find((e) => e.to.nodeId === node.id);
    const value = edge ? values[edge.from.nodeId]?.[edge.from.port] : undefined;
    const folder = spec.outputFolders[node.id];
    if (!value || countOf(value) === 0) {
      sp.status = "skipped";
      sp.note = "Nothing reached this node to save.";
      return;
    }
    if (!folder) {
      sp.status = "skipped";
      sp.note = "No folder picked: the results stay in the run folder.";
      return;
    }
    sp.status = "running";
    try {
      await fs.mkdir(folder, { recursive: true });
      const saved: { key: string; label: string; file: string; from?: string }[] = [];
      const copy = async (from: string, key: string) => {
        const to = await freeName(folder, path.basename(from));
        await fs.copyFile(from, to);
        saved.push({ key, label: path.basename(to), file: to, from });
      };
      if (value.kind === "list" && value.type === "fileList") {
        for (const item of value.items) await copy(String(item.value), item.key);
      } else if (value.kind === "list") {
        const to = await freeName(folder, `${safeName(node.port.label)}.csv`);
        await fs.writeFile(to, Papa.unparse(value.items.map((i) => i.value as Record<string, unknown>), { columns: value.columns }), "utf8");
        saved.push({ key: "rows", label: path.basename(to), file: to });
      } else if (value.type === "file" && typeof value.value === "string") {
        await copy(value.value, "file");
      } else if (value.type === "folder" && typeof value.value === "string") {
        for (const name of await fs.readdir(value.value)) {
          const from = path.join(value.value, name);
          if ((await fs.stat(from)).isFile() && !name.startsWith(".")) await copy(from, `file-${name}`);
        }
      } else {
        const to = await freeName(folder, `${safeName(node.port.label)}.txt`);
        await fs.writeFile(to, String(value.value ?? ""), "utf8");
        saved.push({ key: "value", label: path.basename(to), file: to });
      }
      sp.items = saved.map((s) => ({ key: s.key, label: s.label, status: "done" }));
      sp.total = sp.done = saved.length;
      sp.status = "done";
      sp.documentName = folder;
      for (const s of saved) {
        // A copy looks like the file it copied: reuse that output's preview.
        const preview = s.from ? outputs.find((o) => o.filePath === s.from && o.preview)?.preview : undefined;
        outputs.push({ id: `${node.id}:${s.label}`, label: s.label, status: "done", filePath: s.file, preview, node: node.id, itemKey: s.key, itemLabel: s.label });
      }
    } catch (err) {
      sp.status = "failed";
      sp.error = `Couldn't save to ${path.basename(folder)}: ${errorMessage(err)}`;
    }
  }
}

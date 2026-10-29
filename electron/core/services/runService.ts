import { shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { FigmaApiError } from "../../adapters/figma/figmaRest";
import { PluginNotConnectedError } from "../../adapters/figma/pluginBridge";
import { BridgeError } from "../../adapters/adobe/bridge";
import type { AdapterRegistry } from "../../adapters/registry";
import { AiError } from "./aiTransport";
import type { AiAccessService } from "./aiAccessService";
import type {
  AppId,
  DevFlowOptions,
  Flow,
  PreflightReport,
  InputValue,
  MatchRule,
  QcOptions,
  ReadinessItem,
  Routine,
  Run,
  RunRequest,
  RunSetup,
  RunSummary,
  RunTarget,
} from "../types";
import { CancelledError, errorMessage, newId, nowIso, plural } from "../util";
import { FlowInvalidError, FlowRunner } from "../flows/flowRunner";
import { simulatedApps } from "../flows/mockAdapters";
import type { AdapterSource } from "../flows/nodeRunner";
import { checkReadiness } from "../flows/readiness";
import { preflight } from "../inputs/preflight";
import { type FlowRoutines, routineOf, validateFlow } from "../flows/validateFlow";
import type { AppStatusService } from "./appStatusService";
import { ROUTINE_NODE, type FlowService, routineFlow } from "./flowService";
import type { LibraryService } from "./libraryService";
import type { QcService } from "./qcService";
import type { Storage } from "./storage";

export const DEFAULT_QC_OPTIONS: QcOptions = { minPpiPrint: 300, minPpiWeb: 150 };

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly kind: "app-not-connected" | "plugin-not-connected" | "no-document" | "validation" | "needs-flow" | "generic" = "generic",
    /** The routine itself failed (the error can be sent back to the model for a fix). */
    readonly scriptFailure = false,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export function toExecutionError(err: unknown, appName: string): Error {
  if (err instanceof CancelledError || err instanceof ExecutionError || err instanceof AiError) return err;
  if (err instanceof PluginNotConnectedError) return new ExecutionError(err.message, undefined, "plugin-not-connected");
  if (err instanceof FigmaApiError) return new ExecutionError(err.message, undefined, err.status === 401 ? "app-not-connected" : "generic");
  if (err instanceof BridgeError) {
    switch (err.kind) {
      case "permission-denied":
        return new ExecutionError(err.message, err.detail, "app-not-connected");
      case "not-running":
        return new ExecutionError(`${appName} isn't running.`, err.detail, "app-not-connected");
      case "timeout":
        return new ExecutionError(err.message);
      case "script":
        if (/document is open|isn't open/i.test(err.message)) return new ExecutionError(err.message, undefined, "no-document");
        return new ExecutionError("This routine couldn't finish on this document.", `${err.message}${err.line ? ` (script line ${err.line})` : ""}`, "generic", true);
      default:
        return new ExecutionError(`Doppl couldn't talk to ${appName}.`, err.detail);
    }
  }
  return new ExecutionError(`This routine couldn't finish in ${appName}.`, errorMessage(err), "generic", true);
}

/** Flow node id → the routine it runs. */
const routinesOfNodes = (flow: Flow): Record<string, string> =>
  Object.fromEntries(flow.nodes.flatMap((n) => (n.kind === "routine" ? [[n.id, n.routineId]] : [])));

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** "products.csv · 6 files · photos": what a run was given, for run history. */
export function summarizeInputs(flow: Flow, inputs: Record<string, InputValue>): string {
  const parts: string[] = [];
  for (const node of flow.nodes) {
    if (node.kind !== "input") continue;
    const v = inputs[node.id];
    if (isEmpty(v)) continue;
    if (Array.isArray(v)) parts.push(plural(v.length, "file"));
    else if (typeof v === "string" && v.startsWith("/")) parts.push(path.basename(v));
    else if (typeof v === "boolean") parts.push(`${node.port.label}: ${v ? "yes" : "no"}`);
    else parts.push(String(v));
  }
  const text = parts.join(" · ");
  return text.length > 90 ? `${text.slice(0, 87)}…` : text || "No inputs";
}

export function summarizeRun(run: Run, flow: Flow): RunSummary {
  const done = run.outputs.filter((o) => o.status === "done");
  const checked = done.some((o) => o.qc);
  const flaggedCount = done.filter((o) => o.qc?.status === "flagged" && !o.markedOk).length;
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    inputsSummary: summarizeInputs(flow, run.inputs),
    qcStatus: !checked ? "not-checked" : flaggedCount > 0 ? "flagged" : "pass",
    outputCount: run.outputs.length,
    flaggedCount,
    aiCalls: run.aiCalls,
    routineVersion: run.version,
  };
}

interface ActiveRun {
  run: Run;
  cancelled: boolean;
}

/** Runs of routines and flows. A routine runs as a flow of one node; either way a run uses no AI unless AI review is on. */
export class RunService {
  private active = new Map<string, ActiveRun>();

  constructor(
    private readonly deps: {
      storage: Storage;
      library: LibraryService;
      flows: FlowService;
      registry: AdapterRegistry;
      apps: AppStatusService;
      qc: QcService;
      access: AiAccessService;
      emit: (run: Run) => void;
      /** userData/runs: each run keeps its node folders in runs/<runId>/. */
      runsDir: string;
      copiesDir: string;
      /** A run finished (not simulated): building block evidence, by the routine each node ran. */
      onRunFinished?: (run: Run, routineOfNode: Record<string, string>) => void;
      /** "Mark as OK" on an output of these routines. */
      onFeedback?: (routineIds: string[], kind: "ok") => void;
    },
  ) {}

  private scope = (target: RunTarget) => `${target.kind}:${target.id}`;

  /** The flow to run with its pinned routines: a flow, or a routine as a one-node flow. */
  private async resolve(target: RunTarget, matches?: Record<string, MatchRule>): Promise<{ flow: Flow; info: FlowRoutines; routine?: Routine }> {
    if (target.kind === "routine") {
      const routine = await this.deps.library.require(target.id);
      const info: FlowRoutines = {
        routines: { [ROUTINE_NODE]: routine },
        stageKind: (appId) => (this.deps.registry.list().some((a) => a.id === appId) ? this.deps.registry.get(appId).stageKind : null),
      };
      return { flow: routineFlow(routine, matches), info, routine };
    }
    // A flow run can pair differently than the flow saves (files picked by hand on the Run page): per connection.
    const saved = await this.deps.flows.require(target.id);
    const flow = matches && Object.keys(matches).length ? { ...saved, edges: saved.edges.map((e) => (matches[e.id] ? { ...e, match: matches[e.id] } : e)) } : saved;
    return { flow, info: await this.deps.flows.routinesOf(flow) };
  }

  /** The check before a run: the picked inputs read as the run will read them (see inputs/preflight). */
  async preflight(target: RunTarget, request: Pick<RunRequest, "inputs" | "matches" | "columns">): Promise<PreflightReport> {
    const { flow, info } = await this.resolve(target, request.matches);
    return preflight(flow, info, request.inputs, request.columns ?? {});
  }

  async setup(target: RunTarget): Promise<RunSetup> {
    const last = await this.deps.storage.getLastValues(this.scope(target));
    const { flow, info, routine } = await this.resolve(target, last?.matches);
    const routines: RunSetup["routines"] = {};
    for (const n of flow.nodes) if (n.kind === "routine" && routineOf(info, n.id)) routines[n.id] = routineOf(info, n.id)!;
    return {
      target,
      name: flow.name,
      version: flow.version,
      flow,
      routines,
      settings: routine?.settings ?? [],
      last: { inputs: last?.inputs ?? {}, outputFolders: last?.outputFolders ?? {}, settings: last?.settings ?? {}, matches: last?.matches ?? {}, columns: last?.columns ?? {} },
      issues: validateFlow(flow, info).issues,
    };
  }

  /** Values picked for inputs outside a run (the flow editor), kept for the next run on this Mac. */
  async rememberInputs(target: RunTarget, inputs: Record<string, InputValue>) {
    const last = await this.deps.storage.getLastValues(this.scope(target));
    await this.deps.storage.saveLastValues(this.scope(target), {
      inputs: { ...(last?.inputs ?? {}), ...inputs },
      outputFolders: last?.outputFolders ?? {},
      settings: last?.settings ?? {},
      matches: last?.matches ?? {},
      documents: last?.documents,
    });
  }

  /** Per app: connected, with the document routines with a document input work on. */
  async readiness(target: RunTarget, documents: Partial<Record<AppId, string>> = {}, adapters?: AdapterSource & { list(): { id: AppId }[] }): Promise<ReadinessItem[]> {
    const { flow, info } = await this.resolve(target);
    const units = flow.nodes.flatMap((n) => {
      const r = n.kind === "routine" ? routineOf(info, n.id) : undefined;
      if (!r) return [];
      const docPort = r.inputs.find((p) => p.type === "document");
      const docConnected = docPort && flow.edges.some((e) => e.to.nodeId === n.id && e.to.port === docPort.key);
      return [{ appId: r.appId, name: r.name, needsDocument: !!docPort && !docConnected }];
    });
    const source = adapters ?? this.deps.registry;
    return checkReadiness(source, adapters ? { statusOf: async () => "connected" as const } : this.deps.apps, units, documents);
  }

  async start(target: RunTarget, request: RunRequest, opts: { onlyItems?: Set<string>; dev?: DevFlowOptions } = {}): Promise<Run> {
    const { storage } = this.deps;
    const { flow, info, routine } = await this.resolve(target, request.matches);
    if (routine) {
      const node = flow.nodes.find((n) => n.id === ROUTINE_NODE);
      if (node?.kind === "routine") node.settings = { ...(request.settings ?? {}) };
    }
    const validation = validateFlow(flow, info);
    if (!validation.ok) throw new Error(validation.issues.map((i) => i.message).join(" "));
    if (request.qcMode === "auto_ai" && this.deps.access.provider() !== "meta-api") {
      throw new Error("AI review isn't included in demo access. Choose Automatic check, or use your own Meta API key in Settings.");
    }
    const mocked = !!opts.dev?.mocked;
    // Inputs that feed something must be picked; flows save to the folders their output nodes name.
    const missing = flow.nodes.filter(
      (n) => n.kind === "input" && n.port.required && flow.edges.some((e) => e.from.nodeId === n.id) && isEmpty(request.inputs[n.id]) && !mocked,
    );
    if (missing.length) throw new Error(`Pick ${missing.map((n) => (n.kind === "input" ? `“${n.port.label}”` : "")).join(", ")} first.`);
    if (target.kind === "flow" && !mocked) {
      const noFolder = flow.nodes.filter((n) => n.kind === "output" && flow.edges.some((e) => e.to.nodeId === n.id) && !request.outputFolders[n.id]);
      if (noFolder.length) throw new Error(`Pick a folder for ${noFolder.map((n) => (n.kind === "output" ? `“${n.port.label}”` : "")).join(", ")}.`);
    }

    const adapters = mocked ? simulatedApps(this.deps.registry) : this.deps.registry;
    const readiness = await this.readiness(target, request.options.documents ?? {}, mocked ? simulatedApps(this.deps.registry, 0) : undefined);
    const blocked = readiness.filter((r) => !r.ok);
    if (blocked.length) throw new Error(blocked.map((r) => `${r.appName}: ${r.message}`).join(" "));
    const documents = Object.fromEntries(readiness.filter((r) => r.documentId).map((r) => [r.appId, r.documentId!]));
    const inputs = mocked ? await this.simulatedInputs(flow, info, request.inputs) : request.inputs;

    const id = newId();
    const run: Run = {
      id,
      target,
      name: flow.name,
      version: flow.version,
      appIds: [...new Set(readiness.map((r) => r.appId))],
      inputs,
      outputFolders: request.outputFolders,
      ...(routine ? { settings: request.settings ?? {} } : {}),
      ...(request.matches && Object.keys(request.matches).length ? { matches: request.matches } : {}),
      ...(request.columns && Object.keys(request.columns).length ? { columns: request.columns } : {}),
      qcMode: request.qcMode,
      options: { ...request.options, documents, qcOptions: request.options.qcOptions ?? DEFAULT_QC_OPTIONS },
      status: "running",
      aiCalls: 0,
      outputs: [],
      startedAt: nowIso(),
      phase: "Starting",
      nodes: [],
      edges: [],
      workDir: path.join(this.deps.runsDir, id),
      ...(opts.onlyItems ? { onlyItems: [...opts.onlyItems] } : {}),
      ...(mocked ? { mocked: true } : {}),
    };
    if (!mocked) {
      const last = await storage.getLastValues(this.scope(target));
      await storage.saveLastValues(this.scope(target), {
        inputs: request.inputs,
        outputFolders: request.outputFolders,
        settings: request.settings ?? {},
        matches: request.matches ?? {},
        columns: { ...(last?.columns ?? {}), ...(request.columns ?? {}) },
        documents,
      });
    }
    await storage.saveRun(run);
    this.active.set(run.id, { run, cancelled: false });
    void this.execute(run, flow, info, adapters, opts);
    return run;
  }

  /** Dev panel: placeholder values for inputs nothing was picked for (three rows, three files…). */
  private async simulatedInputs(flow: Flow, info: FlowRoutines, picked: Record<string, InputValue>): Promise<Record<string, InputValue>> {
    const out = { ...picked };
    const dir = path.join(this.deps.runsDir, "simulated-inputs");
    await fs.mkdir(dir, { recursive: true });
    for (const n of flow.nodes) {
      if (n.kind !== "input" || !isEmpty(out[n.id])) continue;
      const p = n.port;
      const ext = p.extensions?.[0] ?? "png";
      if (p.type === "rows") {
        // The columns the routines it feeds need, so the sample rows fit them.
        const needed = new Set(p.columns ?? []);
        for (const e of flow.edges.filter((x) => x.from.nodeId === n.id)) {
          for (const c of routineOf(info, e.to.nodeId)?.inputs.find((x) => x.key === e.to.port)?.columns ?? []) needed.add(c);
        }
        const columns = needed.size ? [...needed] : ["name", "file"];
        const csv = [columns.join(","), ...[1, 2, 3].map((i) => columns.map((c) => (/(file|image|photo|cutout)/i.test(c) ? `item-${i}.png` : `${c} ${i}`)).join(","))].join("\n");
        const file = path.join(dir, `${p.key}.csv`);
        await fs.writeFile(file, csv, "utf8");
        out[n.id] = file;
      } else if (p.type === "fileList" || p.type === "file") {
        const files = [1, 2, 3].map((i) => path.join(dir, `item-${i}.${ext}`));
        for (const f of files) await fs.writeFile(f, `Simulated input ${path.basename(f)}\n`);
        out[n.id] = p.type === "file" ? files[0] : files;
      } else if (p.type === "folder") out[n.id] = dir;
      else if (p.type === "number") out[n.id] = 1;
      else if (p.type === "boolean") out[n.id] = false;
      else out[n.id] = "sample";
    }
    return out;
  }

  private async execute(run: Run, flow: Flow, info: FlowRoutines, adapters: AdapterSource, opts: { onlyItems?: Set<string>; dev?: DevFlowOptions }) {
    const entry = this.active.get(run.id)!;
    const emit = () => this.deps.emit(run);
    const ctx = { onAiCall: () => (run.aiCalls += 1), isCancelled: () => entry.cancelled };
    const forceFail = opts.dev
      ? Object.fromEntries(
          flow.nodes
            .filter((n) => n.kind === "routine")
            .map((n) => [n.id, { node: opts.dev!.failNodes.includes(n.id), items: opts.dev!.failItems[n.id] ?? [] }]),
        )
      : undefined;
    try {
      const res = await new FlowRunner(adapters).run(
        {
          runId: run.id,
          flow,
          info,
          inputs: run.inputs,
          ...(run.columns ? { columns: run.columns } : {}),
          outputFolders: run.outputFolders,
          documents: run.options.documents ?? {},
          target: run.options.target,
          runDir: run.workDir!,
          copiesDir: this.deps.copiesDir,
          isCancelled: () => entry.cancelled,
          onlyItems: opts.onlyItems,
          forceFail,
          checkNode: async (_nodeId, routine, outputs, findings) => {
            const adapter = adapters.get(routine.appId);
            const subject = { qcMode: run.qcMode, qcOptions: run.options.qcOptions ?? DEFAULT_QC_OPTIONS, qcProfile: routine.qcProfile, builtInQc: routine.builtInQc };
            const ids = new Set(outputs.map((o) => o.id));
            await this.deps.qc.evaluate(adapter, subject, outputs, run.qcMode === "manual" ? null : findings.filter((f) => f.outputKey && ids.has(f.outputKey)), ctx);
            if (run.qcMode === "auto_ai" && routine.objectChecks?.length) await this.deps.qc.objectChecks(outputs, routine.objectChecks, ctx);
          },
        },
        {
          onProgress: (nodes, edges, phase) => {
            run.nodes = nodes.map((n) => ({ ...n, items: [...n.items] }));
            run.edges = [...edges];
            if (!entry.cancelled) run.phase = phase;
            emit();
          },
          onOutputs: (outputs) => {
            run.outputs = [...outputs];
            emit();
          },
        },
      );
      run.nodes = res.nodes;
      run.edges = res.edges;
      run.outputs = res.outputs;
      run.log = res.log;
      run.findings = res.findings;
      run.status = entry.cancelled ? "cancelled" : res.status;
      if (res.status === "failed") {
        run.error = run.target.kind === "flow" ? "This flow couldn't finish." : "This routine couldn't finish.";
        run.errorDetail = res.error;
      }
    } catch (err) {
      if (err instanceof CancelledError || entry.cancelled) {
        run.status = "cancelled";
      } else {
        run.status = "failed";
        run.error = err instanceof FlowInvalidError ? "This flow isn't ready to run." : run.target.kind === "flow" ? "This flow couldn't finish." : "This routine couldn't finish.";
        run.errorDetail = errorMessage(err);
      }
    } finally {
      run.phase = undefined;
      run.finishedAt = nowIso();
      this.active.delete(run.id);
      await this.persist(run, flow);
      emit();
      if (!run.mocked && run.status !== "cancelled") this.deps.onRunFinished?.(run, routinesOfNodes(flow));
    }
  }

  /** Saves the run and adds it to the history of its routine or flow. */
  private async persist(run: Run, flow?: Flow) {
    const { storage } = this.deps;
    await storage.saveRun(run);
    if (run.mocked) return;
    if (run.target.kind === "flow") {
      const stored = await storage.getFlow(run.target.id);
      if (!stored) return;
      stored.runs = [summarizeRun(run, flow ?? stored), ...stored.runs.filter((r) => r.id !== run.id)];
      await storage.saveFlow(stored);
    } else {
      const routine = await storage.getRoutine(run.target.id);
      if (!routine) return;
      routine.runs = [summarizeRun(run, flow ?? routineFlow(routine)), ...routine.runs.filter((r) => r.id !== run.id)];
      await storage.saveRoutine(routine);
    }
  }

  async cancel(runId: string) {
    const entry = this.active.get(runId);
    if (!entry) return;
    entry.cancelled = true;
    entry.run.phase = "Cancelling after the current item…";
    this.deps.emit(entry.run);
  }

  async get(runId: string): Promise<Run | null> {
    const active = this.active.get(runId)?.run;
    if (active) return active;
    const run = await this.deps.storage.getRun(runId);
    if (run) this.fillPreviews(run);
    return run;
  }

  private filling = new Set<string>();

  /** Runs made while previews of saved files weren't rendered: renders them once, emitting as each arrives. */
  private fillPreviews(run: Run) {
    const missing = run.outputs.filter((o) => o.status === "done" && o.filePath && !o.preview);
    if (run.mocked || !missing.length || this.filling.has(run.id) || !run.appIds.length) return;
    const adapter = this.deps.registry.list().find((a) => a.id === run.appIds[0]);
    if (!adapter) return;
    this.filling.add(run.id);
    void (async () => {
      let filled = 0;
      for (const o of missing) {
        o.preview = await adapter.renderPreview(`file:${o.filePath}`).catch(() => undefined);
        if (o.preview) {
          filled++;
          this.deps.emit(run);
        }
      }
      if (filled) await this.deps.storage.saveRun(run).catch(() => undefined);
    })().finally(() => this.filling.delete(run.id));
  }

  private async requireRun(runId: string) {
    const run = await this.get(runId);
    if (!run) throw new Error("This run doesn't exist anymore.");
    return run;
  }

  /** A new run with only the items that failed (everything again when no single item failed). */
  async retryFailed(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    if (run.status === "running") return run;
    const failed = new Set(run.outputs.filter((o) => o.status === "failed" && o.itemKey && o.itemKey !== "all").map((o) => o.itemKey!));
    const request: RunRequest = {
      inputs: run.inputs,
      outputFolders: run.outputFolders,
      settings: run.settings,
      matches: run.matches,
      columns: run.columns,
      qcMode: run.qcMode,
      options: run.options,
    };
    return this.start(run.target, request, { onlyItems: failed.size ? failed : undefined, ...(run.mocked ? { dev: { mocked: true, failNodes: [], failItems: {} } } : {}) });
  }

  async markOutputOk(runId: string, outputId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    const output = run.outputs.find((o) => o.id === outputId);
    if (output) output.markedOk = true;
    await this.persist(run);
    this.deps.emit(run);
    if (output?.node) {
      const flow = run.target.kind === "flow" ? await this.deps.flows.get(run.target.id) : null;
      const routineId = flow ? routinesOfNodes(flow)[output.node] : output.node === ROUTINE_NODE ? run.target.id : undefined;
      if (routineId) this.deps.onFeedback?.([routineId], "ok");
    }
    return run;
  }

  async openOutput(runId: string, outputId: string) {
    const run = await this.requireRun(runId);
    const output = run.outputs.find((o) => o.id === outputId);
    if (!output) return;
    if (output.filePath && !output.nodeId) {
      await shell.openPath(output.filePath);
      return;
    }
    const appId = run.nodes.find((n) => n.nodeId === output.node)?.appId;
    const docId = appId ? run.options.documents?.[appId] : undefined;
    if (appId && docId && !run.mocked) await this.deps.registry.get(appId).openInApp(docId, { pageIndex: output.pageIndex, nodeId: output.nodeId });
  }

  async revealOutput(runId: string, outputId: string) {
    const run = await this.requireRun(runId);
    const output = run.outputs.find((o) => o.id === outputId);
    if (output?.filePath) shell.showItemInFolder(output.filePath);
  }
}

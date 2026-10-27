import { shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../../adapters/indesign/bridge";
import type { AdapterRegistry } from "../../adapters/registry";
import type { AdapterOutput, ScriptResult } from "../../adapters/types";
import { AiError } from "./aiTransport";
import type { AiAccessService } from "./aiAccessService";
import type { DevFlagsStore } from "../mock/devFlags";
import type {
  AppId,
  ParamDef,
  ParamValues,
  QcMode,
  QcOptions,
  Routine,
  RuleFinding,
  Run,
  RunOptions,
  RunOutput,
  RunSummary,
} from "../types";
import { CancelledError, delay, errorMessage, newId, nowIso } from "../util";
import type { AppStatusService } from "./appStatusService";
import type { QcService } from "./qcService";
import type { Storage } from "./storage";

/** Page previews rendered per run; later pages are listed without a preview. */
const MAX_PAGE_PREVIEWS = 24;

export const DEFAULT_QC_OPTIONS: QcOptions = { minPpiPrint: 300, minPpiWeb: 150 };

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly kind: "app-not-connected" | "no-document" | "generic" = "generic",
    /** The routine script itself failed (the error can be sent back to the model for a fix). */
    readonly scriptFailure = false,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export interface ExecutionSpec {
  runId: string;
  appId: AppId;
  routineName: string;
  script: string;
  modifiesDocument: boolean;
  qcProfile: "print" | "web";
  builtInQc?: boolean;
  params: ParamValues;
  qcMode: QcMode;
  qcOptions: QcOptions;
  target: "copy" | "original" | "trial";
  documentId?: string;
  isCancelled: () => boolean;
}

export interface ExecutionHooks {
  onPhase: (phase: string) => void;
  onOutputs: (outputs: RunOutput[]) => void;
  onAiCall: () => void;
  /** Creation screen: switch from "Running" to "Checking result". */
  onStage?: (stage: "run" | "check") => void;
}

export interface ExecutionResult {
  outputs: RunOutput[];
  document?: { id: string; name: string };
  log: string[];
  findings: RuleFinding[] | null;
}

function notConnectedMessage(appName: string, status: string) {
  if (status === "permission-denied") return `Doppel isn't allowed to control ${appName} yet.`;
  if (status === "not-installed") return `${appName} isn't set up for Doppel on this Mac.`;
  return `${appName} isn't running. Open it with your document, then try again.`;
}

export function toExecutionError(err: unknown, appName: string): Error {
  if (err instanceof CancelledError || err instanceof ExecutionError || err instanceof AiError) return err;
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
        return new ExecutionError(
          "This routine couldn't finish on this document.",
          `${err.message}${err.line ? ` (script line ${err.line})` : ""}`,
          "generic",
          true,
        );
      default:
        return new ExecutionError(`Doppel couldn't talk to ${appName}.`, err.detail);
    }
  }
  return new ExecutionError(`Something went wrong while running in ${appName}.`, errorMessage(err));
}

/**
 * Runs a routine script on an adapter, renders previews and runs quality control.
 * Shared by real runs (RunService) and trial runs during creation (RoutineService).
 */
export class RoutineExecutor {
  constructor(
    private readonly deps: {
      registry: AdapterRegistry;
      qc: QcService;
      flags: DevFlagsStore;
      apps: AppStatusService;
      workRoot: string;
      copiesDir: string;
    },
  ) {}

  async execute(spec: ExecutionSpec, hooks: ExecutionHooks): Promise<ExecutionResult> {
    const { registry, qc, flags, apps } = this.deps;
    const adapter = registry.get(spec.appId);
    const speed = flags.get().speed;
    const status = await apps.statusOf(spec.appId);
    if (status !== "connected") throw new ExecutionError(notConnectedMessage(adapter.name, status), undefined, "app-not-connected");

    const workDir = path.join(this.deps.workRoot, spec.runId);
    await fs.mkdir(workDir, { recursive: true });
    const outputs: RunOutput[] = [];
    const upsert = (o: AdapterOutput & { status: RunOutput["status"]; error?: string }) => {
      const existing = outputs.find((x) => x.id === o.key);
      const next: RunOutput = {
        id: o.key,
        label: o.label,
        status: o.status,
        error: o.error,
        preview: o.preview ?? existing?.preview,
        filePath: o.filePath,
        page: o.page,
        pageIndex: o.pageIndex,
        details: o.details,
        profile: o.profile,
      };
      if (existing) Object.assign(existing, next);
      else outputs.push(next);
    };
    const aiCtx = { onAiCall: hooks.onAiCall, isCancelled: spec.isCancelled, speed };
    let result: ScriptResult | undefined;

    try {
      hooks.onStage?.("run");
      hooks.onPhase(`Running in ${adapter.name}`);
      if (spec.target !== "trial" && flags.get().runOutcome === "fail") {
        await delay(1500 * speed, spec.isCancelled);
        throw new ExecutionError(
          "This routine couldn't finish on the new content.",
          "The headline is now inside a group, so the routine couldn't find the text it needs to resize.",
        );
      }

      try {
        result = await adapter.runScript(
          spec.script,
          spec.params,
          (p) => {
            if (p.phase) hooks.onPhase(p.phase);
            if (p.output) {
              upsert(p.output);
              hooks.onOutputs(outputs);
            }
          },
          {
            runId: spec.runId,
            routineName: spec.routineName,
            documentId: spec.documentId,
            target: spec.target,
            workDir,
            copiesDir: this.deps.copiesDir,
            modifiesDocument: spec.modifiesDocument,
            isCancelled: spec.isCancelled,
            speed,
          },
        );
      } catch (err) {
        throw toExecutionError(err, adapter.name);
      }
      if (spec.isCancelled()) throw new CancelledError();

      // Outputs reported by the script, with unique keys.
      const seen = new Set<string>();
      for (const o of result.outputs) {
        let key = o.key || `output-${seen.size + 1}`;
        while (seen.has(key)) key = `${key}-${seen.size}`;
        seen.add(key);
        upsert({ ...o, key, status: o.preview ? "done" : "running" });
      }
      for (const o of outputs.filter((x) => !seen.has(x.id))) outputs.splice(outputs.indexOf(o), 1);
      if (outputs.length === 0) {
        upsert({ key: "document", label: result.document?.name ?? "Document", status: "running" });
      }
      hooks.onOutputs(outputs);

      // Previews: exported files directly, pages through the app.
      const pending = outputs.filter((o) => o.status === "running");
      if (pending.length) hooks.onPhase("Rendering previews");
      for (const o of pending.filter((x) => x.filePath)) {
        o.preview = await adapter.renderPreview(`file:${o.filePath}`).catch(() => undefined);
        o.status = "done";
        hooks.onOutputs(outputs);
      }
      const pageOutputs = pending.filter((x) => !x.filePath);
      const pageIndexes = [...new Set(pageOutputs.map((o) => o.pageIndex ?? 1))].slice(0, MAX_PAGE_PREVIEWS);
      if (pageOutputs.length && result.document) {
        const previews = await adapter.renderPagePreviews(result.document.id, pageIndexes, workDir).catch(() => ({}) as Record<number, never>);
        for (const o of pageOutputs) o.preview = previews[o.pageIndex ?? 1];
      }
      for (const o of pageOutputs) o.status = "done";
      if (spec.isCancelled()) throw new CancelledError();

      // Dev panel: some outputs fail to generate.
      if (spec.target !== "trial" && flags.get().runOutcome === "partial") {
        const picks = outputs.length >= 4 ? [1, outputs.length - 2] : [outputs.length - 1];
        for (const i of picks) {
          Object.assign(outputs[i], {
            status: "failed",
            preview: undefined,
            error: "Couldn't generate this output. The routine stopped before finishing it.",
          });
        }
      }
      hooks.onOutputs(outputs);

      // Quality control
      hooks.onStage?.("check");
      hooks.onPhase(spec.qcMode === "manual" && !spec.builtInQc ? "Finishing" : "Checking quality");
      const subject = this.qcSubject(spec);
      let findings: RuleFinding[] | null = null;
      try {
        findings = await qc.collectFindings(adapter, subject, outputs, result.document?.id, result.data);
      } catch (err) {
        result.log.push(`Rule checks failed: ${errorMessage(err)}`);
      }
      await qc.evaluate(subject, outputs, findings, aiCtx);
      hooks.onOutputs(outputs);
      return { outputs, document: result.document, log: result.log, findings };
    } finally {
      // Trial copies are hidden; copies of read-only routines change nothing, so close them too
      // (the file stays next to the original, and "Open in app" reopens it).
      const closeCopy = spec.target === "trial" || (spec.target === "copy" && !spec.modifiesDocument);
      if (closeCopy && result?.document && result.document.id !== spec.documentId) {
        await adapter.closeDocument(result.document.id).catch(() => undefined);
      }
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  qcSubject(spec: Pick<ExecutionSpec, "appId" | "qcMode" | "qcOptions" | "qcProfile" | "builtInQc" | "params">) {
    const qcOptions = { ...spec.qcOptions };
    // Preflight report checks resolution against its own param.
    const routinePpi = Number(spec.params.minPpi);
    if (spec.builtInQc && routinePpi > 0) qcOptions.minPpiPrint = qcOptions.minPpiWeb = routinePpi;
    return { appId: spec.appId, qcMode: spec.qcMode, qcOptions, qcProfile: spec.qcProfile, builtInQc: spec.builtInQc };
  }
}

// ---------- Runs ----------

function isEmpty(v: unknown) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function summarizeParams(defs: ParamDef[], values: ParamValues): string {
  const parts: string[] = [];
  for (const def of defs) {
    const v = values[def.key];
    if (isEmpty(v)) continue;
    if (def.type === "folder" || def.type === "file") parts.push(path.basename(String(v)));
    else if (def.type === "formatList") parts.push(`${(v as string[]).length} formats`);
    else if (def.type === "boolean") {
      if (v) parts.push(def.label.replace(/\s*\(.*\)$/, ""));
    } else if (def.type === "number") parts.push(`${def.label.replace(/\s*\(.*\)$/, "")}: ${v}`);
    else parts.push(String(v));
  }
  const text = parts.join(" · ");
  return text.length > 90 ? `${text.slice(0, 87)}…` : text || "Default settings";
}

export function summarizeRun(run: Run, routine: Pick<Routine, "params">): RunSummary {
  const done = run.outputs.filter((o) => o.status === "done");
  const checked = done.some((o) => o.qc);
  const flaggedCount = done.filter((o) => o.qc?.status === "flagged" && !o.markedOk).length;
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    inputsSummary: summarizeParams(routine.params, run.params),
    qcStatus: !checked ? "not-checked" : flaggedCount > 0 ? "flagged" : "pass",
    outputCount: run.outputs.length,
    flaggedCount,
    aiCalls: run.aiCalls,
    routineVersion: run.routineVersion,
  };
}

interface ActiveRun {
  run: Run;
  cancelled: boolean;
}

export class RunService {
  private active = new Map<string, ActiveRun>();

  constructor(
    private readonly deps: {
      storage: Storage;
      executor: RoutineExecutor;
      registry: AdapterRegistry;
      qc: QcService;
      flags: DevFlagsStore;
      access: AiAccessService;
      emit: (run: Run) => void;
    },
  ) {}

  async start(routineId: string, params: ParamValues, qcMode: QcMode, options: RunOptions): Promise<Run> {
    const { storage } = this.deps;
    const routine = await storage.getRoutine(routineId);
    if (!routine) throw new Error("This routine doesn't exist anymore.");
    const missing = routine.params.filter((p) => p.required && isEmpty(params[p.key]));
    if (missing.length) throw new Error(`Fill in ${missing.map((p) => p.label).join(", ")} first.`);
    if (qcMode === "auto_ai" && !this.deps.flags.get().mockAi && this.deps.access.provider() !== "meta-api") {
      throw new Error("AI review isn't included in demo access. Choose Automatic check, or use your own Meta API key in Settings.");
    }

    const run: Run = {
      id: newId(),
      routineId,
      routineName: routine.name,
      routineVersion: routine.version,
      appId: routine.appId,
      modifiesDocument: routine.modifiesDocument,
      params,
      qcMode,
      options: { ...options, qcOptions: options.qcOptions ?? DEFAULT_QC_OPTIONS },
      status: "running",
      aiCalls: 0,
      outputs: [],
      startedAt: nowIso(),
      phase: "Starting",
    };
    routine.lastParams = params;
    await storage.saveRoutine(routine);
    await storage.saveRun(run);
    this.active.set(run.id, { run, cancelled: false });
    void this.execute(run, routine);
    return run;
  }

  private async execute(run: Run, routine: Routine) {
    const entry = this.active.get(run.id)!;
    const emit = () => this.deps.emit(run);
    try {
      const res = await this.deps.executor.execute(
        {
          runId: run.id,
          appId: routine.appId,
          routineName: routine.name,
          script: routine.script,
          modifiesDocument: routine.modifiesDocument,
          qcProfile: routine.qcProfile,
          builtInQc: routine.builtInQc,
          params: run.params,
          qcMode: run.qcMode,
          qcOptions: run.options.qcOptions ?? DEFAULT_QC_OPTIONS,
          target: run.options.target,
          documentId: run.options.documentId,
          isCancelled: () => entry.cancelled,
        },
        {
          onPhase: (phase) => {
            if (!entry.cancelled) run.phase = phase;
            emit();
          },
          onOutputs: (outputs) => {
            run.outputs = outputs;
            emit();
          },
          onAiCall: () => {
            run.aiCalls += 1;
            emit();
          },
        },
      );
      run.outputs = res.outputs;
      run.targetDocument = res.document;
      run.log = res.log;
      run.findings = res.findings ?? undefined;
      run.status = res.outputs.some((o) => o.status === "failed") ? "partial" : "succeeded";
    } catch (err) {
      if (err instanceof CancelledError || entry.cancelled) {
        run.status = "cancelled";
      } else {
        run.status = "failed";
        run.error = err instanceof ExecutionError ? err.message : "This routine couldn't finish.";
        run.errorDetail = err instanceof ExecutionError ? err.detail : errorMessage(err);
      }
    } finally {
      run.phase = undefined;
      run.finishedAt = nowIso();
      this.active.delete(run.id);
      await this.persist(run);
      emit();
    }
  }

  private async persist(run: Run) {
    const { storage } = this.deps;
    await storage.saveRun(run);
    const routine = await storage.getRoutine(run.routineId);
    if (!routine) return;
    const summary = summarizeRun(run, routine);
    routine.runs = [summary, ...routine.runs.filter((r) => r.id !== run.id)];
    await storage.saveRoutine(routine);
  }

  async cancel(runId: string) {
    const entry = this.active.get(runId);
    if (!entry) return;
    entry.cancelled = true;
    entry.run.phase = "Cancelling after the current step…";
    this.deps.emit(entry.run);
  }

  async get(runId: string): Promise<Run | null> {
    return this.active.get(runId)?.run ?? (await this.deps.storage.getRun(runId));
  }

  private async requireRun(runId: string) {
    const run = await this.get(runId);
    if (!run) throw new Error("This run doesn't exist anymore.");
    return run;
  }

  async retryFailed(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    if (run.status === "running") return run;
    const routine = await this.deps.storage.getRoutine(run.routineId);
    if (!routine) throw new Error("This routine doesn't exist anymore.");
    const failed = run.outputs.filter((o) => o.status === "failed");
    if (failed.length === 0) return run;

    const entry: ActiveRun = { run, cancelled: false };
    this.active.set(run.id, entry);
    run.status = "running";
    run.phase = "Retrying failed outputs";
    for (const o of failed) Object.assign(o, { status: "running", error: undefined });
    this.deps.emit(run);

    void (async () => {
      const adapter = this.deps.registry.get(run.appId);
      const speed = this.deps.flags.get().speed;
      for (const o of failed) {
        await delay(600 * speed);
        const target = o.filePath
          ? `file:${o.filePath}`
          : o.pageIndex && run.targetDocument
            ? `page:${run.targetDocument.id}#${o.pageIndex}`
            : o.id;
        o.preview = await adapter.renderPreview(target).catch(() => undefined);
        o.status = "done";
        this.deps.emit(run);
      }
      const subject = this.deps.executor.qcSubject({ ...routine, appId: run.appId, qcMode: run.qcMode, qcOptions: run.options.qcOptions ?? DEFAULT_QC_OPTIONS, params: run.params });
      const findings = run.qcMode === "manual" && !routine.builtInQc ? null : (run.findings ?? []);
      await this.deps.qc.evaluate(subject, run.outputs, findings, { onAiCall: () => (run.aiCalls += 1), isCancelled: () => false, speed }, new Set(failed.map((o) => o.id)));
      run.status = run.outputs.some((o) => o.status === "failed") ? "partial" : "succeeded";
      run.phase = undefined;
      this.active.delete(run.id);
      await this.persist(run);
      this.deps.emit(run);
    })();
    return run;
  }

  async markOutputOk(runId: string, outputId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    const output = run.outputs.find((o) => o.id === outputId);
    if (output) output.markedOk = true;
    await this.persist(run);
    this.deps.emit(run);
    return run;
  }

  async openOutput(runId: string, outputId: string) {
    const run = await this.requireRun(runId);
    const output = run.outputs.find((o) => o.id === outputId);
    const docId = run.targetDocument?.id ?? run.options.documentId;
    if (!docId) return;
    await this.deps.registry.get(run.appId).openInApp(docId, output?.pageIndex);
  }

  async revealOutput(runId: string, outputId: string) {
    const run = await this.requireRun(runId);
    const output = run.outputs.find((o) => o.id === outputId);
    if (output?.filePath) shell.showItemInFolder(output.filePath);
  }
}

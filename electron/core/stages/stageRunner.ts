import fs from "node:fs/promises";
import path from "node:path";
import { PluginNotConnectedError } from "../../adapters/figma/pluginBridge";
import { BridgeError } from "../../adapters/adobe/bridge";
import type { AdapterRegistry } from "../../adapters/registry";
import type { DesignAppAdapter, StageItemInput, StageItemResult, StageRunContext, StageSession } from "../../adapters/types";
import { DataFileError, listFolderFiles, readDataFile } from "../helpers/dataFiles";
import type { AppId, ParamDef, ParamValues, RuleFinding, RunOutput, Stage, StageItemProgress, StageProgress } from "../types";
import { CancelledError, errorMessage } from "../util";
import { type Composite, expandValue, fileItem, onlyPlaceholder, PlaceholderError, plain, resolveExpr } from "./placeholders";

// Runs the stages of a multi-app routine in order. Each stage gets a working folder (runs/<runId>/<stageId>/)
// and runs once, or once per item of a list (data rows, files, an earlier stage's outputs). Items run one after
// another; a failed item is recorded and later stages skip it, so one bad row doesn't stop the rest.

export interface StageRunSpec {
  runId: string;
  routineName: string;
  stages: Stage[];
  params: ParamDef[];
  values: ParamValues;
  target: "copy" | "original" | "trial";
  documents: Partial<Record<AppId, string>>;
  /** runs/<runId>/: each stage works in runs/<runId>/<stageId>/. */
  runDir: string;
  copiesDir: string;
  isCancelled: () => boolean;
  /** Only this item (0-based) of lists taken from params: a preview or trial on one sample item. */
  sampleIndex?: number;
  /** Only these item keys run (running failed items again). */
  onlyItems?: Set<string>;
  /** Stop after this stage (previewing one stage). */
  stopAfter?: string;
}

export interface StageRunHooks {
  onProgress: (stages: StageProgress[], phase: string) => void;
  onOutputs: (outputs: RunOutput[]) => void;
}

export interface ItemRecord {
  stageId: string;
  key: string;
  label: string;
  ok: boolean;
  error?: string;
  scriptFailure?: boolean;
  data?: unknown;
  log: string[];
  findings: RuleFinding[];
  outputIds: string[];
}

export interface StageRunResult {
  status: "succeeded" | "partial" | "failed" | "cancelled";
  stages: StageProgress[];
  outputs: RunOutput[];
  /** Findings tied to output ids (outputKey), for quality checks. */
  findings: RuleFinding[];
  items: ItemRecord[];
  stageOutputs: Record<string, { outputs: Record<string, unknown[]> }>;
  log: string[];
  error?: string;
}

/** A problem with the run's inputs (a data file that can't be read, a missing folder). */
export class RunInputError extends Error {}

interface PreparedItem {
  key: string;
  label: string;
  value: unknown;
  /** The item can't run (e.g. its data row has errors). */
  preError?: string;
}

const LABEL_FIELDS = ["name", "title", "product", "sku", "id", "label", "code"];

function rowLabel(row: Record<string, unknown>, index: number): string {
  const keys = Object.keys(row);
  const preferred = LABEL_FIELDS.map((f) => keys.find((k) => k.toLowerCase() === f)).find((k) => k && row[k] !== null && row[k] !== "");
  const key = preferred ?? keys.find((k) => typeof row[k] === "string" && String(row[k]).trim());
  const value = key ? String(row[key]).trim() : "";
  return value ? `Row ${index + 1} · ${value.slice(0, 40)}` : `Row ${index + 1}`;
}

/** Turns params into placeholder values: data files are read, folders listed. */
export async function buildParamScope(defs: ParamDef[], values: ParamValues) {
  const scope: Record<string, unknown> = {};
  const scriptParams: Record<string, unknown> = {};
  const rowErrors = new Map<string, Map<number, string>>();
  const rowNumbers = new Map<string, number[]>();
  for (const [key, value] of Object.entries(values)) {
    scope[key] = value;
    scriptParams[key] = value;
  }
  for (const def of defs) {
    const v = values[def.key];
    if (typeof v !== "string" || !v) continue;
    if (def.type === "dataFile") {
      let table;
      try {
        table = await readDataFile(v, { requiredColumns: def.columns });
      } catch (err) {
        throw new RunInputError(err instanceof DataFileError ? err.message : `${path.basename(v)} couldn't be read: ${errorMessage(err)}`);
      }
      const errors = new Map<number, string>();
      for (const e of table.errors) errors.set(e.row, [errors.get(e.row), e.message].filter(Boolean).join(" "));
      rowErrors.set(def.key, errors);
      rowNumbers.set(def.key, table.rowNumbers);
      scope[def.key] = { __value: v, name: path.basename(v), rows: table.rows, columns: table.columns } satisfies Composite;
    } else if (def.type === "folder") {
      let files: string[] = [];
      try {
        files = (await listFolderFiles(v, { extensions: def.extensions })).map((f) => f.path);
      } catch {
        // Output folders may not exist yet; they are created when files are written.
      }
      scope[def.key] = { __value: v, name: path.basename(v), files: files.map(fileItem) } satisfies Composite;
    }
  }
  return { scope, scriptParams, rowErrors, rowNumbers };
}

export class StageRunner {
  constructor(private readonly registry: AdapterRegistry) {}

  async run(spec: StageRunSpec, hooks: StageRunHooks): Promise<StageRunResult> {
    const stages = spec.stopAfter ? spec.stages.slice(0, spec.stages.findIndex((s) => s.id === spec.stopAfter) + 1 || undefined) : spec.stages;
    const progress: StageProgress[] = stages.map((s) => ({
      stageId: s.id,
      name: s.name,
      appId: s.appId,
      status: "pending",
      total: 0,
      done: 0,
      failed: 0,
      items: [],
    }));
    const outputs: RunOutput[] = [];
    const findings: RuleFinding[] = [];
    const items: ItemRecord[] = [];
    const log: string[] = [];
    const stageOutputs: Record<string, { outputs: Record<string, unknown[]> }> = {};
    /** Item key of every value in a stage output list (so later stages know which item a file came from). */
    const outputOrigins: Record<string, Record<string, string[]>> = {};
    const failedKeys = new Set<string>();
    const usedAdapters = new Set<DesignAppAdapter>();
    let cancelled = false;
    const emit = (phase: string) => hooks.onProgress(progress, phase);

    const { scope, scriptParams, rowErrors, rowNumbers } = await buildParamScope(spec.params, spec.values);
    const allowedFolders = spec.params
      .filter((p) => p.type === "folder" && typeof spec.values[p.key] === "string" && spec.values[p.key])
      .map((p) => String(spec.values[p.key]));

    try {
      for (const [si, stage] of stages.entries()) {
        const sp = progress[si];
        if (spec.isCancelled()) {
          cancelled = true;
          break;
        }
        const adapter = this.registry.get(stage.appId);
        usedAdapters.add(adapter);
        let prepared: PreparedItem[];
        try {
          prepared = this.itemsFor(stage, spec, scope, stageOutputs, outputOrigins, rowErrors, rowNumbers);
        } catch (err) {
          sp.status = "failed";
          sp.error = errorMessage(err);
          emit(`${adapter.name} · ${sp.error}`);
          continue;
        }
        sp.items = prepared.map((p): StageItemProgress => ({ key: p.key, label: p.label, status: "pending" }));
        sp.total = prepared.length;
        stageOutputs[stage.id] = { outputs: Object.fromEntries(stage.outputs.map((o) => [o.key, []])) };
        outputOrigins[stage.id] = Object.fromEntries(stage.outputs.map((o) => [o.key, []]));

        const runnable = prepared.filter((p, i) => {
          const ip = sp.items[i];
          if (failedKeys.has(p.key)) {
            ip.status = "skipped";
            ip.error = "Skipped: this item failed in an earlier stage.";
            return false;
          }
          if (p.preError) {
            ip.status = "failed";
            ip.error = p.preError;
            sp.failed++;
            failedKeys.add(p.key);
            items.push({ stageId: stage.id, key: p.key, label: p.label, ok: false, error: p.preError, log: [], findings: [], outputIds: [] });
            outputs.push({ id: `${stage.id}:${p.key}`, label: p.label, status: "failed", error: p.preError, stageId: stage.id, itemKey: p.key, itemLabel: p.label });
            return false;
          }
          return true;
        });
        if (runnable.length === 0) {
          sp.status = sp.failed > 0 ? "failed" : "skipped";
          emit(`${adapter.name} · nothing to run`);
          continue;
        }

        sp.status = "running";
        const workDir = path.join(spec.runDir, stage.id);
        await fs.mkdir(workDir, { recursive: true });
        const ctx: StageRunContext = {
          runId: spec.runId,
          routineName: spec.routineName,
          stage,
          documentId: (stage.document ?? "open") === "none" ? undefined : spec.documents[stage.appId],
          target: spec.target,
          workDir,
          copiesDir: spec.copiesDir,
          allowedFolders,
          isCancelled: spec.isCancelled,
        };
        emit(`${adapter.name} · starting ${stage.name}`);

        let session: StageSession | null = null;
        try {
          session = await adapter.beginStage(ctx);
          sp.documentName = session.documentName;
          for (const [n, item] of runnable.entries()) {
            if (spec.isCancelled()) {
              cancelled = true;
              break;
            }
            const ip = sp.items[prepared.indexOf(item)];
            ip.status = "running";
            const where = runnable.length > 1 ? `${adapter.name.replace(/^Adobe /, "")} · item ${n + 1} of ${runnable.length}` : adapter.name.replace(/^Adobe /, "");
            emit(where);
            const res = await this.runItem(adapter, session, stage, item, prepared.indexOf(item), ctx, spec, scope, scriptParams, stageOutputs, (text) =>
              emit(`${where} · ${text}`),
            );
            const record: ItemRecord = { stageId: stage.id, key: item.key, label: item.label, ok: res.ok, error: res.error, scriptFailure: res.scriptFailure, data: res.data, log: res.log, findings: res.findings, outputIds: [] };
            items.push(record);
            log.push(...res.log.map((l) => `${stage.name} · ${item.label}: ${l}`));
            const mine: RunOutput[] = res.outputs.map((o) => ({
              id: `${stage.id}:${o.key}`,
              label: o.label,
              status: res.ok ? "done" : "failed",
              error: res.ok ? undefined : res.error,
              preview: o.preview,
              filePath: o.filePath,
              page: o.page,
              pageIndex: o.pageIndex,
              nodeId: o.nodeId,
              details: o.details,
              profile: o.profile,
              stageId: stage.id,
              itemKey: item.key,
              itemLabel: item.label,
            }));
            if (mine.length === 0) {
              mine.push({ id: `${stage.id}:${item.key}`, label: item.label, status: res.ok ? "done" : "failed", error: res.error, stageId: stage.id, itemKey: item.key, itemLabel: item.label });
            }
            if (!res.ok) for (const o of mine) Object.assign(o, { status: "failed", error: res.error });
            record.outputIds = mine.map((o) => o.id);
            outputs.push(...mine);
            for (const f of res.findings) for (const o of mine) findings.push({ ...f, outputKey: o.id });
            if (res.ok) {
              ip.status = "done";
              sp.done++;
              for (const [key, list] of Object.entries(res.values)) {
                (stageOutputs[stage.id].outputs[key] ??= []).push(...list);
                (outputOrigins[stage.id][key] ??= []).push(...list.map(() => item.key));
              }
            } else {
              ip.status = "failed";
              ip.error = res.error;
              sp.failed++;
              failedKeys.add(item.key);
            }
            hooks.onOutputs(outputs);
            emit(where);
            // The app went away mid-stage: the remaining items can't run either.
            if (!res.ok && res.fatal) {
              for (const rest of runnable.slice(n + 1)) {
                const rp = sp.items[prepared.indexOf(rest)];
                rp.status = "failed";
                rp.error = res.error;
                sp.failed++;
                failedKeys.add(rest.key);
                outputs.push({ id: `${stage.id}:${rest.key}`, label: rest.label, status: "failed", error: res.error, stageId: stage.id, itemKey: rest.key, itemLabel: rest.label });
              }
              break;
            }
          }
        } catch (err) {
          if (err instanceof CancelledError) {
            cancelled = true;
          } else {
            // The stage couldn't start (app not connected, document not open): every item fails with that reason.
            sp.error = errorMessage(err);
            for (const [i, ip] of sp.items.entries()) {
              if (ip.status !== "pending" && ip.status !== "running") continue;
              ip.status = "failed";
              ip.error = sp.error;
              sp.failed++;
              failedKeys.add(prepared[i].key);
              outputs.push({ id: `${stage.id}:${prepared[i].key}`, label: prepared[i].label, status: "failed", error: sp.error, stageId: stage.id, itemKey: prepared[i].key, itemLabel: prepared[i].label });
            }
          }
        } finally {
          if (session) await adapter.endStage(session, ctx).catch((err) => log.push(`${stage.name}: couldn't clean up (${errorMessage(err)})`));
        }
        if (cancelled) {
          sp.status = "cancelled";
          for (const ip of sp.items) if (ip.status === "pending" || ip.status === "running") ip.status = "skipped";
          break;
        }
        sp.status = sp.failed === 0 ? "done" : sp.done === 0 ? "failed" : "partial";
        hooks.onOutputs(outputs);
        emit(`${adapter.name} · ${stage.name} finished`);
      }
    } finally {
      for (const adapter of usedAdapters) await adapter.endRun?.(spec.runId).catch(() => undefined);
    }

    for (const sp of progress) if (cancelled && sp.status === "pending") sp.status = "skipped";
    const anyFailed = progress.some((s) => s.failed > 0 || s.status === "failed");
    const anyDone = progress.some((s) => s.done > 0);
    const status: StageRunResult["status"] = cancelled ? "cancelled" : !anyFailed ? "succeeded" : anyDone ? "partial" : "failed";
    const firstError = progress.find((s) => s.error)?.error ?? items.find((i) => !i.ok)?.error;
    return { status, stages: progress, outputs, findings, items, stageOutputs, log, error: status === "failed" ? firstError : undefined };
  }

  private itemsFor(
    stage: Stage,
    spec: StageRunSpec,
    scope: Record<string, unknown>,
    stageOutputs: Record<string, { outputs: Record<string, unknown[]> }>,
    origins: Record<string, Record<string, string[]>>,
    rowErrors: Map<string, Map<number, string>>,
    rowNumbers: Map<string, number[]>,
  ): PreparedItem[] {
    if (!stage.repeat) return [{ key: "all", label: stage.name, value: undefined }];
    const expr = onlyPlaceholder(stage.repeat.over);
    if (!expr) throw new Error(`"${stage.repeat.over}" isn't a list placeholder.`);
    const r = resolveExpr(expr, { params: scope, stages: stageOutputs });
    if (!r.found || !Array.isArray(r.value)) throw new Error(`{{${expr}}} isn't a list for this run.`);
    const list = r.value as unknown[];
    const parts = expr.split(".");
    let prepared: PreparedItem[];
    if (parts[0] === "params" && parts[2] === "rows") {
      const errors = rowErrors.get(parts[1]);
      const numbers = rowNumbers.get(parts[1]) ?? [];
      prepared = list.map((row, i) => {
        const rowNumber = numbers[i] ?? i + 1;
        const problem = errors?.get(rowNumber);
        return {
          key: `row-${rowNumber}`,
          label: rowLabel(row as Record<string, unknown>, rowNumber - 1),
          value: row,
          preError: problem ? `Row ${rowNumber}: ${problem}` : undefined,
        };
      });
    } else if (parts[0] === "params") {
      prepared = list.map((f) => {
        const file = f as Composite;
        return { key: `file-${String(file.name)}`, label: String(file.name), value: file };
      });
    } else {
      const keys = origins[parts[1]]?.[parts[3]] ?? [];
      prepared = list.map((v, i) => {
        const isPath = typeof v === "string" && v.startsWith("/");
        return {
          key: keys[i] ? (list.length > new Set(keys).size ? `${keys[i]}-${i + 1}` : keys[i]) : `${parts[1]}-${i + 1}`,
          label: isPath ? path.basename(v) : String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 60),
          value: isPath ? fileItem(v) : v,
        };
      });
    }
    if (spec.sampleIndex !== undefined && parts[0] === "params") prepared = prepared.slice(spec.sampleIndex, spec.sampleIndex + 1);
    if (spec.onlyItems) {
      const only = spec.onlyItems;
      prepared = prepared.filter((p) => only.has(p.key) || [...only].some((k) => p.key.startsWith(`${k}-`)));
    }
    return prepared;
  }

  private async runItem(
    adapter: DesignAppAdapter,
    session: StageSession,
    stage: Stage,
    item: PreparedItem,
    index: number,
    ctx: StageRunContext,
    spec: StageRunSpec,
    scope: Record<string, unknown>,
    scriptParams: Record<string, unknown>,
    stageOutputs: Record<string, { outputs: Record<string, unknown[]> }>,
    onProgress: (text: string) => void,
  ): Promise<StageItemResult & { fatal?: boolean }> {
    let body: unknown = stage.body;
    if (stage.kind === "actions") {
      try {
        body = expandValue(stage.body, { params: scope, item: item.value, itemIndex: index, stages: stageOutputs });
      } catch (err) {
        if (err instanceof PlaceholderError) return { ok: false, error: err.message, outputs: [], values: {}, findings: [], log: [] };
        throw err;
      }
    }
    const input: StageItemInput = {
      key: item.key,
      label: item.label,
      index,
      item: item.value === undefined ? null : plain(item.value),
      params: scriptParams,
      stages: structuredClone(stageOutputs),
      body,
    };
    try {
      return await adapter.runStageItem(session, input, ctx, onProgress);
    } catch (err) {
      if (err instanceof CancelledError || spec.isCancelled()) throw new CancelledError();
      const fatal = err instanceof PluginNotConnectedError || (err instanceof BridgeError && err.kind !== "script");
      return { ok: false, fatal, error: errorMessage(err), outputs: [], values: {}, findings: [], log: [] };
    }
  }
}

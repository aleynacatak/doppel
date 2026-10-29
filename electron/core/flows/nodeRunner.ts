import { blocks } from "../blocks/registry";
import fs from "node:fs/promises";
import path from "node:path";
import { PluginNotConnectedError } from "../../adapters/figma/pluginBridge";
import { BridgeError } from "../../adapters/adobe/bridge";
import type { DesignAppAdapter, StageItemInput, StageItemResult, StageRunContext, StageSession } from "../../adapters/types";
import { fileAllowed } from "../../shared/ports";
import type { AppId, MatchRule, NodeProgress, ParamValue, PortDef, Routine, RuleFinding, RunOutput, Stage, StageItemProgress } from "../types";
import { CancelledError, errorMessage } from "../util";
import { expandValue, PlaceholderError, plain } from "../routines/placeholders";
import { pairItems } from "./match";
import { type ListItem, type PortValue, fileKey, itemValue, scopeValue, scriptValue } from "./values";

// Runs one routine node: in its app, once or once per item of the list it iterates over. Items run one after
// another; a failed item is recorded with its reason and the others go on. Items that failed earlier in the run
// are skipped, and a second list pairs with each item through the edge's match rule.

/** Where adapters come from: the real registry, or simulated apps in the dev panel. */
export interface AdapterSource {
  get(appId: AppId): DesignAppAdapter;
}

/** Why an item failed, and where. */
export interface FailureInfo {
  node: string;
  reason: string;
}

export interface NodeRunSpec {
  runId: string;
  nodeId: string;
  /** The node's name in the run ("Cut out photos"). */
  name: string;
  /** The pinned routine version. */
  routine: Routine;
  /** Per input key: the value it gets (already adapted to the port's type). */
  inputs: Record<string, PortValue | undefined>;
  /** Per joined input key (a second list): how its items pair with the iterated items. */
  joins: Record<string, MatchRule>;
  settings: Record<string, ParamValue>;
  /** The document picked for the routine's app (routines with a document input). */
  documentId?: string;
  target: "copy" | "original" | "trial";
  /** runs/<runId>/<nodeId>/: the routine's files go here. */
  workDir: string;
  copiesDir: string;
  /** Folders the routine may write to besides its working folder (folder inputs). */
  allowedFolders: string[];
  isCancelled: () => boolean;
  /** Items that failed earlier in the run; they are skipped here. Failures here are added. */
  failed: Map<string, FailureInfo>;
  /** Only this item (0-based): a preview or trial on one sample item. */
  sampleIndex?: number;
  /** Only these items (running failed items again). */
  onlyItems?: Set<string>;
  /** Dev panel: fail the node, or these items (1-based). */
  forceFail?: { node?: boolean; items?: number[] };
}

export interface NodeRunHooks {
  onProgress: (progress: NodeProgress, phase: string) => void;
  onOutputs: (outputs: RunOutput[]) => void;
}

export interface ItemRecord {
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

export interface NodeRunResult {
  progress: NodeProgress;
  outputs: RunOutput[];
  /** Findings tied to output ids (outputKey), for quality checks. */
  findings: RuleFinding[];
  items: ItemRecord[];
  /** Per output key: what the routine produced, collected over its items. */
  values: Record<string, PortValue>;
  log: string[];
  cancelled: boolean;
}

interface PreparedItem {
  key: string;
  label: string;
  /** {{item}} / ctx.item. */
  value: unknown;
  matched: Record<string, unknown>;
  preError?: string;
}

/** How a routine runs in its app (what adapters get). */
export function stageFor(routine: Routine, nodeId: string, name: string): Stage {
  return {
    id: nodeId,
    name,
    appId: routine.appId,
    kind: routine.kind,
    body: routine.kind === "actions" ? { actions: routine.actions ?? [] } : routine.script,
    outputs: routine.outputs.map((o) => ({
      key: o.key,
      type: o.type === "file" || o.type === "fileList" ? o.type : "data",
      label: o.label,
      ...(o.extensions?.length ? { extensions: o.extensions } : {}),
    })),
    document: routine.inputs.some((p) => p.type === "document") ? "open" : "none",
    modifiesDocument: routine.modifiesDocument,
    blocks: blocks.resolve(routine.appId, routine.helpers),
  };
}

const shortApp = (adapter: DesignAppAdapter) => adapter.name.replace(/^Adobe /, "");

/** A preview that can't be rendered just stays empty; it never fails the item. */
async function previewOf(adapter: DesignAppAdapter, target: string) {
  try {
    return await adapter.renderPreview(target);
  } catch {
    return undefined;
  }
}

/** What a routine produced for one output port, collected over its items. */
function collect(port: PortDef, iterates: boolean, produced: { itemKey: string; values: unknown[] }[], nodeId: string): PortValue | null {
  const entries: ListItem[] = [];
  for (const p of produced) {
    p.values.forEach((v, i) => {
      const key = p.itemKey === "all" ? (typeof v === "string" && v.startsWith("/") ? fileKey(v) : `${nodeId}-${entries.length + 1}`) : p.values.length > 1 ? `${p.itemKey}-${i + 1}` : p.itemKey;
      const label = typeof v === "string" ? (v.startsWith("/") ? path.basename(v) : v.slice(0, 60)) : JSON.stringify(v).slice(0, 60);
      entries.push({ key, label, value: v });
    });
  }
  const asRow = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : { [port.key]: v });
  if (port.type === "file" || port.type === "fileList") {
    const files = entries.filter((e) => typeof e.value === "string");
    if (port.type === "file" && !iterates) return files[0] ? { kind: "value", type: "file", value: String(files[0].value) } : null;
    return { kind: "list", type: "fileList", items: files };
  }
  if (port.type === "rows" || iterates) {
    const rows = entries.flatMap((e) =>
      Array.isArray(e.value) ? e.value.map((v, i) => ({ key: `${e.key}-${i + 1}`, label: e.label, value: asRow(v) })) : [{ ...e, value: asRow(e.value) }],
    );
    const columns = port.type === "rows" ? (port.columns ?? [...new Set(rows.flatMap((r) => Object.keys(r.value as object)))]) : [port.key];
    return { kind: "list", type: "rows", items: rows, columns };
  }
  const first = entries[0]?.value;
  if (first === undefined) return null;
  return { kind: "value", type: port.type, value: typeof first === "object" ? JSON.stringify(first) : (first as string | number | boolean) };
}

export class NodeRunner {
  constructor(private readonly adapters: AdapterSource) {}

  async run(spec: NodeRunSpec, hooks: NodeRunHooks): Promise<NodeRunResult> {
    const { routine } = spec;
    const adapter = this.adapters.get(routine.appId);
    const progress: NodeProgress = { nodeId: spec.nodeId, kind: "routine", name: spec.name, appId: routine.appId, status: "pending", total: 0, done: 0, failed: 0, items: [] };
    const outputs: RunOutput[] = [];
    const findings: RuleFinding[] = [];
    const items: ItemRecord[] = [];
    const log: string[] = [];
    const produced: Record<string, { itemKey: string; values: unknown[] }[]> = Object.fromEntries(routine.outputs.map((o) => [o.key, []]));
    let cancelled = false;
    const emit = (phase: string) => hooks.onProgress(progress, phase);
    const finish = (): NodeRunResult => {
      const values: Record<string, PortValue> = {};
      for (const port of routine.outputs) {
        const v = collect(port, !!routine.iterate, produced[port.key], spec.nodeId);
        if (v) values[port.key] = v;
      }
      return { progress, outputs, findings, items, values, log, cancelled };
    };
    const failItem = (ip: StageItemProgress, item: { key: string; label: string }, error: string) => {
      ip.status = "failed";
      ip.error = error;
      progress.failed++;
      spec.failed.set(item.key, { node: spec.name, reason: error });
      outputs.push({ id: `${spec.nodeId}:${item.key}`, label: item.label, status: "failed", error, node: spec.nodeId, itemKey: item.key, itemLabel: item.label });
    };

    let prepared: PreparedItem[];
    try {
      prepared = this.itemsFor(spec);
    } catch (err) {
      progress.status = "failed";
      progress.error = errorMessage(err);
      emit(`${shortApp(adapter)} · ${progress.error}`);
      return finish();
    }
    progress.items = prepared.map((p): StageItemProgress => ({ key: p.key, label: p.label, status: "pending" }));
    progress.total = prepared.length;

    const runnable = prepared.filter((p, i) => {
      const ip = progress.items[i];
      const earlier = spec.failed.get(p.key);
      if (earlier) {
        ip.status = "skipped";
        ip.error = `Skipped: it failed in ${earlier.node}.`;
        return false;
      }
      if (p.preError) {
        failItem(ip, p, p.preError);
        items.push({ key: p.key, label: p.label, ok: false, error: p.preError, log: [], findings: [], outputIds: [`${spec.nodeId}:${p.key}`] });
        return false;
      }
      return true;
    });
    if (runnable.length === 0) {
      progress.status = progress.failed > 0 ? "failed" : "skipped";
      if (progress.total === 0) progress.error = routine.iterate ? "There were no items to run." : undefined;
      emit(`${shortApp(adapter)} · nothing to run`);
      hooks.onOutputs(outputs);
      return finish();
    }

    progress.status = "running";
    await fs.mkdir(spec.workDir, { recursive: true });
    const stage = stageFor(routine, spec.nodeId, spec.name);
    const ctx: StageRunContext = {
      runId: spec.runId,
      routineName: spec.name,
      stage,
      documentId: stage.document === "none" ? undefined : spec.documentId,
      target: spec.target,
      workDir: spec.workDir,
      copiesDir: spec.copiesDir,
      allowedFolders: spec.allowedFolders,
      isCancelled: spec.isCancelled,
    };
    // Placeholder values and script params, once for all items.
    const inputsScope: Record<string, unknown> = {};
    const params: Record<string, unknown> = { ...spec.settings };
    for (const port of routine.inputs) {
      inputsScope[port.key] = await scopeValue(spec.inputs[port.key]);
      params[port.key] = scriptValue(spec.inputs[port.key]);
    }
    emit(`${shortApp(adapter)} · starting ${spec.name}`);

    let session: StageSession | null = null;
    try {
      if (spec.forceFail?.node) throw new Error("Forced failure (dev panel).");
      session = await adapter.beginStage(ctx);
      progress.documentName = session.documentName;
      for (const [n, item] of runnable.entries()) {
        if (spec.isCancelled()) {
          cancelled = true;
          break;
        }
        const index = prepared.indexOf(item);
        const ip = progress.items[index];
        ip.status = "running";
        const where = runnable.length > 1 ? `${shortApp(adapter)} · item ${n + 1} of ${runnable.length}` : shortApp(adapter);
        emit(where);
        const res = await this.runItem(adapter, session, routine, item, index, ctx, spec, inputsScope, params, (text) => emit(`${where} · ${text}`));
        const record: ItemRecord = { key: item.key, label: item.label, ok: res.ok, error: res.error, scriptFailure: res.scriptFailure, data: res.data, log: res.log, findings: res.findings, outputIds: [] };
        items.push(record);
        log.push(...res.log.map((l) => `${spec.name} · ${item.label}: ${l}`));
        const mine: RunOutput[] = res.outputs.map((o) => ({
          id: `${spec.nodeId}:${o.key}`,
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
          node: spec.nodeId,
          itemKey: item.key,
          itemLabel: item.label,
        }));
        if (mine.length === 0) {
          mine.push({ id: `${spec.nodeId}:${item.key}`, label: item.label, status: res.ok ? "done" : "failed", error: res.error, node: spec.nodeId, itemKey: item.key, itemLabel: item.label });
        }
        // Adapters preview documents they render; files the routine saved (and Figma frames) get theirs here.
        for (const o of mine) {
          if (o.preview || o.status !== "done") continue;
          const target = o.filePath ? `file:${o.filePath}` : o.nodeId && ctx.documentId ? `node:${ctx.documentId}#${o.nodeId}` : null;
          if (target) o.preview = await previewOf(adapter, target);
        }
        record.outputIds = mine.map((o) => o.id);
        outputs.push(...mine);
        for (const f of res.findings) for (const o of mine) findings.push({ ...f, outputKey: o.id });
        if (res.ok) {
          ip.status = "done";
          progress.done++;
          for (const [key, values] of Object.entries(res.values)) if (produced[key]) produced[key].push({ itemKey: item.key, values });
        } else {
          ip.status = "failed";
          ip.error = res.error;
          progress.failed++;
          spec.failed.set(item.key, { node: spec.name, reason: res.error ?? "It failed." });
        }
        hooks.onOutputs(outputs);
        emit(where);
        // The app went away: the remaining items can't run either.
        if (!res.ok && res.fatal) {
          for (const rest of runnable.slice(n + 1)) failItem(progress.items[prepared.indexOf(rest)], rest, res.error ?? "The app stopped responding.");
          break;
        }
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        cancelled = true;
      } else {
        // The routine couldn't start (app not connected, document not open): every item fails with that reason.
        progress.error = errorMessage(err);
        for (const [i, ip] of progress.items.entries()) {
          if (ip.status !== "pending" && ip.status !== "running") continue;
          failItem(ip, prepared[i], progress.error);
        }
      }
    } finally {
      if (session) await adapter.endStage(session, ctx).catch((err) => log.push(`${spec.name}: couldn't clean up (${errorMessage(err)})`));
    }
    if (cancelled) {
      progress.status = "cancelled";
      for (const ip of progress.items) if (ip.status === "pending" || ip.status === "running") ip.status = "skipped";
    } else {
      progress.status = progress.failed === 0 ? "done" : progress.done === 0 ? "failed" : "partial";
    }
    hooks.onOutputs(outputs);
    emit(`${shortApp(adapter)} · ${spec.name} finished`);
    return finish();
  }

  /** The items the routine runs on, each with its matched partners; items that can't run carry the reason. */
  private itemsFor(spec: NodeRunSpec): PreparedItem[] {
    const { routine } = spec;
    if (!routine.iterate) return [{ key: "all", label: spec.name, value: undefined, matched: {} }];
    const port = routine.inputs.find((p) => p.key === routine.iterate!.input);
    const list = spec.inputs[routine.iterate.input];
    if (!port) throw new Error(`The routine iterates over "${routine.iterate.input}", which isn't one of its inputs.`);
    if (!list || list.kind !== "list") throw new Error(`${port.label} has no items for this run.`);
    let source = list.items;
    if (spec.sampleIndex !== undefined) source = source.slice(spec.sampleIndex, spec.sampleIndex + 1);
    if (spec.onlyItems) {
      const only = spec.onlyItems;
      source = source.filter((i) => only.has(i.key) || [...only].some((k) => i.key.startsWith(`${k}-`)));
    }
    const missing = (row: unknown) => (port.columns ?? []).find((c) => {
      const v = (row as Record<string, unknown> | null)?.[c];
      return v === undefined || v === null || String(v).trim() === "";
    });
    const prepared: PreparedItem[] = source.map((item) => ({
      key: item.key,
      label: item.label,
      value: itemValue(list.type, item),
      matched: {},
      preError:
        list.type === "fileList" && !fileAllowed(String(item.value), port.extensions)
          ? `${item.label} isn't a ${port.extensions!.map((e) => e.toUpperCase()).join(" or ")} file, which ${port.label} takes.`
          : list.type === "rows" && missing(item.value)
            ? `${item.label}: "${missing(item.value)}" is empty.`
            : undefined,
    }));
    // A second list pairs with each item through its match rule; an item without a partner can't run.
    for (const [key, rule] of Object.entries(spec.joins)) {
      const joinedPort = routine.inputs.find((p) => p.key === key);
      const joined = spec.inputs[key];
      if (!joinedPort || !joined || joined.kind !== "list") continue;
      const pairs = pairItems(rule, { type: list.type, items: source }, { type: joined.type, items: joined.items, label: joinedPort.label });
      for (const p of prepared) {
        const pair = pairs.get(p.key);
        if (pair?.matched) p.matched[key] = itemValue(joined.type, pair.matched);
        else if (!p.preError) {
          const failedPartner = spec.failed.get(p.key);
          p.preError = failedPartner && rule.by === "index" ? `${pair?.problem ?? "No match."} It failed in ${failedPartner.node}.` : (pair?.problem ?? "No match.");
        }
      }
    }
    const forced = new Set(spec.forceFail?.items ?? []);
    prepared.forEach((p, i) => {
      if (forced.has(i + 1) && !p.preError) p.preError = "Forced failure (dev panel).";
    });
    return prepared;
  }

  private async runItem(
    adapter: DesignAppAdapter,
    session: StageSession,
    routine: Routine,
    item: PreparedItem,
    index: number,
    ctx: StageRunContext,
    spec: NodeRunSpec,
    inputsScope: Record<string, unknown>,
    params: Record<string, unknown>,
    onProgress: (text: string) => void,
  ): Promise<StageItemResult & { fatal?: boolean }> {
    let body: unknown = ctx.stage.body;
    if (routine.kind === "actions") {
      try {
        body = expandValue(ctx.stage.body, {
          inputs: inputsScope,
          settings: spec.settings,
          item: routine.iterate ? item.value : undefined,
          itemIndex: routine.iterate ? index : undefined,
          matched: routine.iterate ? item.matched : undefined,
        });
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
      matched: plain(item.matched) as Record<string, unknown>,
      params,
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import type { StageRunContext } from "../../adapters/types";
import { validateAuthoringActions } from "../../shared/figmaActions";
import { type BarcodeType, barcodeSvg, validateBarcode } from "../helpers/barcode";
import { expandValue, fileItem } from "../routines/placeholders";
import { RoutineFormatError, errorsForModel, toRoutineDraft } from "../routines/modelRoutine";
import type { RoutineContract } from "../routines/contract";
import type { DevFlowOptions, DevRunResult, ExecutionPlan, InputValue, Routine, RoutineDraft, Run, RunRequest, SaveRoutineResult, Stage, ValidationResult } from "../types";
import { errorMessage, newId, nowIso } from "../util";
import type { FlowService } from "./flowService";
import type { LibraryService } from "./libraryService";
import type { RunService } from "./runService";
import { toStarterFile } from "./starterService";
import type { Storage } from "./storage";

// The hidden dev panel (Cmd+Shift+D): run a Figma action list or a Photoshop script once, try barcodes, validate or
// save a routine written by hand, run flows with simulated apps and forced failures, see a flow's execution plan,
// and export a routine as a starter. Nothing here calls AI.

interface Deps {
  registry: AdapterRegistry;
  storage: Storage;
  library: LibraryService;
  flows: FlowService;
  runs: RunService;
  validate: (draft: RoutineContract) => ValidationResult;
  /** Asks where to save a file (a save dialog); null when cancelled. */
  chooseSavePath: (defaultName: string) => Promise<string | null>;
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "doppl-dev-"));
}

/** A routine in the model's format ({ name, app, inputs, outputs, settings, iterate, actions | script, … }). */
function parseRoutine(json: string, registry: AdapterRegistry): RoutineDraft {
  const raw = JSON.parse(json);
  const app = String(raw?.app ?? raw?.appId ?? "");
  if (!registry.list().some((a) => a.id === app)) throw new RoutineFormatError(`"app" must be one of ${registry.list().map((a) => a.id).join(", ")}.`);
  return toRoutineDraft(raw, app, registry.get(app).stageKind, "");
}

export class DevService {
  constructor(private readonly deps: Deps) {}

  private async runOnce(appId: string, stage: Stage, documentId: string | undefined, item: unknown, workDir: string): Promise<DevRunResult> {
    const started = Date.now();
    const adapter = this.deps.registry.get(appId);
    const ctx: StageRunContext = {
      runId: `dev-${newId().slice(0, 8)}`,
      routineName: "Dev panel",
      stage,
      documentId,
      target: "original",
      workDir,
      copiesDir: path.join(workDir, "copies"),
      isCancelled: () => false,
    };
    const session = await adapter.beginStage(ctx);
    try {
      const res = await adapter.runStageItem(
        session,
        { key: "dev", label: "Dev run", index: 0, item, params: {}, body: stage.body },
        ctx,
        () => undefined,
      );
      return {
        ok: res.ok,
        error: res.error,
        data: res.data ?? null,
        log: res.log,
        findings: res.findings,
        previews: res.outputs.filter((o) => o.preview).map((o) => o.preview!),
        files: res.outputs.filter((o) => o.filePath).map((o) => o.filePath!),
        ms: Date.now() - started,
      };
    } finally {
      await adapter.endStage(session, ctx).catch(() => undefined);
      await adapter.endRun?.(ctx.runId).catch(() => undefined);
    }
  }

  private failure(error: string, started: number): DevRunResult {
    return { ok: false, error, log: [], findings: [], previews: [], files: [], ms: Date.now() - started };
  }

  /** Runs an action list once on the current page of a Figma file (one undo step in Figma). */
  async runFigmaActions(documentId: string, actionsJson: string, itemJson?: string): Promise<DevRunResult> {
    const started = Date.now();
    let body: unknown;
    let item: unknown;
    try {
      const parsed = JSON.parse(actionsJson);
      body = Array.isArray(parsed) ? { actions: parsed } : parsed;
      item = itemJson?.trim() ? JSON.parse(itemJson) : undefined;
    } catch (err) {
      return this.failure(`That isn't valid JSON: ${errorMessage(err)}`, started);
    }
    const check = validateAuthoringActions(body);
    if (!check.ok) return this.failure(check.issues.map((i) => `${i.path}: ${i.message}`).join("\n"), started);
    let expanded: unknown;
    try {
      const value = typeof item === "string" && item.startsWith("/") ? fileItem(item) : item;
      expanded = expandValue(body, { inputs: {}, settings: {}, item: value, itemIndex: value === undefined ? undefined : 0 });
    } catch (err) {
      return this.failure(errorMessage(err), started);
    }
    const workDir = await tempDir();
    try {
      const stage: Stage = { id: "dev", name: "Dev run", appId: "figma", kind: "actions", body: expanded as Stage["body"], outputs: [{ key: "files", type: "fileList" }] };
      return await this.runOnce("figma", stage, documentId, item ?? null, workDir);
    } catch (err) {
      return this.failure(errorMessage(err), started);
    }
  }

  /** Runs a script once in Photoshop on a working copy of the document (or with no document); never saves it. */
  async runPhotoshopScript(documentId: string | null, script: string): Promise<DevRunResult> {
    const started = Date.now();
    const adapter = this.deps.registry.get("photoshop");
    const issues = adapter.lintScript?.(script) ?? [];
    if (issues.length) return this.failure(issues.join("\n"), started);
    const workDir = await tempDir();
    try {
      const stage: Stage = {
        id: "dev",
        name: "Dev run",
        appId: "photoshop",
        kind: "script",
        body: script,
        outputs: [{ key: "files", type: "fileList" }],
        document: documentId ? "open" : "none",
      };
      return await this.runOnce("photoshop", stage, documentId ?? undefined, null, workDir);
    } catch (err) {
      return this.failure(errorMessage(err), started);
    }
  }

  barcode(type: string, value: string) {
    const check = validateBarcode(type as BarcodeType, value);
    if (!check.ok) return { ok: false, error: check.message };
    return { ok: true, value: check.value, svg: barcodeSvg(type as BarcodeType, check.value).svg };
  }

  validateRoutine(json: string): { validation: ValidationResult; parseError?: string } {
    try {
      const draft = parseRoutine(json, this.deps.registry);
      const validation = this.deps.validate(draft);
      return { validation: { ...validation, errors: errorsForModel(validation.errors, draft) } };
    } catch (err) {
      return { validation: { ok: false, errors: [] }, parseError: errorMessage(err) };
    }
  }

  /** Saves a routine built by hand (validated first). It reruns like any other routine, with 0 AI calls. */
  async saveRoutine(json: string): Promise<SaveRoutineResult> {
    const draft = parseRoutine(json, this.deps.registry);
    const check = this.deps.validate(draft);
    if (!check.ok) throw new Error(errorsForModel(check.errors, draft).map((e) => `${e.path}: ${e.message}`).join("\n"));
    const now = nowIso();
    const routine: Routine = {
      ...draft,
      id: newId(),
      version: 1,
      createdWithAiCalls: 0,
      runs: [],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, createdAt: now, aiCalls: 0, note: "Built by hand in the dev panel" }],
      format: 2,
    };
    await this.deps.library.save(routine);
    return { saved: true, routine, issues: [] };
  }

  /** Runs a flow with simulated apps (or real ones) and forced failures. */
  runFlow(flowId: string, request: RunRequest, options: DevFlowOptions): Promise<Run> {
    return this.deps.runs.start({ kind: "flow", id: flowId }, request, { dev: options });
  }

  /** The order, item counts and join pairs a flow would run with, from the values picked (or used last time). */
  async executionPlan(flowId: string, inputs: Record<string, InputValue>): Promise<ExecutionPlan> {
    const flow = await this.deps.flows.require(flowId);
    const last = await this.deps.storage.getLastValues(`flow:${flowId}`);
    return this.deps.flows.plan(flow, { ...(last?.inputs ?? {}), ...inputs });
  }

  /** Writes one of my routines in the starter format, to a file the developer picks (to put into resources/starters/). */
  async exportStarter(routineId: string, options: { converter: boolean }): Promise<{ path: string | null; removed: string[] }> {
    const routine = await this.deps.library.require(routineId);
    if (routine.starter) throw new Error("This is a starter already.");
    const check = this.deps.validate(routine);
    if (!check.ok) throw new Error(`Its inputs and outputs need fixing first: ${check.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join(" · ")}`);
    const { starter, removed } = toStarterFile(routine, options);
    const file = await this.deps.chooseSavePath(`${starter.id}.json`);
    if (!file) return { path: null, removed };
    await fs.writeFile(file, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
    return { path: file, removed };
  }
}

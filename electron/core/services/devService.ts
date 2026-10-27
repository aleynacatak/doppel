import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRegistry } from "../../adapters/registry";
import type { StageRunContext } from "../../adapters/types";
import { validateAuthoringActions } from "../../shared/figmaActions";
import { type BarcodeType, barcodeSvg, validateBarcode } from "../helpers/barcode";
import { expandValue, fileItem } from "../stages/placeholders";
import type { DevRunResult, ParamDef, Routine, SaveRoutineResult, Stage, ValidationResult } from "../types";
import { errorMessage, newId, nowIso } from "../util";
import { toStagedDraft } from "./modelAiService";
import type { Storage } from "./storage";

// The hidden dev panel (Cmd+Shift+D): run a Figma action list or a Photoshop script once, try barcodes, and
// validate or save a routine written by hand. Runs here are real but never call AI.

interface Deps {
  registry: AdapterRegistry;
  storage: Storage;
  validate: (draft: { params: ParamDef[]; stages?: Stage[] }) => ValidationResult;
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "doppl-dev-"));
}

/** Accepts the model's format (stages with "app" and "actions"/"script") or Doppl's own ({ params, stages }). */
function parseRoutine(json: string): { name: string; description: string; params: ParamDef[]; stages: Stage[]; qcProfile: "print" | "web" } {
  const raw = JSON.parse(json);
  if (Array.isArray(raw?.stages) && raw.stages.some((s: any) => s && ("app" in s || "actions" in s || "script" in s))) {
    const d = toStagedDraft(raw, {});
    return { name: d.name, description: d.description, params: d.params, stages: d.stages!, qcProfile: d.qcProfile };
  }
  return {
    name: String(raw?.name ?? "Hand-built routine"),
    description: String(raw?.description ?? ""),
    params: Array.isArray(raw?.params) ? raw.params : [],
    stages: Array.isArray(raw?.stages) ? raw.stages : [],
    qcProfile: raw?.qcProfile === "print" ? "print" : "web",
  };
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
      allowedFolders: [],
      isCancelled: () => false,
    };
    const session = await adapter.beginStage(ctx);
    try {
      const res = await adapter.runStageItem(
        session,
        { key: "dev", label: "Dev run", index: 0, item, params: {}, stages: {}, body: stage.body },
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
      expanded = expandValue(body, { params: {}, item: value, itemIndex: value === undefined ? undefined : 0, stages: {} });
    } catch (err) {
      return this.failure(errorMessage(err), started);
    }
    const workDir = await tempDir();
    try {
      const stage: Stage = { id: "dev", name: "Dev run", appId: "figma", kind: "actions", body: expanded as Stage["body"], inputs: [], outputs: [{ key: "files", type: "fileList" }] };
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
        inputs: [],
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
      return { validation: this.deps.validate(parseRoutine(json)) };
    } catch (err) {
      return { validation: { ok: false, errors: [] }, parseError: errorMessage(err) };
    }
  }

  /** Saves a routine built by hand (validated first). It reruns like any other routine, with 0 AI calls. */
  async saveRoutine(json: string): Promise<SaveRoutineResult> {
    const r = parseRoutine(json);
    const check = this.deps.validate(r);
    if (!check.ok) throw new Error(check.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
    const now = nowIso();
    const routine: Routine = {
      id: newId(),
      name: r.name,
      appId: r.stages[0].appId,
      description: r.description,
      steps: r.stages.flatMap((s) => (s.steps ?? [s.name]).map((text) => ({ id: newId(), plainLanguage: text }))),
      params: r.params,
      script: "",
      version: 1,
      createdWithAiCalls: 0,
      appVersion: "",
      requiredFonts: [],
      runs: [],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, createdAt: now, aiCalls: 0, note: "Built by hand in the dev panel" }],
      modifiesDocument: r.stages.some((s) => s.modifiesDocument),
      qcProfile: r.qcProfile,
      stages: r.stages,
    };
    await this.deps.storage.saveRoutine(routine);
    return { saved: true, routine, issues: [] };
  }
}

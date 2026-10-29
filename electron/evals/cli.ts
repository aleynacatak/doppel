import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FigmaAdapter } from "../adapters/figma/figmaAdapter";
import { FigmaPluginBridge } from "../adapters/figma/pluginBridge";
import { InDesignAdapter } from "../adapters/indesign/indesignAdapter";
import { PhotoshopAdapter } from "../adapters/photoshop/photoshopAdapter";
import { AdapterRegistry } from "../adapters/registry";
import type { DesignAppAdapter } from "../adapters/types";
import { simulatedApps } from "../core/flows/mockAdapters";
import { AiAccessService } from "../core/services/aiAccessService";
import type { RoleConfig } from "../core/ai/gateway";
import type { AiCallContext, AiService } from "../core/services/aiService";
import { AppStatusService } from "../core/services/appStatusService";
import { FlowService } from "../core/services/flowService";
import { LibraryService } from "../core/services/libraryService";
import { ModelAiService } from "../core/services/modelAiService";
import { QcService } from "../core/services/qcService";
import { DEFAULT_CREATION_OPTIONS, RoutineService } from "../core/services/routineService";
import { RunService } from "../core/services/runService";
import { SecretStore } from "../core/services/secretStore";
import { SettingsService } from "../core/services/settingsService";
import { StarterService } from "../core/services/starterService";
import { JsonStorage } from "../core/services/storage";
import { EXAMPLE_ROUTINES } from "../core/templates";
import { writeReports } from "./report";
import { type EvalEnv, type EvalProfile, type Meter, runEval } from "./runner";
import { type EvalTask, loadTasks, selectTasks } from "./tasks";

// `npm run eval -- --profile <ids> --tasks <ids|tag|all> --repeat <n>`: runs inside Electron (headless) with the
// real apps and the AI access saved in Doppl's settings (or DOPPL_EVAL_ACCESS_CODE / DOPPL_EVAL_META_KEY). Each
// attempt gets its own throwaway data folder, so the designer's library is never touched.

export interface CliArgs {
  profiles: string[];
  tasks: string;
  repeat: number;
  tasksDir: string;
  reportsDir: string;
  profilesFile: string;
  notes: string[];
  timeoutMin: number;
}

export function parseArgs(argv: string[], cwd: string): CliArgs {
  const args = argv.slice(argv.indexOf("--doppl-eval") + 1);
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  return {
    profiles: (get("profile") ?? "spark-current").split(",").map((s) => s.trim()).filter(Boolean),
    tasks: get("tasks") ?? "all",
    repeat: Math.max(1, Number(get("repeat") ?? 1) || 1),
    tasksDir: path.resolve(cwd, get("tasks-dir") ?? "evals/tasks"),
    reportsDir: path.resolve(cwd, get("reports") ?? "evals/reports"),
    profilesFile: path.resolve(cwd, get("profiles-file") ?? "evals/profiles.json"),
    notes: all("note"),
    timeoutMin: Number(get("timeout-min") ?? 20) || 20,
  };
}

export async function loadProfiles(file: string, ids: string[]): Promise<EvalProfile[]> {
  const all = JSON.parse(await fs.readFile(file, "utf8")) as EvalProfile[];
  return ids.map((id) => {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`No profile "${id}" in ${path.basename(file)} (profiles: ${all.map((x) => x.id).join(", ")}).`);
    return p;
  });
}

/** Counts calls, tokens, cost and the turns' actions, and keeps the size of the first system prompt. */
export function meteredAi(ai: AiService, meter: () => Meter): AiService {
  const counted = (ctx: AiCallContext): AiCallContext => ({
    ...ctx,
    onAiCall: () => {
      meter().calls++;
      ctx.onAiCall();
    },
    onUsage: (u) => {
      const m = meter();
      m.inputTokens += u.usage?.input ?? 0;
      m.cachedTokens += u.usage?.cached ?? 0;
      m.outputTokens += u.usage?.output ?? 0;
      m.costUsd += u.costUsd;
      if (u.text !== undefined) m.answers?.push({ role: u.role, effort: u.effort, finishReason: u.finishReason, input: u.usage?.input, output: u.usage?.output, text: u.text.length > 4000 ? `${u.text.slice(0, 4000)}…` : u.text });
      ctx.onUsage?.(u);
    },
  });
  return {
    async turn(messages, schema, actions, ctx, options) {
      const m = meter();
      if (!m.contextChars && typeof messages[0]?.content === "string") m.contextChars = messages[0].content.length;
      const t = await ai.turn(messages, schema, actions, counted(ctx), options);
      if (t.action === "preview_routine") m.previews++;
      if (t.action === "propose_routine" || t.action === "propose_revision") m.proposals++;
      return t;
    },
    ...(ai.writeCode ? { writeCode: (messages, lang, ctx) => ai.writeCode!(messages, lang, counted(ctx)) } : {}),
    ...(ai.fieldKey ? { fieldKey: (role, field, first) => ai.fieldKey!(role, field, first) } : {}),
    ...(ai.noteFailedTrial ? { noteFailedTrial: (id) => ai.noteFailedTrial!(id) } : {}),
    ...(ai.modelFor ? { modelFor: (role, id) => ai.modelFor!(role, id) } : {}),
    reviewTrial: (task, draft, outputs, ctx) => ai.reviewTrial(task, draft, outputs, counted(ctx)),
    reviewOutput: (output, ctx) => ai.reviewOutput(output, counted(ctx)),
    checkObjectInRegion: (output, check, ctx) => ai.checkObjectInRegion(output, check, counted(ctx)),
  };
}

/** A simulated app that still gives the model the real guide, script checks and a canned document inspection. */
function simulatedFor(real: DesignAppAdapter, sim: DesignAppAdapter, inspection: unknown): DesignAppAdapter {
  return {
    ...sim,
    capabilityManifest: () => real.capabilityManifest(),
    lintScript: real.lintScript?.bind(real),
    inspectForModel: async () => inspection ?? { note: "Simulated document: no inspection available." },
  };
}

export async function runEvalCli(argv: string[], paths: { userData: string; temp: string }, workerUrl: string, log = (s: string) => console.log(s)): Promise<number> {
  const args = parseArgs(argv, process.cwd());
  const tasks = selectTasks(await loadTasks(args.tasksDir), args.tasks);
  const profiles = await loadProfiles(args.profilesFile, args.profiles);
  log(`Doppl eval: ${tasks.length} task(s) × ${profiles.length} profile(s) × ${args.repeat}`);

  // AI access as saved in Doppl (or from the environment), shared by every attempt.
  const appStorage = new JsonStorage(paths.userData);
  const settings = new SettingsService(appStorage);
  await settings.load();
  const secrets = new SecretStore(paths.userData);
  const envCode = process.env.DOPPL_EVAL_ACCESS_CODE;
  const envKey = process.env.DOPPL_EVAL_META_KEY;
  if (envCode || envKey) {
    const memory: Record<string, string> = { ...(envCode ? { accessCode: envCode } : {}), ...(envKey ? { metaApiKey: envKey } : {}) };
    Object.assign(secrets, { get: async (name: string) => memory[name] ?? null, set: async () => undefined, available: async () => true });
    settings.current.aiProvider = envKey ? "meta-api" : "doppl-demo";
  }
  const access = new AiAccessService({ settings, secrets, workerUrl });
  // Reading the saved code or key may wait for macOS to ask about the Keychain: give up after a while.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    access.ensureReady(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Doppl's saved AI access couldn't be read within 2 minutes (a Keychain prompt may be waiting). Set DOPPL_EVAL_ACCESS_CODE or DOPPL_EVAL_META_KEY instead.")), 120000);
    }),
  ]).finally(() => clearTimeout(timer));
  log(`AI access: ${access.provider()}`);

  // The real apps, shared (they do one thing at a time anyway).
  const bridge = new FigmaPluginBridge(() => settings.current.figmaPairingCode, () => settings.current.figmaPort);
  const timeout = () => settings.current.scriptTimeoutSec;
  const real = new AdapterRegistry([
    new InDesignAdapter({ getTimeoutSec: timeout, onStatusChange: () => undefined }),
    new PhotoshopAdapter({ getTimeoutSec: timeout, onStatusChange: () => undefined }),
    new FigmaAdapter({ getToken: () => secrets.get("figmaToken"), getFiles: () => settings.current.figmaFiles, bridge, getTimeoutSec: timeout }),
  ]);
  const simulated = simulatedApps(real, 20);

  let current: Meter | null = null;
  const meter = () => current!;
  const workDir = path.join(paths.temp, "doppl-evals", new Date().toISOString().replace(/[:.]/g, "-"));
  const env: EvalEnv = {
    async services({ dataDir, task, profile, meter: m }) {
      current = m;
      access.useRoles(profile.roles as Partial<RoleConfig> | undefined);
      let registry = real;
      let documentId: string | undefined;
      if (task.mode === "simulated") {
        const inspection = task.attachments.inspection ? JSON.parse(await fs.readFile(path.resolve(task.dir, task.attachments.inspection), "utf8")) : null;
        registry = new AdapterRegistry(real.list().map((a) => simulatedFor(a, simulated.get(a.id), inspection)));
        documentId = `simulated:${task.app}`;
      }
      const storage = new JsonStorage(path.join(dataDir, "data"));
      const starters = new StarterService(path.join(dataDir, "no-starters"));
      await starters.load();
      const library = new LibraryService({ storage, starters });
      const flows = new FlowService({ storage, library, starters, registry });
      const apps = new AppStatusService(registry, () => undefined);
      const ai = meteredAi(new ModelAiService({ gateway: access.gateway }), meter);
      const qc = new QcService(ai);
      const runs = new RunService({ storage, library, flows, registry, apps, qc, access, emit: () => undefined, runsDir: path.join(dataDir, "runs"), copiesDir: path.join(dataDir, "copies") });
      const routines = new RoutineService({
        storage,
        registry,
        library,
        flows,
        ai,
        access,
        qc,
        getStyle: async () => null,
        apps,
        emit: () => undefined,
        workRoot: path.join(dataDir, "work"),
        templates: EXAMPLE_ROUTINES,
        options: () => ({ ...DEFAULT_CREATION_OPTIONS, ...(profile.creation ?? {}) }),
      });
      return { routines, runs, library, documentId };
    },
  };

  const results = await runEval(env, tasks, profiles, args.repeat, { workDir, timeoutMs: args.timeoutMin * 60 * 1000, log });
  const now = new Date();
  const files = await writeReports(args.reportsDir, results, {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    tasks: tasks.map((t: EvalTask) => t.id),
    repeat: args.repeat,
    notes: [`AI access: ${access.provider()}`, `Machine: ${os.hostname()}`, ...(results.stopped ? [results.stopped] : []), ...args.notes],
  });
  for (const f of files) log(`Report: ${path.relative(process.cwd(), f)}`);
  log(`Work folders: ${workDir}`);
  return results.every((r) => r.passed) ? 0 : 1;
}

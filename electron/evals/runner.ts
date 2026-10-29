import fs from "node:fs/promises";
import path from "node:path";
import { readDataFile } from "../core/helpers/dataFiles";
import { actionFor } from "../core/services/aiTransport";
import type { LibraryService } from "../core/services/libraryService";
import type { RoutineService } from "../core/services/routineService";
import type { RunService } from "../core/services/runService";
import type { Creation, InputValue, ParamValue, PortDef, Routine, Run } from "../core/types";
import { nameFit } from "../core/inputs/inputCheck";
import { type CheckResult, type CheckSubject, runChecks } from "./checks";
import { type EvalTask, resolveAttachment } from "./tasks";
import { type Variant, makeVariant } from "./variants";

// Runs eval tasks through the real creation loop: create, answer questions with the first option, save, rerun the
// saved routine on the task's fixtures (no AI), check the outputs. Metrics come from a meter the AI layer feeds.

/** A named model and creation configuration (evals/profiles.json). */
export interface EvalProfile {
  id: string;
  description?: string;
  /** Creation options (see CreationOptions in routineService). */
  creation?: Record<string, unknown>;
  /** Role → model profile overrides (see ai/roles.json). */
  roles?: Record<string, unknown>;
}

/** What the AI layer reports during one attempt. */
export interface Meter {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  /** preview_routine turns. */
  previews: number;
  /** propose_routine turns. */
  proposals: number;
  /** Characters of the first system prompt (the capability context). */
  contextChars: number;
  /** Every chat answer as it came back (saved as ai-calls.json in the attempt's folder). */
  answers?: { role: string; effort?: string; finishReason?: string | null; input?: number; output?: number; text?: string }[];
}

export const newMeter = (): Meter => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, previews: 0, proposals: 0, contextChars: 0, answers: [] });

export interface AttemptServices {
  routines: RoutineService;
  runs: RunService;
  library: LibraryService;
  /** Simulated tasks: the document id of the simulated app. */
  documentId?: string;
  dispose?: () => Promise<void>;
}

export interface EvalEnv {
  /** Fresh services for one attempt: their own data folder, the profile's AI setup, a meter. */
  services(opts: { dataDir: string; task: EvalTask; profile: EvalProfile; meter: Meter }): Promise<AttemptServices>;
}

export type FailureCategory =
  | "validation"
  | "script-error"
  | "trial-failed"
  | "check-failed"
  | "call-limit"
  | "declined"
  | "ai-error"
  | "needs-input"
  | "timeout"
  | "other";

export interface AttemptResult {
  task: string;
  profile: string;
  repeat: number;
  created: boolean;
  passed: boolean;
  category: FailureCategory | null;
  error?: string;
  /** The AI error's code, when the AI service refused (quota, rate limit…). */
  errorCode?: string;
  aiCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  wallSec: number;
  previews: number;
  proposals: number;
  questions: number;
  contextChars: number;
  /** AI calls made by the rerun (must be 0). */
  rerunAiCalls: number;
  checks: CheckResult[];
  /** The questions asked during the creation, and how the designer (the task) answered. */
  questionLog?: { kind: string; text: string; answer: string }[];
  /** The saved routine rerun on messy versions of the fixtures (see variants.ts). */
  variants?: { id: string; passed: boolean; error?: string; rerunAiCalls: number }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DATA_EXT = new Set([".csv", ".tsv", ".xlsx", ".xls", ".json"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What went wrong in a creation, as a category. */
export function categorize(c: Creation): FailureCategory {
  const e = c.error;
  if (!e) return "other";
  const text = `${e.message} ${e.detail ?? ""}`;
  if (e.kind === "needs-flow") return "declined";
  if (e.code === "creation_call_limit" || /AI limit for one creation/.test(text)) return "call-limit";
  if (e.kind === "ai-access") return "ai-error";
  if (/trial run of the routine failed/i.test(text)) return "trial-failed";
  if (e.kind === "validation") return "validation";
  return "other";
}

/** The task attachment that fits a routine input: by name, then by kind. */
function attachmentFor(port: PortDef, attachments: Record<string, { path: string; isFolder: boolean; files: string[] }>): string | null {
  const names = Object.keys(attachments);
  const byName = names.find((n) => norm(n) === norm(port.key) || norm(n) === norm(port.label));
  if (byName) return byName;
  const isData = (n: string) => !attachments[n].isFolder && DATA_EXT.has(path.extname(attachments[n].path).toLowerCase());
  // What a designer would pick: the attachment of the right kind whose name shares the most words with the input.
  const fit = (n: string) => nameFit(port, { id: n, label: n, kind: "files", items: [] });
  const best = (candidates: string[]) => [...candidates].sort((a, b) => fit(b) - fit(a))[0] ?? null;
  if (port.type === "rows") return best(names.filter(isData));
  if (port.type === "fileList" || port.type === "folder") return best(names.filter((n) => attachments[n].isFolder)) ?? best(names.filter((n) => !isData(n)));
  // A file: one attached file, or a folder with just one file in it.
  if (port.type === "file") return best(names.filter((n) => (!attachments[n].isFolder && !isData(n)) || (attachments[n].isFolder && attachments[n].files.length === 1)));
  return null;
}

/** The option the task's designer picks: its "answers" rule for the question, else the recommended (first) one. */
export function chooseAnswer(task: Pick<EvalTask, "answers">, q: { text: string; options: { id: string; label: string }[] }) {
  for (const a of task.answers) {
    if (!new RegExp(a.question, "i").test(q.text)) continue;
    const re = new RegExp(a.choose, "i");
    const option = q.options.find((o) => re.test(o.label) || re.test(o.id));
    if (option) return option;
  }
  return q.options[0];
}

async function waitFor<T>(get: () => T | null, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v && done(v)) return v;
    if (Date.now() - start > timeoutMs) throw Object.assign(new Error("timed out"), { timeout: true });
    await sleep(250);
  }
}

export interface RunnerOptions {
  /** Folder for each attempt's data and outputs. */
  workDir: string;
  /** Per attempt (creation plus rerun). */
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Wait after the AI service rate limits an attempt, before trying it again. */
  rateLimitWaitMs?: number;
  /** Messy versions of the fixtures to rerun the saved routine on, after it passes. */
  variants?: Variant[];
}

export async function runAttempt(env: EvalEnv, task: EvalTask, profile: EvalProfile, repeat: number, opts: RunnerOptions): Promise<AttemptResult> {
  const log = opts.log ?? (() => undefined);
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const meter = newMeter();
  const dataDir = path.join(opts.workDir, `${task.id}-${profile.id}-${repeat}`);
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
  const started = Date.now();
  const result: AttemptResult = {
    task: task.id,
    profile: profile.id,
    repeat,
    created: false,
    passed: false,
    category: null,
    aiCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallSec: 0,
    previews: 0,
    proposals: 0,
    questions: 0,
    contextChars: 0,
    rerunAiCalls: 0,
    checks: [],
  };
  const finish = () => {
    Object.assign(result, {
      aiCalls: meter.calls,
      inputTokens: meter.inputTokens,
      cachedTokens: meter.cachedTokens,
      outputTokens: meter.outputTokens,
      costUsd: Math.round(meter.costUsd * 10000) / 10000,
      previews: meter.previews,
      proposals: meter.proposals,
      contextChars: meter.contextChars,
      wallSec: Math.round((Date.now() - started) / 100) / 10,
    });
    return result;
  };

  const services = await env.services({ dataDir, task, profile, meter });
  try {
    const attachments: Record<string, { path: string; isFolder: boolean; files: string[] }> = {};
    for (const name of Object.keys(task.attachments.inputs ?? {})) attachments[name] = await resolveAttachment(task, name);
    const all = Object.values(attachments);

    // 1. Create.
    log(`${task.id} · ${profile.id} #${repeat}: creating`);
    let c = await services.routines.create({
      request: task.request,
      references: all.filter((a) => !a.isFolder).map((a) => a.path),
      folders: all.filter((a) => a.isFolder).map((a) => a.path),
      appId: task.app,
      apps: [services.documentId ? { appId: task.app, documentId: services.documentId } : { appId: task.app, noDocument: true }],
    });
    const deadline = started + timeoutMs;
    for (;;) {
      c = await waitFor(
        () => services.routines.getCreation(c.id),
        (x) => x.status !== "running",
        Math.max(1000, deadline - Date.now()),
      );
      if (c.status === "waiting" && c.question) {
        result.questions++;
        const option = chooseAnswer(task, c.question);
        (result.questionLog ??= []).push({ kind: c.question.kind ?? "ai", text: c.question.text, answer: option.label });
        log(`  question: ${c.question.text} → ${option.label}`);
        await services.routines.answer(c.id, c.question.id, option.id);
        await sleep(300);
        continue;
      }
      break;
    }
    if (c.status !== "ready" || !c.draft) {
      result.category = c.status === "waiting" ? "needs-input" : categorize(c);
      result.error = c.error ? `${c.error.message}${c.error.detail ? ` (${c.error.detail.slice(0, 300)})` : ""}` : `creation ended as ${c.status}`;
      result.errorCode = c.error?.code;
      log(`  creation failed: ${result.category}: ${result.error}`);
      return finish();
    }
    let saved = await services.routines.save(c.id, { name: c.draft.name });
    if (!saved.saved) saved = await services.routines.save(c.id, { name: c.draft.name, acceptPortabilityIssues: true });
    const routine = saved.routine as Routine;
    result.created = true;

    // 2. Rerun the saved routine on some inputs, each file output into its own folder, and 3. check the outputs.
    const rerunOn = async (atts: typeof attachments, outDir: string, label: string) => {
      const inputs: Record<string, InputValue> = {};
      const missing: string[] = [];
      for (const port of routine.inputs) {
        if (port.type === "document") {
          if (services.documentId) inputs[`input-${port.key}`] = services.documentId;
          continue;
        }
        const name = attachmentFor(port, atts);
        if (!name) {
          if (port.required) missing.push(port.label);
          continue;
        }
        const a = atts[name];
        inputs[`input-${port.key}`] = port.type === "fileList" ? (a.isFolder ? a.path : [a.path]) : port.type === "file" && a.isFolder ? a.files[0] : a.path;
      }
      if (missing.length) return { missing: `No fixture fits the routine's inputs: ${missing.join(", ")}` };
      const outputFolders: Record<string, string> = {};
      for (const port of routine.outputs) if (port.type === "file" || port.type === "fileList") outputFolders[`output-${port.key}`] = path.join(outDir, port.key);
      const settings: Record<string, ParamValue> = Object.fromEntries(routine.settings.map((s) => [s.key, (s.default ?? null) as ParamValue]));
      log(`  rerunning on ${label}`);
      const before = meter.calls;
      let run: Run = await services.runs.start(
        { kind: "routine", id: routine.id },
        { inputs, outputFolders, settings, qcMode: "manual", options: { target: "copy" } },
        task.mode === "simulated" ? { dev: { mocked: true, failNodes: [], failItems: {} } } : {},
      );
      run = (await waitForStored(services.runs, run.id, deadline)) ?? run;
      const files: Record<string, string[]> = {};
      for (const port of routine.outputs) files[port.key] = run.outputs.filter((o) => o.node === `output-${port.key}` && o.status === "done" && o.filePath).map((o) => o.filePath!);
      const texts = run.outputs.filter((o) => o.node === "routine").flatMap((o) => [o.label, ...(o.details ?? []).map((d) => `${d.label} ${d.value ?? ""}`)]);
      const counts: CheckSubject["inputs"] = {};
      for (const [name, a] of Object.entries(atts)) {
        const data = !a.isFolder && DATA_EXT.has(path.extname(a.path).toLowerCase());
        counts[name] = { files: a.files, rows: data ? (await readDataFile(a.path).catch(() => ({ rows: [] }))).rows.length : 0 };
      }
      const errors = [...(run.error ? [run.error] : []), ...run.outputs.filter((o) => o.status === "failed").map((o) => `${o.label}: ${o.error ?? "failed"}`)];
      const checks = await runChecks(task.checks, {
        ports: routine.outputs,
        files,
        texts: Object.fromEntries(routine.outputs.map((p) => [p.key, texts])),
        inputs: counts,
        run: { status: run.status, errors },
        questions: (result.questionLog ?? []).map((q) => ({ kind: q.kind, text: q.text })),
        outputs: run.outputs.filter((o) => o.node === "routine" && o.status === "done").map((o) => ({ label: o.label, details: (o.details ?? []).map((d) => `${d.label} ${d.value ?? ""}`) })),
      });
      const passed = checks.every((r) => r.passed);
      return {
        checks,
        passed,
        aiCalls: meter.calls - before,
        failedRun: run.status === "failed" || errors.length > 0,
        error: passed ? undefined : checks.filter((r) => !r.passed).map((r) => `${r.check.type}: ${r.detail}`).join(" | "),
      };
    };

    const first = await rerunOn(attachments, path.join(dataDir, "outputs"), "the fixtures");
    if ("missing" in first) {
      result.category = "needs-input";
      result.error = first.missing;
      return finish();
    }
    result.rerunAiCalls = first.aiCalls;
    result.checks = first.checks;
    result.passed = first.passed;
    if (!result.passed) result.category = first.failedRun ? "script-error" : "check-failed";
    if (!result.passed) result.error = first.error;
    log(`  ${result.passed ? "PASSED" : `failed: ${result.error}`}`);

    // 4. The same routine on messy versions of the fixtures (renamed files, other formats, extra files): no AI.
    if (result.passed && opts.variants?.length) {
      result.variants = [];
      for (const variant of opts.variants) {
        const dir = path.join(dataDir, "variants", variant.id);
        const atts = await makeVariant(variant, attachments, path.join(dir, "inputs"));
        const r = await rerunOn(atts, path.join(dir, "outputs"), `the “${variant.id}” version`);
        const entry = "missing" in r ? { id: variant.id, passed: false, error: r.missing, rerunAiCalls: 0 } : { id: variant.id, passed: r.passed, error: r.error, rerunAiCalls: r.aiCalls };
        result.variants.push(entry);
        log(`    ${variant.id}: ${entry.passed ? "passed" : `failed: ${entry.error}`}`);
      }
    }
    return finish();
  } catch (err) {
    result.category = (err as { timeout?: boolean }).timeout ? "timeout" : "other";
    result.error = (err as Error).message;
    log(`  error: ${result.error}`);
    return finish();
  } finally {
    // What the AI answered and what Doppl replied, for reading a failure afterwards.
    const transcript = services.routines.lastTranscript();
    if (transcript) await fs.writeFile(path.join(dataDir, "transcript.json"), JSON.stringify(transcript, null, 2)).catch(() => undefined);
    if (meter.answers?.length) await fs.writeFile(path.join(dataDir, "ai-calls.json"), JSON.stringify(meter.answers, null, 2)).catch(() => undefined);
    await services.dispose?.().catch(() => undefined);
  }
}

async function waitForStored(runs: RunService, id: string, deadline: number): Promise<Run | null> {
  for (;;) {
    const run = await runs.get(id);
    if (run && run.status !== "running") return run;
    if (Date.now() > deadline) throw Object.assign(new Error("timed out"), { timeout: true });
    await sleep(250);
  }
}

/** AI access that ran out or isn't set up: no later attempt could succeed. */
const accessEnded = (code?: string) => !!code && ["own-key", "settings"].includes(actionFor(code));

/**
 * Every task × repeat × profile, one after another (apps can only do one thing at a time). Profiles take turns, so a
 * run that stops early still compares them on the same tasks. A rate-limited attempt waits and runs again; when AI
 * access runs out the run stops (that attempt measured nothing and is left out) and `stopped` says why.
 */
export async function runEval(env: EvalEnv, tasks: EvalTask[], profiles: EvalProfile[], repeat: number, opts: RunnerOptions): Promise<AttemptResult[] & { stopped?: string }> {
  const results: AttemptResult[] & { stopped?: string } = [];
  for (const task of tasks) {
    for (let r = 1; r <= repeat; r++) {
      for (const profile of profiles) {
        let result = await runAttempt(env, task, profile, r, opts);
        for (let retry = 0; retry < 2 && result.errorCode === "rate_limited"; retry++) {
          opts.log?.(`  rate limited: waiting ${Math.round((opts.rateLimitWaitMs ?? 60_000) / 1000)} s`);
          await sleep(opts.rateLimitWaitMs ?? 60_000);
          result = await runAttempt(env, task, profile, r, opts);
        }
        if (accessEnded(result.errorCode)) {
          results.stopped = `Stopped after ${results.length} attempt(s): ${result.error}`;
          opts.log?.(results.stopped);
          return results;
        }
        results.push(result);
      }
    }
  }
  return results;
}

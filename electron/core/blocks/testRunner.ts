import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterSource } from "../flows/nodeRunner";
import type { StageRunContext } from "../../adapters/types";
import type { AppStatus, Stage } from "../types";
import { newId } from "../util";
import { runChecks } from "../../evals/checks";
import { fixturePath } from "./fixtures";
import type { BlockRegistry } from "./registry";
import type { CompositeAction, HelperDef, HelperTest, HelperTestResult, StageBlocks } from "./types";

export type { HelperTestResult };

// Runs building block tests in the real apps: each test script runs once with the block under test in the library
// (in place of its other versions), on generated fixtures or recorded inputs, and its files and data are checked.

export interface TestDeps {
  adapters: AdapterSource;
  registry: BlockRegistry;
  statusOf: (appId: Stage["appId"]) => Promise<AppStatus>;
  workRoot: string;
  /** Figma: the document (with the test's template frames) to run on. */
  documentFor?: (appId: Stage["appId"]) => string | undefined;
}

/** The blocks a test runs with: the app's blocks at their first versions, with the block under test swapped in. */
function blocksWith(def: HelperDef, registry: BlockRegistry): StageBlocks {
  const base = registry.select(def.app);
  const list = base.some((d) => d.id === def.id) ? base.map((d) => (d.id === def.id ? def : d)) : [...base, def];
  if (def.app === "figma") return { composites: Object.fromEntries(list.map((d) => [d.call, JSON.parse(d.code) as CompositeAction])) };
  return { code: list.map((d) => ({ id: d.id, version: d.version, code: d.code })) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function runOne(def: HelperDef, test: HelperTest, deps: TestDeps): Promise<HelperTestResult> {
  const base = { helper: def.id, version: def.version, test: test.name };
  const adapter = deps.adapters.get(def.app);
  if ((await deps.statusOf(def.app).catch(() => "not-running")) !== "connected") return { ...base, passed: false, skipped: `${adapter.name} isn't open`, detail: "" };
  const documentId = def.app === "figma" ? deps.documentFor?.(def.app) : undefined;
  if (def.app === "figma" && !documentId) return { ...base, passed: false, skipped: "No Figma file with the Doppl plugin", detail: "" };
  const workDir = path.join(deps.workRoot, `${def.id}-${newId().slice(0, 6)}`);
  await fs.mkdir(workDir, { recursive: true });
  const params: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(test.inputs)) {
    const p = await fixturePath(input, path.join(deps.workRoot, "fixtures"));
    try {
      await fs.access(p);
    } catch {
      return { ...base, passed: false, skipped: `Input ${path.basename(p)} isn't there anymore`, detail: "" };
    }
    params[name] = p;
  }
  const stage: Stage = {
    id: "helper-test",
    name: `Test of ${def.call}`,
    appId: def.app,
    kind: def.app === "figma" ? "actions" : "script",
    body: def.app === "figma" ? { actions: JSON.parse(test.script) } : test.script,
    outputs: [{ key: "files", type: "fileList" }],
    document: documentId ? "open" : "none",
    blocks: blocksWith(def, deps.registry),
  };
  const ctx: StageRunContext = {
    runId: `blocktest-${newId().slice(0, 8)}`,
    routineName: stage.name,
    stage,
    documentId,
    target: "trial",
    workDir,
    copiesDir: path.join(workDir, "copies"),
    isCancelled: () => false,
  };
  const session = await adapter.beginStage(ctx);
  try {
    const res = await adapter.runStageItem(session, { key: "test", label: test.name, index: 0, item: null, params, body: stage.body }, ctx, () => undefined);
    const files = res.outputs.filter((o) => o.filePath).map((o) => o.filePath!);
    const checks = await runChecks(test.checks, {
      ports: [{ key: "files", label: "Files", type: "fileList", required: false }],
      files: { files },
      texts: { files: res.outputs.flatMap((o) => [o.label, ...(o.details ?? []).map((d) => `${d.label} ${d.value ?? ""}`)]) },
      inputs: {},
      run: { status: res.ok ? "succeeded" : "failed", errors: res.ok ? [] : [res.error ?? "failed"] },
    });
    const data = (res.data ?? {}) as Record<string, unknown>;
    const wrong = Object.entries(test.expect ?? {}).filter(([k, v]) => !same(data[k], v));
    const problems = [
      ...(res.ok ? [] : [res.error ?? "The test script failed."]),
      ...checks.filter((c) => !c.passed).map((c) => `${c.check.type}: ${c.detail}`),
      ...wrong.map(([k, v]) => `${k} is ${JSON.stringify(data[k])}, expected ${JSON.stringify(v)}`),
    ];
    return { ...base, passed: problems.length === 0, detail: problems.join(" · ") || "passed" };
  } catch (err) {
    return { ...base, passed: false, detail: (err as Error).message };
  } finally {
    await adapter.endStage(session, ctx).catch(() => undefined);
    await adapter.endRun?.(ctx.runId).catch(() => undefined);
  }
}

/** Every test of the given blocks, one after another. */
export async function runHelperTests(defs: HelperDef[], deps: TestDeps, log: (line: string) => void = () => undefined): Promise<HelperTestResult[]> {
  const results: HelperTestResult[] = [];
  for (const def of defs) {
    for (const test of def.tests) {
      const r = await runOne(def, test, deps);
      log(`${r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL"} ${def.id} v${def.version} · ${test.name}${r.skipped ? ` (${r.skipped})` : r.passed ? "" : `: ${r.detail}`}`);
      results.push(r);
    }
  }
  return results;
}

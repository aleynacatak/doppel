import fs from "node:fs/promises";
import path from "node:path";
import { splitAnswer } from "../ai/answer";
import type { AiCallContext, AiService } from "../services/aiService";
import { findPortabilityIssues } from "../services/portability";
import type { AppId, Routine, Run } from "../types";
import { newId, nowIso } from "../util";
import { similarity, tagSteps } from "./analysis";
import { expandComposites } from "./composites";
import type { BlockRegistry } from "./registry";
import type { BlockCandidate, CompositeAction, HelperDef, HelperTestResult } from "./types";

// Growing the building block library from the designer's own routines:
// 1. Capture: after a routine is saved, each step written as custom code becomes a candidate
//    (userData/helpers/candidates/<id>.json). Code similar to an existing candidate merges into it: written twice.
// 2. Evidence: real runs, "Mark as OK", "This isn't right" and refines update each candidate's stats (no AI).
// 3. Generalize (dev panel, one AI call): the coder turns a candidate into a parameterized block with docs and tests
//    from its recorded trial inputs; Doppl lints it and runs its tests in the app.
// 4. Approve: the block joins the designer's library ("promoted") and future creations can use it. Routines that
//    already have the custom code keep it until they take the block (Improved building block available).
// 5. Export as built-in (dev panel): writes it to electron/helpers/exported.json without anything personal.
// Automatic promotion follows a rule (off by default); it runs only after a creation is saved, never on reruns.

/** Code this similar (0–1) to a candidate is the same candidate. */
export const SIMILAR = 0.75;
/** Custom code shorter than this isn't worth a block. */
const MIN_CODE = 60;

export const PROMOTION_RULE = { minRoutines: 2, minItems: 5 };

const PREFIX: Record<AppId, string> = { photoshop: "ps", indesign: "id", figma: "figma" };

export function scoreOf(c: BlockCandidate): number {
  const routines = new Set(c.occurrences.map((o) => o.routineId)).size;
  const e = c.evidence;
  const qc = e.qcChecked ? e.qcPassed / e.qcChecked : 0;
  return Math.round((10 * (routines - 1) + 3 * c.occurrences.length + 2 * Math.log2(1 + e.successfulItems) + 3 * qc + e.markedOk - 5 * e.notRight - 2 * e.refineTouches) * 10) / 10;
}

/** Whether automatic promotion may promote a candidate (it still needs passing tests after generalizing). */
export function promotionDecision(c: BlockCandidate, rule = PROMOTION_RULE): { eligible: boolean; reasons: string[] } {
  const routines = new Set(c.occurrences.map((o) => o.routineId)).size;
  const reasons: string[] = [];
  if (routines < rule.minRoutines) reasons.push(`used in ${routines} routine(s), needs ${rule.minRoutines}`);
  if (c.evidence.successfulItems < rule.minItems) reasons.push(`${c.evidence.successfulItems} successful items, needs ${rule.minItems}`);
  if (c.evidence.notRight > 0) reasons.push(`${c.evidence.notRight} "This isn't right"`);
  if (c.evidence.refineTouches > 0) reasons.push(`changed by ${c.evidence.refineTouches} refine(s)`);
  if (c.status !== "candidate" && c.status !== "generalized") reasons.push(`already ${c.status}`);
  return { eligible: reasons.length === 0, reasons };
}

const GENERALIZE_SYSTEM = (app: AppId) => `You turn code a designer's routines already use into a reusable building block for Doppl, a desktop app that
automates ${app === "figma" ? "Figma" : app === "indesign" ? "InDesign" : "Photoshop"}. A building block is ${
  app === "figma"
    ? 'a composite action: a named macro of catalog actions with parameters ({{args.<param>}}), { "$each": "{{args.<object or list>}}", "do": action } to repeat an action ({{each.key}}/{{each.value}} or {{each.item}}/{{each.index}}), inner "id"s, and a "result" id.'
    : `one ExtendScript (ES3) function that does one job well, with parameters instead of anything specific to one routine (values, layer names, file names). ES3 only: var, no arrow functions, no template literals, no forEach/map; it throws a plain Error when something is wrong (never hides a failure in an empty catch); it never deletes files, uses the network, eval or dialogs, and saves only through exportImage/saveCopy.`
}

Answer with ONE JSON object, then ONE fenced block with the code${app === "figma" ? " (```json: the composite action)" : " (```javascript: the function definition)"}.
The JSON: { "call": "<function name, camelCase, new>", "set": "<group: masking, layers, export, color, text, …>", "summary": "<one line>",
"signature": { "params": [{ "name", "type", "optional"?, "doc"? }], "returns": "<type>" }, "sideEffects": ["…"],
"doc": "<what it does, its options, and one usage example>", "tests": [{ "name", "inputs": { "<param name>": "<one of the recorded input files, or gen:product-on-white / gen:ring-on-white / gen:photo / gen:red>" },
"script": "<a short script that calls the block on params.<input> and writes files with ctx.output(\\"files\\", path) or returns data>",
"checks": [{ "type": "fileExtension" | "imageSize" | "hasTransparency" | "cornerPixelsTransparent" | "noOpaqueWhite" | "outerWhiteRemoved" | "outputCount", "port": "files", … }], "expect": { … } }] }.
Write at least one test.`;

export interface BlockDeps {
  /** userData/helpers/candidates */
  dir: string;
  registry: BlockRegistry;
  ai: AiService;
  /** The app's script checks (the same as for routines). */
  lint: (app: AppId, code: string) => string[];
  runTests: (def: HelperDef) => Promise<HelperTestResult[]>;
  /** Dev setting: automatic promotion (off by default). */
  autoPromote: () => boolean;
  /** An AI context for one generalization (its own budget). */
  aiContext: (label: string) => AiCallContext;
  onPromoted?: (def: HelperDef) => void;
}

export class BlockService {
  constructor(private readonly deps: BlockDeps) {}

  private file(id: string) {
    return path.join(this.deps.dir, `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);
  }

  async list(): Promise<BlockCandidate[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.deps.dir);
    } catch {
      return [];
    }
    const all = await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map(async (n) => {
          try {
            return JSON.parse(await fs.readFile(path.join(this.deps.dir, n), "utf8")) as BlockCandidate;
          } catch {
            return null;
          }
        }),
    );
    return all.filter((c): c is BlockCandidate => !!c).sort((a, b) => b.score - a.score);
  }

  async get(id: string): Promise<BlockCandidate> {
    const c = (await this.list()).find((x) => x.id === id);
    if (!c) throw new Error("That candidate isn't there anymore.");
    return c;
  }

  private async save(c: BlockCandidate) {
    c.score = scoreOf(c);
    c.updatedAt = nowIso();
    await fs.mkdir(this.deps.dir, { recursive: true });
    await fs.writeFile(this.file(c.id), JSON.stringify(c, null, 2));
  }

  /**
   * After a routine is saved: its custom steps become candidates (or add to similar ones). With the version it
   * replaced (a refine), candidates whose code the refine changed count that.
   */
  async capture(routine: Routine, info: { request: string; trialItems: number; trialOk: number; inputs: string[] }, previous?: Routine): Promise<BlockCandidate[]> {
    const latest = this.deps.registry.latest(routine.appId);
    // Scripts: each custom step. Figma: the whole action list (a pattern written twice can become a composite block).
    const actions = (routine.actions ?? []) as { action?: string }[];
    const units: [number, string][] =
      routine.kind === "actions"
        ? actions.length >= 3 && !actions.every((a) => a.action === "block")
          ? [[0, JSON.stringify(actions, null, 1)]]
          : []
        : [...tagSteps(routine, latest).customCode.entries()].filter(([, code]) => code.replace(/\s+/g, "").length >= MIN_CODE);
    const all = await this.list();
    const touched: BlockCandidate[] = [];
    if (previous) {
      for (const c of all.filter((x) => x.occurrences.some((o) => o.routineId === previous.id))) {
        if (!units.some(([, code]) => similarity(code, c.code) >= 0.95)) {
          c.evidence.refineTouches++;
          await this.save(c);
        }
      }
    }
    for (const [n, code] of units) {
      const occurrence = {
        routineId: routine.id,
        routineName: routine.name,
        version: routine.version,
        step: n === 0 ? routine.steps.map((s) => s.plainLanguage).join(" / ") : (routine.steps[n - 1]?.plainLanguage ?? `Step ${n}`),
        request: info.request,
        savedAt: nowIso(),
        trial: { items: info.trialItems, ok: info.trialOk, inputs: info.inputs.slice(0, 5) },
      };
      const match = all.filter((c) => c.app === routine.appId && c.status !== "dismissed").find((c) => similarity(code, c.code) >= SIMILAR);
      if (match) {
        const same = match.occurrences.find((o) => o.routineId === routine.id);
        if (same) Object.assign(same, occurrence);
        else match.occurrences.push(occurrence);
        await this.save(match);
        touched.push(match);
        continue;
      }
      const c: BlockCandidate = {
        id: newId().slice(0, 12),
        app: routine.appId,
        code,
        occurrences: [occurrence],
        evidence: { successfulItems: 0, inputKeys: [], qcPassed: 0, qcChecked: 0, markedOk: 0, notRight: 0, refineTouches: 0 },
        score: 0,
        status: "candidate",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await this.save(c);
      all.push(c);
      touched.push(c);
    }
    if (this.deps.autoPromote()) await this.autoPromote().catch(() => undefined);
    return touched;
  }

  /** A finished run: successful items, distinct inputs and checks for the candidates of the routines it ran. */
  async recordRun(run: Run, routineOfNode: Record<string, string>) {
    const all = await this.list();
    for (const [nodeId, routineId] of Object.entries(routineOfNode)) {
      const mine = all.filter((c) => c.occurrences.some((o) => o.routineId === routineId));
      if (!mine.length) continue;
      const outputs = run.outputs.filter((o) => o.node === nodeId);
      const byItem = new Map<string, typeof outputs>();
      for (const o of outputs) byItem.set(o.itemKey ?? o.id, [...(byItem.get(o.itemKey ?? o.id) ?? []), o]);
      const ok = [...byItem.entries()].filter(([, os]) => os.every((o) => o.status === "done"));
      for (const c of mine) {
        c.evidence.successfulItems += ok.length;
        const keys = new Set(c.evidence.inputKeys);
        for (const [key, os] of ok) keys.add(`${routineId}:${os[0].itemLabel ?? key}`);
        c.evidence.inputKeys = [...keys].slice(-500);
        c.evidence.qcChecked += outputs.filter((o) => o.qc).length;
        c.evidence.qcPassed += outputs.filter((o) => o.qc?.status === "pass" || o.markedOk).length;
        await this.save(c);
      }
    }
  }

  /** "Mark as OK" or "This isn't right" on an output of these routines. */
  async noteFeedback(routineIds: string[], kind: "ok" | "notRight") {
    for (const c of (await this.list()).filter((x) => x.occurrences.some((o) => routineIds.includes(o.routineId)))) {
      if (kind === "ok") c.evidence.markedOk++;
      else c.evidence.notRight++;
      await this.save(c);
    }
  }

  async dismiss(id: string): Promise<BlockCandidate> {
    const c = await this.get(id);
    c.status = "dismissed";
    await this.save(c);
    return c;
  }

  /** Blocks promoted from this routine's own custom code that it doesn't use yet (a refine can switch to them). */
  adoptable(routine: Routine): { id: string; call: string; summary: string }[] {
    return this.deps.registry
      .latest(routine.appId)
      .filter((d) => d.source === "promoted" && d.origin?.routines.includes(routine.id) && !routine.helpers?.[d.id])
      .map((d) => ({ id: d.id, call: d.call, summary: d.summary }));
  }

  /** One AI call (coder): a parameterized block with docs and tests, then lint and tests. */
  async generalize(id: string, ctx: AiCallContext = this.deps.aiContext(`block-${id}`)): Promise<BlockCandidate> {
    const c = await this.get(id);
    if (!this.deps.ai.text) throw new Error("Generalizing needs AI access.");
    const existing = this.deps.registry.latest(c.app);
    const inputs = [...new Set(c.occurrences.flatMap((o) => o.trial.inputs))];
    const answer = await this.deps.ai.text(
      "coder",
      [
        { role: "system", content: GENERALIZE_SYSTEM(c.app) },
        {
          role: "user",
          content: [
            `Custom code from ${c.occurrences.length} routine step(s):`,
            ...c.occurrences.map((o) => `- "${o.step}" in "${o.routineName}" (asked: "${o.request.slice(0, 200)}")`),
            `The code:\n\`\`\`${c.app === "figma" ? "json" : "javascript"}\n${c.code}\n\`\`\``,
            `Recorded trial inputs for tests: ${inputs.join(", ") || "none (use a gen: fixture)"}`,
            `Existing blocks (don't repeat them; you may call them): ${existing.map((d) => d.call).join(", ")}`,
          ].join("\n"),
        },
      ],
      ctx,
    );
    const { json, blocks } = splitAnswer(answer);
    if (!json || !blocks.length) throw new Error("The AI's answer had no block definition and code. Try Generalize again.");
    const call = String(json.call ?? "").replace(/[^A-Za-z0-9_$]/g, "");
    if (!call) throw new Error('The AI\'s answer has no "call" name.');
    const blockId = `${PREFIX[c.app]}.${call}`;
    const def: HelperDef = {
      id: blockId,
      version: (this.deps.registry.versions(blockId).at(-1) ?? 0) + 1,
      app: c.app,
      set: String(json.set ?? "custom"),
      call,
      summary: String(json.summary ?? "").slice(0, 200),
      signature: { params: Array.isArray(json.signature?.params) ? json.signature.params : [], returns: String(json.signature?.returns ?? "nothing") },
      sideEffects: Array.isArray(json.sideEffects) ? json.sideEffects.map(String) : [],
      doc: String(json.doc ?? ""),
      source: "promoted",
      tests: Array.isArray(json.tests) ? json.tests : [],
      code: blocks[0].code.trim(),
      origin: { candidateId: c.id, routines: [...new Set(c.occurrences.map((o) => o.routineId))], promotedAt: "" },
    };
    const lint = this.check(def, existing);
    c.draft = { def, lint, tests: lint.length ? [] : await this.deps.runTests(def) };
    c.status = "generalized";
    await this.save(c);
    return c;
  }

  /** Problems that keep a block out of the library: the routine script checks, plus its shape. */
  check(def: HelperDef, existing: HelperDef[] = this.deps.registry.latest(def.app)): string[] {
    const problems: string[] = [];
    if (!def.tests.length) problems.push("It needs at least one test.");
    if (existing.some((d) => d.call === def.call && d.id !== def.id)) problems.push(`"${def.call}" is already a building block's name.`);
    if (def.app === "figma") {
      try {
        const composite = JSON.parse(def.code) as CompositeAction;
        if (!Array.isArray(composite.actions) || !composite.actions.length) problems.push("The composite action has no actions.");
        for (const t of def.tests) {
          const expanded = expandComposites(JSON.parse(t.script), { [def.call]: composite });
          problems.push(...expanded.problems);
        }
      } catch (err) {
        problems.push(`The composite action isn't valid JSON: ${(err as Error).message}`);
      }
      return problems;
    }
    if (!new RegExp(`function\\s+${def.call}\\s*\\(`).test(def.code)) problems.push(`The code must define function ${def.call}(…).`);
    problems.push(...this.deps.lint(def.app, def.code));
    for (const issue of findPortabilityIssues(def.code)) problems.push(`${issue.message}: ${issue.text}`);
    return problems;
  }

  /** Into the designer's library (its tests must not fail; skipped ones are the designer's call). */
  async approve(id: string): Promise<BlockCandidate> {
    const c = await this.get(id);
    if (!c.draft) throw new Error("Generalize it first.");
    if (c.draft.lint.length) throw new Error(`It can't be approved yet: ${c.draft.lint.join(" ")}`);
    const failed = c.draft.tests.filter((t) => !t.passed && !t.skipped);
    if (failed.length) throw new Error(`Its tests fail: ${failed.map((t) => `${t.test}: ${t.detail}`).join(" · ")}`);
    const def: HelperDef = { ...c.draft.def, source: "promoted", origin: { ...c.draft.def.origin!, promotedAt: nowIso() } };
    await this.deps.registry.savePersonal(def);
    c.status = "promoted";
    c.promoted = { id: def.id, version: def.version };
    await this.save(c);
    this.deps.onPromoted?.(def);
    return c;
  }

  /** The block as a built-in: nothing personal (origin, recorded files, paths) is kept. */
  exportable(def: HelperDef): HelperDef {
    const tests = def.tests.filter((t) => Object.values(t.inputs).every((i) => i.startsWith("gen:")));
    const { origin: _origin, ...rest } = def;
    return { ...rest, source: "builtin", tests };
  }

  /** Writes a promoted block into a built-in blocks file (electron/helpers/exported.json in the repo). */
  async exportBuiltin(id: string, file: string): Promise<{ file: string; warnings: string[] }> {
    const c = await this.get(id);
    if (!c.promoted) throw new Error("Approve it first.");
    const def = this.deps.registry.get(c.promoted.id, c.promoted.version);
    if (!def) throw new Error("The promoted block isn't in the library anymore.");
    const out = this.exportable(def);
    const warnings: string[] = [];
    if (!out.tests.length) warnings.push("Its tests use your files, so none were exported: add a test with a gen: fixture before shipping it.");
    for (const issue of findPortabilityIssues(`${out.code}\n${out.doc}`)) warnings.push(`${issue.message}: ${issue.text}`);
    let list: HelperDef[] = [];
    try {
      list = JSON.parse(await fs.readFile(file, "utf8")) as HelperDef[];
    } catch {
      list = [];
    }
    list = [...list.filter((d) => !(d.id === out.id && d.version === out.version)), out];
    await fs.writeFile(file, `${JSON.stringify(list, null, 2)}\n`);
    return { file, warnings };
  }

  /** The automatic promotion rule: eligible candidates are generalized, tested and promoted when their tests pass. */
  async autoPromote(): Promise<BlockCandidate[]> {
    const promoted: BlockCandidate[] = [];
    for (const c of await this.list()) {
      if (!promotionDecision(c).eligible) continue;
      const g = c.status === "generalized" && c.draft ? c : await this.generalize(c.id);
      const tests = g.draft?.tests ?? [];
      if (!g.draft || g.draft.lint.length || !tests.some((t) => t.passed) || tests.some((t) => !t.passed && !t.skipped)) continue;
      promoted.push(await this.approve(g.id));
    }
    return promoted;
  }
}

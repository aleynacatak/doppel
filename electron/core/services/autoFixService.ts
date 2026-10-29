import type { Creation, Run, RunFix } from "../types";
import { errorMessage } from "../util";
import type { AiAccessService } from "./aiAccessService";
import { ROUTINE_NODE } from "./flowService";
import type { LibraryService } from "./libraryService";
import type { RoutineService } from "./routineService";
import type { RunService } from "./runService";

// After a run where items failed because of the routine itself (not the designer's files, not an app), Doppl adapts
// the routine with AI on its own, as a refine: tried on the failed items and one that worked, saved as a new
// version only when they all work and the routine's inputs and outputs stay the same, then the failed items run
// again. The previous version stays restorable. Small budget, no questions.

/** AI calls one fix may use. */
export const AUTO_FIX_CALLS = 5;
const WAIT_MS = 10 * 60 * 1000;

export class AutoFixService {
  constructor(
    private readonly deps: {
      routines: RoutineService;
      runs: RunService;
      library: LibraryService;
      access: Pick<AiAccessService, "ensureReady">;
      /** For tests: how often to look at the fix's progress. */
      pollMs?: number;
    },
  ) {}

  /** The routine's own failures in a routine run, or none. A rerun after a fix, or a flow run, isn't fixed again here. */
  private failures(run: Run) {
    if (run.target.kind !== "routine" || run.mocked || run.autoFixOf || run.status === "cancelled") return [];
    return run.outputs.filter((o) => o.status === "failed" && o.node === ROUTINE_NODE && o.cause === "routine" && o.itemKey);
  }

  /** Called when a run ends: fixes the routine when its items failed because of it. */
  async consider(run: Run): Promise<void> {
    const failed = this.failures(run);
    if (!failed.length) return;
    const routine = await this.deps.library.get(run.target.id);
    if (!routine || routine.starter) return;
    const fix: RunFix = { status: "fixing", routineId: routine.id, fromVersion: routine.version };
    const set = (patch: Partial<RunFix>) => this.deps.runs.setFix(run.id, Object.assign(fix, patch));
    try {
      await this.deps.access.ensureReady();
    } catch (err) {
      await set({ status: "not-fixed", reason: `Doppl couldn't use AI to fix it: ${errorMessage(err)}` });
      return;
    }
    await set({});

    // The failed items (two at most) and one that worked, so the fix doesn't break what worked.
    const failedKeys = [...new Set(failed.map((o) => o.itemKey!))];
    const goodKey = run.outputs.find((o) => o.status === "done" && o.node === ROUTINE_NODE && o.itemKey && !failedKeys.includes(o.itemKey))?.itemKey;
    const testItems = [...failedKeys.slice(0, 2), ...(goodKey ? [goodKey] : [])];
    const errors = failed.slice(0, 3).map((o) => `${o.itemLabel ?? o.label}: ${o.error ?? "failed"}`);
    const request = `This routine ran on new files and failed on ${failedKeys.length === 1 ? "an item" : `${failedKeys.length} items`}. Make it work for ${failedKeys.length === 1 ? "it" : "them"} without changing what it does for the items that worked. ${errors.join(" · ")}`;

    let creation: Creation;
    try {
      creation = await this.deps.routines.refine({ routineId: routine.id, request, images: [], problem: { runId: run.id, outputId: failed[0].id }, testItems }, { auto: { maxCalls: AUTO_FIX_CALLS } });
    } catch (err) {
      await set({ status: "not-fixed", reason: errorMessage(err) });
      return;
    }
    const done = await this.settled(creation.id);
    const aiCalls = done?.aiCalls ?? 0;
    if (!done || done.status !== "ready" || !done.draft) {
      await set({ status: "not-fixed", aiCalls, reason: done?.error?.message ?? "It took too long." });
      if (done) await this.deps.routines.discard(creation.id).catch(() => undefined);
      return;
    }
    // Every test item has to work with the change.
    const items = done.trial?.items ?? [];
    const stillFailing = items.filter((i) => i.status !== "done");
    if (!items.length || stillFailing.length) {
      await set({ status: "not-fixed", aiCalls, reason: `The change still didn't work for ${stillFailing.map((i) => i.label).join(", ") || "the items"}.` });
      await this.deps.routines.discard(creation.id).catch(() => undefined);
      return;
    }
    const summary = done.refine?.changeSummary;
    // A change to what the routine takes or makes could break flows that use it: the designer looks first.
    const breaking = (done.refine?.contract ?? []).filter((c) => c.breaking);
    if (breaking.length) {
      await set({ status: "needs-review", aiCalls, summary, creationId: creation.id, reason: breaking.map((c) => c.message).join(" ") });
      return;
    }
    const saved = await this.deps.routines.save(creation.id, { name: routine.name }).catch((err) => ({ saved: false, issues: [errorMessage(err)] }) as const);
    if (!saved.saved || !("routine" in saved) || !saved.routine) {
      await set({ status: "not-fixed", aiCalls, reason: "The fix couldn't be saved." });
      return;
    }
    await set({ status: "fixed", aiCalls, summary, toVersion: saved.routine.version });
    const rerun = await this.deps.runs.retryFailed(run.id, { autoFixOf: run.id }).catch(() => null);
    if (rerun) await set({ rerunId: rerun.id });
  }

  /** The creation once it's ready, failed or cancelled; null after the wait. */
  private async settled(id: string): Promise<Creation | null> {
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      const c = this.deps.routines.getCreation(id);
      if (!c) return null;
      if (c.status === "ready" || c.status === "failed" || c.status === "cancelled") return c;
      await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 500));
    }
    return null;
  }
}

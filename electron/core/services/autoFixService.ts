import type { Creation, Run, RunFix, RunOutput } from "../types";
import { errorMessage } from "../util";
import type { AiAccessService } from "./aiAccessService";
import { type FlowService, ROUTINE_NODE } from "./flowService";
import type { LibraryService } from "./libraryService";
import type { RoutineService } from "./routineService";
import type { RunService } from "./runService";
import { plainError } from "../flows/failures";

// After a run where items failed because of the routine itself (not the designer's files, not an app), Doppl offers
// to fix the routine with AI and waits for the designer's OK: no AI is spent until they say so. The fix is a refine,
// tried on the failed items and one that worked. When it works, the designer reads what changed and keeps it (saved
// as a new version, then the failed items run again) or discards it. The previous version stays restorable.

/** AI calls one fix may use. */
export const AUTO_FIX_CALLS = 5;
const WAIT_MS = 10 * 60 * 1000;

export class AutoFixService {
  constructor(
    private readonly deps: {
      routines: RoutineService;
      runs: RunService;
      library: LibraryService;
      flows: Pick<FlowService, "require" | "pinVersion">;
      access: Pick<AiAccessService, "ensureReady">;
      /** For tests: how often to look at the fix's progress. */
      pollMs?: number;
    },
  ) {}

  /** A routine's own failures in a run (in a flow: the first routine node with some), or none. A rerun after a fix isn't fixed again. */
  private failures(run: Run): { nodeId: string; outputs: RunOutput[] } | null {
    if (run.mocked || run.autoFixOf || run.status === "cancelled") return null;
    const failed = run.outputs.filter((o) => o.status === "failed" && o.cause === "routine" && o.itemKey && o.node && (run.target.kind === "flow" || o.node === ROUTINE_NODE));
    if (!failed.length) return null;
    const nodeId = failed[0].node!;
    return { nodeId, outputs: failed.filter((o) => o.node === nodeId) };
  }

  /** Called when a run ends: when its items failed because of the routine (in a flow, a node's routine), offers a fix. No AI. */
  async consider(run: Run): Promise<void> {
    const found = this.failures(run);
    if (!found) return;
    // In a flow, the node's routine: only the version the flow uses now, when it's the newest (a fix of a newer one
    // would bring its other changes into the flow too).
    let flowLink: { flowId: string; nodeId: string } | undefined;
    let routineId = run.target.id;
    let pinned: number | undefined;
    if (run.target.kind === "flow") {
      const flow = await this.deps.flows.require(run.target.id).catch(() => null);
      const node = flow?.nodes.find((n) => n.id === found.nodeId);
      if (node?.kind !== "routine") return;
      flowLink = { flowId: run.target.id, nodeId: node.id };
      routineId = node.routineId;
      pinned = node.routineVersion;
    }
    const routine = await this.deps.library.get(routineId);
    if (!routine || routine.starter) return;
    const fix: RunFix = { status: "offered", routineId: routine.id, fromVersion: pinned ?? routine.version, maxCalls: AUTO_FIX_CALLS, ...(flowLink ?? {}) };
    if (pinned !== undefined && pinned !== routine.version) {
      const { maxCalls: _, ...rest } = fix;
      await this.deps.runs.setFix(run.id, {
        ...rest,
        status: "not-fixed",
        reason: `The flow uses version ${pinned} of “${routine.name}”, and there's a newer one. Update the flow to it, then run again; Doppl fixes the newest version.`,
      });
      return;
    }
    await this.deps.runs.setFix(run.id, fix);
  }

  /** The designer said yes to the offered fix: Doppl changes the routine with AI and tries it. Resolves when it's done. */
  async start(runId: string): Promise<void> {
    const run = await this.deps.runs.get(runId);
    const found = run && this.failures(run);
    if (!run || !found || run.fix?.status !== "offered") return;
    const fix: RunFix = { ...run.fix };
    delete fix.maxCalls;
    const flowLink = fix.flowId && fix.nodeId ? { flowId: fix.flowId, nodeId: fix.nodeId } : undefined;
    const set = (patch: Partial<RunFix>) => this.deps.runs.setFix(run.id, Object.assign(fix, patch));
    const routine = await this.deps.library.get(fix.routineId);
    if (!routine) {
      await set({ status: "not-fixed", reason: "The routine isn't in the library anymore." });
      return;
    }
    try {
      await this.deps.access.ensureReady();
    } catch (err) {
      await set({ status: "not-fixed", reason: `Doppl couldn't use AI to fix it: ${errorMessage(err)}` });
      return;
    }
    await set({ status: "fixing" });

    // The failed items (two at most) and one that worked, so the fix doesn't break what worked.
    const failed = found.outputs;
    const failedKeys = [...new Set(failed.map((o) => o.itemKey!))];
    const goodKey = run.outputs.find((o) => o.status === "done" && o.node === found.nodeId && o.itemKey && !failedKeys.includes(o.itemKey))?.itemKey;
    const testItems = [...failedKeys.slice(0, 2), ...(goodKey ? [goodKey] : [])];
    const errors = failed.slice(0, 3).map((o) => `${o.itemLabel ?? o.label}: ${o.errorDetail ?? o.error ?? "failed"}`);
    const them = failedKeys.length === 1 ? "it" : "them";
    const request = [
      `This routine ran on new files and failed on ${failedKeys.length === 1 ? "an item" : `${failedKeys.length} items`}. Make it work for ${them} without changing what it does for the items that worked.`,
      "Keep what it makes the same (file formats, sizes, barcode types, which data goes where) and don't remove or loosen its checks.",
      `If ${them === "it" ? "the item" : "the items"} failed because ${them === "it" ? "its" : "their"} own file or data is wrong (a typo, an empty or damaged file), don't change the routine: decline and say what's wrong.`,
      errors.join(" · "),
    ].join(" ");

    let creation: Creation;
    try {
      creation = await this.deps.routines.refine(
        { routineId: routine.id, request, images: [], problem: { runId: run.id, outputId: failed[0].id }, testItems, ...(flowLink ? { flowLink } : {}) },
        { auto: { maxCalls: AUTO_FIX_CALLS } },
      );
    } catch (err) {
      await set({ status: "not-fixed", reason: plainError(errorMessage(err)).error });
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
    // A change to what the routine takes or makes could break flows that use it: the designer looks at it first.
    const breaking = (done.refine?.contract ?? []).filter((c) => c.breaking);
    if (breaking.length) {
      await set({ status: "needs-review", aiCalls, summary, creationId: creation.id, reason: breaking.map((c) => c.message).join(" ") });
      return;
    }
    // The designer reads what changed and keeps it or not.
    await set({ status: "ready", aiCalls, summary, creationId: creation.id });
  }

  /** The designer keeps the fix: saved as a new version (a flow uses it from now on), then the failed items run again. */
  async keep(runId: string): Promise<void> {
    const run = await this.deps.runs.get(runId);
    if (!run?.fix || run.fix.status !== "ready" || !run.fix.creationId) return;
    const fix: RunFix = { ...run.fix };
    const set = (patch: Partial<RunFix>) => this.deps.runs.setFix(run.id, Object.assign(fix, patch));
    const creationId = fix.creationId!;
    // Doppl was closed since: the tried change is gone, so the designer can ask for it again.
    if (!this.deps.routines.getCreation(creationId)) {
      const { aiCalls: _calls, summary: _summary, creationId: _id, ...rest } = fix;
      await this.deps.runs.setFix(run.id, { ...rest, status: "offered", maxCalls: AUTO_FIX_CALLS });
      return;
    }
    const routine = await this.deps.library.get(fix.routineId);
    const saved = await this.deps.routines.save(creationId, { name: routine?.name ?? "" }).catch((err) => ({ saved: false, issues: [errorMessage(err)] }) as const);
    if (!saved.saved || !("routine" in saved) || !saved.routine) {
      await set({ status: "not-fixed", reason: "The fix couldn't be saved." });
      return;
    }
    delete fix.creationId;
    if (fix.flowId && fix.nodeId) await this.deps.flows.pinVersion(fix.flowId, fix.nodeId, saved.routine.version);
    await set({ status: "fixed", toVersion: saved.routine.version });
    const rerun = await this.deps.runs.retryFailed(run.id, { autoFixOf: run.id }).catch(() => null);
    if (rerun) {
      await set({ rerunId: rerun.id });
      // The rerun knows what was fixed, for its own Restore.
      await this.deps.runs.setFix(rerun.id, { ...fix });
    }
  }

  /** The designer doesn't want the fix (offered, or tried and not kept): nothing changes. */
  async dismiss(runId: string): Promise<void> {
    const run = await this.deps.runs.get(runId);
    const fix = run?.fix;
    if (!run || !fix || (fix.status !== "offered" && fix.status !== "ready" && fix.status !== "needs-review")) return;
    if (fix.creationId) await this.deps.routines.discard(fix.creationId).catch(() => undefined);
    const { creationId: _id, maxCalls: _max, ...rest } = fix;
    await this.deps.runs.setFix(run.id, { ...rest, status: "declined" });
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

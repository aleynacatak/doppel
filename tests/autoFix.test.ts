import { describe, expect, it } from "vitest";
import { AUTO_FIX_CALLS, AutoFixService } from "../electron/core/services/autoFixService";
import type { Creation, RefineInput, Routine, Run, RunFix, RunOutput } from "../electron/core/types";

// Doppl's own fix after a run, with stand-ins for the refine, the runs and the library: when it fixes, what it
// tries the fix on, when it doesn't save, and that the previous version is what Restore brings back.

const out = (itemKey: string, status: "done" | "failed", cause?: RunOutput["cause"], error?: string): RunOutput =>
  ({ id: `routine:${itemKey}`, label: itemKey, itemKey, itemLabel: `Row · ${itemKey}`, node: "routine", status, ...(cause ? { cause } : {}), ...(error ? { error } : {}) }) as RunOutput;

const run = (outputs: RunOutput[], extra: Partial<Run> = {}): Run => ({ id: "run-1", target: { kind: "routine", id: "r1" }, status: "partial", outputs, ...extra }) as unknown as Run;

function setup(opts: { result?: Partial<Creation>; access?: boolean; pinned?: number } = {}) {
  const fixes: RunFix[] = [];
  const rerunFixes: RunFix[] = [];
  const calls: {
    refine?: { input: RefineInput; auto?: { maxCalls: number } };
    discarded?: string;
    saved?: string;
    rerun?: { id: string; autoFixOf?: string };
    pinned?: [string, string, number];
  } = {};
  const creation = {
    id: "c1",
    status: "ready",
    aiCalls: 3,
    draft: {},
    trial: { items: [{ key: "fig", label: "Fig", status: "done" }, { key: "mango", label: "Mango", status: "done" }] },
    refine: { changeSummary: "Reads the photo before resizing it.", contract: [] },
    ...opts.result,
  } as unknown as Creation;
  const service = new AutoFixService({
    pollMs: 1,
    library: { get: async () => ({ id: "r1", name: "Jam labels", version: 3 }) as Routine } as never,
    flows: {
      require: async () => ({ id: "f1", nodes: [{ id: "n-labels", kind: "routine", routineId: "r1", routineVersion: opts.pinned ?? 3 }] }) as never,
      pinVersion: async (flowId: string, nodeId: string, version: number) => {
        calls.pinned = [flowId, nodeId, version];
        return {} as never;
      },
    },
    access: { ensureReady: async () => (opts.access === false ? Promise.reject(new Error("No access code is set.")) : undefined) },
    routines: {
      refine: async (input: RefineInput, o: { auto?: { maxCalls: number } }) => {
        calls.refine = { input, auto: o.auto };
        return { id: "c1", status: "running" } as Creation;
      },
      getCreation: () => creation,
      discard: async (id: string) => {
        calls.discarded = id;
      },
      save: async (id: string) => {
        calls.saved = id;
        return { saved: true, routine: { id: "r1", version: 4 } as Routine };
      },
    } as never,
    runs: {
      setFix: async (id: string, fix: RunFix) => {
        (id === "run-2" ? rerunFixes : fixes).push(structuredClone(fix));
      },
      retryFailed: async (id: string, o: { autoFixOf?: string }) => {
        calls.rerun = { id, autoFixOf: o.autoFixOf };
        return { id: "run-2" } as Run;
      },
    } as never,
  });
  return { service, fixes, rerunFixes, calls };
}

describe("Doppl's own fix after a run", () => {
  it("fixes the routine when items failed because of it, tries it on those and one that worked, saves it, and runs them again", async () => {
    const { service, fixes, calls } = setup();
    await service.consider(run([out("fig", "failed", "routine", "Error 21: undefined is not an object"), out("plum", "done"), out("mango", "failed", "routine", "Error 21")]));
    expect(calls.refine?.auto).toEqual({ maxCalls: AUTO_FIX_CALLS });
    expect(calls.refine?.input.testItems).toEqual(["fig", "mango", "plum"]);
    expect(calls.refine?.input.request).toBe(
      "This routine ran on new files and failed on 2 items. Make it work for them without changing what it does for the items that worked. Row · fig: Error 21: undefined is not an object · Row · mango: Error 21",
    );
    expect(fixes.map((f) => f.status)).toEqual(["fixing", "fixed", "fixed"]);
    expect(fixes.at(-1)).toEqual({ status: "fixed", routineId: "r1", fromVersion: 3, toVersion: 4, aiCalls: 3, summary: "Reads the photo before resizing it.", rerunId: "run-2" });
    expect(calls).toMatchObject({ saved: "c1", rerun: { id: "run-1", autoFixOf: "run-1" } });
  });

  it("leaves the designer's files and the apps alone, and never fixes a rerun again", async () => {
    const { service, fixes, calls } = setup();
    await service.consider(run([out("fig", "failed", "files", "No photo for Fig."), out("plum", "failed", "app", "Photoshop isn't running.")]));
    await service.consider(run([out("fig", "failed", "routine")], { autoFixOf: "run-0" }));
    expect(fixes).toEqual([]);
    expect(calls.refine).toBeUndefined();
  });

  it("doesn't save a change that still fails, and says why", async () => {
    const { service, fixes, calls } = setup({ result: { trial: { items: [{ key: "fig", label: "Fig", status: "failed" }] } as never } });
    await service.consider(run([out("fig", "failed", "routine", "Error 21")]));
    expect(fixes.at(-1)).toMatchObject({ status: "not-fixed", reason: "The change still didn't work for Fig." });
    expect(calls).toMatchObject({ discarded: "c1" });
    expect(calls.saved).toBeUndefined();
  });

  it("asks the designer to look at a change to what the routine takes or makes", async () => {
    const { service, fixes, calls } = setup({ result: { refine: { changeSummary: "Takes a logo too.", contract: [{ breaking: true, key: "logo", message: "New required input “Logo”." }] } as never } });
    await service.consider(run([out("fig", "failed", "routine", "Error 21")]));
    expect(fixes.at(-1)).toMatchObject({ status: "needs-review", creationId: "c1", summary: "Takes a logo too.", reason: "New required input “Logo”." });
    expect(calls.saved).toBeUndefined();
  });

  it("fixes a routine inside a flow, and the flow uses the fixed version from then on", async () => {
    const { service, fixes, rerunFixes, calls } = setup();
    const node = (o: RunOutput) => ({ ...o, id: `n-labels:${o.itemKey}`, node: "n-labels" }) as RunOutput;
    await service.consider(run([node(out("fig", "failed", "routine", "Error 21")), node(out("plum", "done"))], { target: { kind: "flow", id: "f1" } }));
    expect(calls.refine?.input).toMatchObject({ routineId: "r1", testItems: ["fig", "plum"], flowLink: { flowId: "f1", nodeId: "n-labels" } });
    expect(calls.pinned).toEqual(["f1", "n-labels", 4]);
    expect(fixes.at(-1)).toMatchObject({ status: "fixed", flowId: "f1", nodeId: "n-labels", fromVersion: 3, toVersion: 4, rerunId: "run-2" });
    // The rerun knows what was fixed, for its own Restore.
    expect(rerunFixes.at(-1)).toMatchObject({ flowId: "f1", nodeId: "n-labels", fromVersion: 3, toVersion: 4 });
  });

  it("doesn't fix a flow that uses an older version than the newest", async () => {
    const { service, fixes, calls } = setup({ pinned: 2 });
    await service.consider(run([{ ...out("fig", "failed", "routine", "Error 21"), node: "n-labels" } as RunOutput], { target: { kind: "flow", id: "f1" } }));
    expect(fixes).toEqual([
      { status: "not-fixed", routineId: "r1", fromVersion: 2, flowId: "f1", nodeId: "n-labels", reason: "The flow uses version 2 of “Jam labels”, and there's a newer one. Update the flow to it, then run again; Doppl fixes the newest version." },
    ]);
    expect(calls.refine).toBeUndefined();
  });

  it("says so when there's no AI to fix with", async () => {
    const { service, fixes } = setup({ access: false });
    await service.consider(run([out("fig", "failed", "routine", "Error 21")]));
    expect(fixes).toEqual([{ status: "not-fixed", routineId: "r1", fromVersion: 3, reason: "Doppl couldn't use AI to fix it: No access code is set." }]);
  });
});

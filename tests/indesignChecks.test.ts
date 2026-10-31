import { describe, expect, it } from "vitest";
import { InDesignAdapter } from "../electron/adapters/indesign/indesignAdapter";
import { RULE_CHECKS } from "../electron/adapters/indesign/jsx/scripts";
import type { StageRunContext, StageSession } from "../electron/adapters/types";
import type { AiService } from "../electron/core/services/aiService";
import { QcService } from "../electron/core/services/qcService";
import type { RuleFinding, RunOutput } from "../electron/core/types";

// InDesign's quality checks look at the document an output came from. A routine that opens its own template and
// closes it has no document left for Doppl to check: its outputs say "Not checked", never a green pass.

const overset: RuleFinding = { type: "overset", message: "Text overflows its frame on page 1", page: "1", pageIndex: 1 };

/** The adapter with InDesign replaced: the routine's script answers `script`, the rule checks answer `checks`. */
function adapter(script: Record<string, unknown>, checks: RuleFinding[] = []) {
  const a = new InDesignAdapter({ getTimeoutSec: () => 30 });
  const seen: string[] = [];
  (a as unknown as { call: (main: string) => Promise<unknown> }).call = async (main: string) => {
    if (main === RULE_CHECKS) {
      seen.push("rule checks");
      return checks;
    }
    seen.push("routine");
    return { result: null, log: [], values: {}, outputs: [{ key: "pdf", label: "card.pdf", filePath: "/nowhere/card.pdf" }], ...script };
  };
  return { a, seen };
}

const ctx = (stage: Partial<StageRunContext["stage"]> = {}) =>
  ({ routineName: "Cards", workDir: "/nowhere", stage: { id: "s", name: "Cards", appId: "indesign", kind: "script", body: "", outputs: [], ...stage } }) as unknown as StageRunContext;
const item = (n: number) => ({ key: `row-${n}`, label: `Row ${n}`, index: n - 1, item: {}, params: {}, body: "ctx.log(1);" });

describe("InDesign checks the documents a routine opens", () => {
  it("uses the findings of the template the routine checked before closing it", async () => {
    const { a, seen } = adapter({ findings: [overset], checked: 1, unchecked: 0 });
    const res = await a.runStageItem({ state: { docId: null } }, item(1), ctx({ document: "none" }), () => undefined);
    expect(res.findings).toEqual([overset]);
    expect(seen).toEqual(["routine"]);
  });

  it("says a document it closed unchecked wasn't checked, instead of passing it", async () => {
    const { a } = adapter({ findings: [], checked: 0, unchecked: 1 });
    const res = await a.runStageItem({ state: { docId: null } }, item(1), ctx({ document: "none" }), () => undefined);
    expect(res.findings).toEqual([{ type: "not-checked", message: "The routine closed its document before Doppl could check it." }]);
    expect(res.log).toContain("1 document was closed before Doppl could check it.");
  });

  it("checks a document the routine only reads once per run, and one it changes after every item", async () => {
    const reading = adapter({}, [overset]);
    const session: StageSession = { state: { docId: "/designs/cards.indd" } };
    for (const n of [1, 2]) expect((await reading.a.runStageItem(session, item(n), ctx({ modifiesDocument: false }), () => undefined)).findings).toEqual([overset]);
    expect(reading.seen).toEqual(["routine", "rule checks", "routine"]);
    const changing = adapter({}, [overset]);
    const s2: StageSession = { state: { docId: "/designs/cards.indd" } };
    for (const n of [1, 2]) await changing.a.runStageItem(s2, item(n), ctx({ modifiesDocument: true }), () => undefined);
    expect(changing.seen).toEqual(["routine", "rule checks", "routine", "rule checks"]);
  });
});

describe("outputs Doppl couldn't check", () => {
  const ai = { reviewOutput: async () => ({ level: "visual", label: "AI visual review", passed: true }) } as unknown as AiService;
  const output = (): RunOutput => ({ id: "n:row-1-pdf", label: "card.pdf", status: "done", filePath: "/nowhere/card.pdf" });
  const notChecked: RuleFinding = { type: "not-checked", message: "The routine closed its document before Doppl could check it.", outputKey: "n:row-1-pdf" };
  const subject = (qcMode: "auto" | "auto_ai") => ({ qcMode, qcOptions: { minPpiPrint: 300, minPpiWeb: 72 }, qcProfile: "print" as const });
  const { a } = adapter({});

  it("shows the document checks as not checked, not passed", async () => {
    const o = output();
    await new QcService(ai).evaluate(a, subject("auto"), [o], [notChecked], {} as never);
    expect(o.qc!.status).toBe("not-checked");
    expect(o.qc!.checks.every((c) => c.skipped && c.reason === notChecked.message)).toBe(true);
    expect(o.qc!.checks.map((c) => c.label)).toContain("Text fits its frames");
  });

  it("still flags or passes by the checks that did run", async () => {
    const o = output();
    await new QcService(ai).evaluate(a, subject("auto_ai"), [o], [notChecked], {} as never);
    expect(o.qc!.status).toBe("pass");
    expect(o.qc!.checks.filter((c) => !c.skipped).map((c) => c.label)).toEqual(["AI visual review"]);
    const flagged = output();
    await new QcService(ai).evaluate(a, subject("auto"), [flagged], [{ ...overset, outputKey: flagged.id }], {} as never);
    expect(flagged.qc!.status).toBe("flagged");
  });
});

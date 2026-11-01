import { describe, expect, it } from "vitest";
import { PHOTOSHOP_HELPERS } from "../electron/adapters/photoshop/helpers";
import { PhotoshopAdapter } from "../electron/adapters/photoshop/photoshopAdapter";
import type { AiService } from "../electron/core/services/aiService";
import { QcService } from "../electron/core/services/qcService";
import type { RuleFinding, RunOutput } from "../electron/core/types";

// The Select Subject cutout: what it flags, what it says when there's no subject, and how a flag reaches Results.
// `npm run test:helpers -- --app photoshop --ids ps.maskSubject` runs it in real Photoshop.

/** The helper's real code on a made-up 100 × 100 document, where Select Subject selects `selected` pixels. */
function run(opts: { selected?: number; autoCutout?: () => void; hasMask?: boolean }) {
  const code = PHOTOSHOP_HELPERS.find((h) => h.id === "ps.maskSubject")!.code;
  const findings: { type: string; message: string }[] = [];
  const calls: string[] = [];
  const px = (n: number) => ({ as: () => n });
  const doc = {
    name: "photo.png",
    width: px(100),
    height: px(100),
    activeLayer: null as unknown,
    channels: [{ histogram: [opts.selected ?? 0] }],
    selection: {
      deselect: () => calls.push("deselect"),
      get bounds() {
        return opts.selected === 0 ? [][0]!["no selection"] : [px(10), px(20), px(30), px(40)];
      },
    },
  };
  const layer = { isBackgroundLayer: true };
  const DopplPS = {
    documentOf: () => doc,
    hasLayerMask: () => !!opts.hasMask,
    deleteLayerMask: () => calls.push("delete mask"),
    addLayerMask: (reveal: boolean) => calls.push(`add mask ${reveal}`),
    px: (b: { as: () => number }[]) => b.map((v) => v.as()),
    finding: (type: string, message: string) => findings.push({ type, message }),
  };
  class ActionDescriptor {
    putBoolean() {}
  }
  const executeAction = () => {
    calls.push("select subject");
    opts.autoCutout?.();
  };
  const maskSubject = new Function(
    "app", "DopplPS", "ActionDescriptor", "stringIDToTypeID", "executeAction", "DialogModes",
    `${code}\nreturn maskSubject;`,
  )({ activeDocument: doc }, DopplPS, ActionDescriptor, (s: string) => s, executeAction, { NO: "NO" }) as (l: unknown) => { bounds: number[]; kept: number };
  return { call: () => maskSubject(layer), findings, calls, layer };
}

describe("the Select Subject cutout", () => {
  it("masks the layer and says how much of the picture stays", () => {
    const r = run({ selected: 2500, hasMask: true });
    expect(r.call()).toEqual({ bounds: [10, 20, 30, 40], kept: 0.25 });
    expect(r.calls).toEqual(["delete mask", "deselect", "select subject", "add mask true", "deselect"]);
    expect(r.layer.isBackgroundLayer).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("flags a cutout under 10% or over 95% of the picture, and only those", () => {
    for (const selected of [1000, 9500]) {
      const r = run({ selected });
      r.call();
      expect(r.findings, String(selected)).toEqual([]);
    }
    const small = run({ selected: 540 });
    small.call();
    expect(small.findings).toEqual([{ type: "cutout-suspect", message: "The cutout of photo.png kept only 5% of the picture. Check that it found the whole subject." }]);
    const tiny = run({ selected: 30 });
    tiny.call();
    expect(tiny.findings[0].message).toContain("kept only under 1% of the picture");
    const all = run({ selected: 10000 });
    all.call();
    expect(all.findings).toEqual([{ type: "cutout-suspect", message: "The cutout of photo.png kept almost the whole picture. Check that it found a subject." }]);
  });

  it("says so in plain words when there's no subject, and leaves other errors alone", () => {
    const noSubject = "Photoshop couldn't find a subject in photo.png. Check the picture, or use one with a clear subject.";
    const refused = run({ selected: 100, autoCutout: () => { throw new Error('General Photoshop error occurred.\n- The parameters for command "Select Subject" are not currently valid.'); } });
    expect(refused.call).toThrow(noSubject);
    expect(run({ selected: 0 }).call).toThrow(noSubject);
    const other = run({ selected: 100, autoCutout: () => { throw new Error("Out of memory"); } });
    expect(other.call).toThrow("Out of memory");
  });
});

describe("a flagged cutout in Results", () => {
  const output = (): RunOutput => ({ id: "o1", label: "photo.png", status: "done" }) as RunOutput;
  const subject = { qcMode: "auto" as const, qcOptions: { minPpiPrint: 300, minPpiWeb: 72 }, qcProfile: "web" as const };
  const adapter = new PhotoshopAdapter({ getTimeoutSec: () => 30 });
  const qc = new QcService({} as AiService);
  const flag: RuleFinding = { type: "cutout-suspect", message: "The cutout of photo.png kept only 5% of the picture.", outputKey: "o1" };

  it("flags the output with the reason", async () => {
    const o = output();
    await qc.evaluate(adapter, subject, [o], [flag], {} as never);
    expect(o.qc!.status).toBe("flagged");
    expect(o.qc!.checks.find((c) => !c.passed)).toMatchObject({ label: "Cutout found the subject", reason: flag.message });
  });

  it("isn't listed for a routine with nothing to report, or one Doppl couldn't check", async () => {
    const o = output();
    await qc.evaluate(adapter, subject, [o], [], {} as never);
    expect(o.qc!.status).toBe("pass");
    expect(o.qc!.checks.map((c) => c.label)).toEqual(["Fonts are installed", "Images and files exist"]);
    const unchecked = output();
    await qc.evaluate(adapter, subject, [unchecked], [{ type: "not-checked", message: "Closed", outputKey: "o1" }], {} as never);
    expect(unchecked.qc!.checks.map((c) => c.label)).toEqual(["Fonts are installed", "Images and files exist"]);
  });
});

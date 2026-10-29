import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pickByName, prepareActions } from "../electron/adapters/figma/prepareActions";
import { type ValidatorApps, validateRoutine } from "../electron/core/routines/contract";
import { errorsForModel, planProblems, readActionsText, recoverKeys, toFlowPlan, toRoutineDraft, TURN_KEYS } from "../electron/core/routines/modelRoutine";
import { PLAN_FORMAT_EXAMPLE } from "../electron/core/services/aiPrompts";
import { validateAuthoringActions } from "../electron/shared/figmaActions";

const apps: ValidatorApps = { has: () => true, stageKind: (id) => (id === "figma" ? "actions" : "script"), lintScript: () => [] };
const actions = [{ action: "renameNode", node: "Label", name: "x" }];
const figmaRoutine = (extra: Record<string, unknown>) => ({
  name: "Labels",
  app: "figma",
  inputs: [{ key: "file", label: "File", type: "document", required: true }],
  outputs: [],
  steps: ["a"],
  ...extra,
});

describe("reading the model's routine", () => {
  it("finds a Figma routine's actions wherever the model put them", () => {
    for (const variant of [{ actions }, { body: { actions } }, { body: actions }, { actions: JSON.stringify(actions) }, { script: JSON.stringify({ actions }) }]) {
      expect(toRoutineDraft(figmaRoutine(variant), "figma", "actions", "").actions).toEqual(actions);
    }
  });

  it("recovers fields that came out under a near-miss name (Meta's alphabetical field order)", () => {
    // What the AI sent while Doppl's example put "actions" last: an empty "actionsروس" and the list under "actions_O".
    const raw = figmaRoutine({ "actionsروس": "", actions_O: JSON.stringify(actions), inputs2: [{ key: "rows", label: "Rows", type: "rows", required: true }] });
    delete (raw as Record<string, unknown>).inputs;
    const draft = toRoutineDraft(raw, "figma", "actions", "");
    expect(draft.actions).toEqual(actions);
    expect(draft.inputs.map((p) => p.key)).toEqual(["rows"]);
    expect(recoverKeys({ action: "inspect", "depth hints": 3, reason: "x" }, TURN_KEYS)).toMatchObject({ depth: 3 });
    // A longer known key isn't taken for a shorter one ("nodes" for "node").
    expect(recoverKeys({ nodes2: ["A"] }, ["node", "nodes"])).toEqual({ nodes2: ["A"], nodes: ["A"] });
  });

  it("finds a script routine's body under script or body, and reads its contract", () => {
    const ps = { name: "Cut", app: "photoshop", inputs: [{ key: "photos", label: "Photos", type: "fileList", required: false, extensions: [".JPEG", "png"] }], iterate: "photos", outputs: [] };
    const draft = toRoutineDraft({ ...ps, script: "ctx.log(1);" }, "photoshop", "script", "27");
    expect(draft).toMatchObject({ script: "ctx.log(1);", iterate: { input: "photos" }, appVersion: "27" });
    expect(draft.inputs[0]).toMatchObject({ extensions: ["jpg", "png"], required: true });
    expect(toRoutineDraft({ ...ps, body: "ctx.log(2);" }, "photoshop", "script", "").script).toBe("ctx.log(2);");
    expect(() => toRoutineDraft({ ...ps, inputs: [{ key: "x", type: "image" }] }, "photoshop", "script", "")).toThrow('inputs[0] needs a "key" and a "type"');
    expect(() => toRoutineDraft(undefined, "photoshop", "script", "")).toThrow("didn't contain a routine");
  });

  it("explains an unreadable action list in the model's terms", () => {
    const draft = toRoutineDraft(figmaRoutine({ actions: "[{" }), "figma", "actions", "");
    const errors = errorsForModel(validateRoutine(draft, apps).errors, draft);
    expect(errors[0]).toMatchObject({ path: "actions" });
    expect(errors[0].message).toContain("it is 2 characters long");
    expect(errors[0].message).toContain('"actions": "[{\\"action\\":\\"duplicateNode\\",\\"id\\":\\"label\\",\\"node\\":\\"Label\\"}]"');
    expect(JSON.stringify(draft)).not.toContain("characters long");
  });
});

describe("reading a Figma action list written as text", () => {
  const list = [
    { action: "duplicateNode", id: "label", node: "Label" },
    { action: "setText", node: "$label.#Name", text: "{{item.name}}" },
  ];
  const text = JSON.stringify(list);

  it("repairs small slips without asking the AI again", () => {
    for (const slip of ["```json\n" + text + "\n```", text.replace("}]", "},]"), JSON.stringify(text), JSON.stringify({ actions: list }), JSON.stringify(list.map((a) => JSON.stringify(a))), JSON.stringify(list[0])]) {
      const read = readActionsText(slip);
      expect("actions" in read && read.actions.length).toBeGreaterThan(0);
    }
  });

  it("says where a broken list breaks", () => {
    const read = readActionsText(text.replace('"node":"Label"', '"node":"Label" "x":1'));
    expect("problem" in read && read.problem).toMatch(/isn't valid JSON .* at character \d+ of \d+, right after "….*"node":"Label"/);
    expect(readActionsText("[]")).toEqual({ problem: 'its "actions" text is an empty list.' });
    expect(readActionsText('{"label":"x"}')).toEqual({ problem: 'its "actions" text is JSON, but not a list of actions.' });
  });
});

describe("flow plans", () => {
  it("accepts the plan format shown to the model", () => {
    const plan = toFlowPlan(JSON.parse(JSON.stringify(PLAN_FORMAT_EXAMPLE)));
    expect(planProblems(plan, ["photoshop", "figma"])).toEqual([]);
    expect(plan.routines.map((r) => [r.id, r.appId, r.iterate?.input])).toEqual([
      ["cutouts", "photoshop", "photos"],
      ["labels", "figma", "products"],
    ]);
  });

  it("explains what doesn't connect", () => {
    const raw = JSON.parse(JSON.stringify(PLAN_FORMAT_EXAMPLE));
    raw.routines[1].app = "illustrator";
    delete raw.connections[2].match;
    raw.connections[0].to = "cutouts.images";
    raw.connections.push({ from: "labels.labels", to: "cutouts.photos" });
    raw.routines[0].outputs[0].extensions = ["psd"];
    const problems = planProblems(toFlowPlan(raw), ["photoshop", "figma"]);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"app" must be one of photoshop, figma'),
        "No routine works in figma, but the designer picked it for this task.",
        expect.stringContaining('routine "cutouts" has no input "images"'),
        expect.stringContaining('needs a "match" rule'),
        expect.stringContaining("PSD files can't go into an input that takes PNG files."),
        expect.stringContaining("feed each other in a circle"),
      ]),
    );
  });
});

describe("new Figma abilities", () => {
  it("accepts word lists, files by name and larger exports", () => {
    const res = validateAuthoringActions({
      actions: [
        { action: "setTextStyleRanges", node: "Ingredients", ranges: [{ matchAny: "{{item.allergens}}", wholeWord: true }], style: { fontStyle: "Bold" } },
        { action: "setImageFill", node: "Photo", image: { files: "{{inputs.cutouts}}", name: "{{item.image}}" } },
        { action: "exportNode", node: "Label", format: "PNG", scale: 5 },
      ],
    });
    expect(res).toEqual({ ok: true });
  });

  it("picks a file from a list by name", async () => {
    const files = ["/run/s1/Strawberry.png", "/run/s1/apricot-jam.PNG"];
    expect(pickByName(files, "strawberry")).toBe("/run/s1/Strawberry.png");
    expect(pickByName(files, "Apricot-Jam.png")).toBe("/run/s1/apricot-jam.PNG");
    expect(pickByName(files, "fig")).toBeNull();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doppl-pick-"));
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(100, 20);
    await fs.writeFile(path.join(dir, "Cherry.png"), png);
    const prepared = await prepareActions([{ action: "setImageFill", node: "Photo", image: { files: [path.join(dir, "Cherry.png")], name: "cherry" } }], [dir]);
    expect((prepared.actions[0].image as { name: string }).name).toBe("Cherry.png");
    await expect(prepareActions([{ action: "setImageFill", node: "Photo", image: { files: [], name: "fig" } }], [dir])).rejects.toMatchObject({ finding: { type: "file-missing" } });
  });
});

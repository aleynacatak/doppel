import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pickByName, prepareActions } from "../electron/adapters/figma/prepareActions";
import { toStagedDraft } from "../electron/core/services/modelAiService";
import { errorsForModel } from "../electron/core/services/routineService";
import { validateRoutine } from "../electron/core/stages/validator";
import { validateAuthoringActions } from "../electron/shared/figmaActions";

const apps = { has: () => true, stageKind: (id: string) => (id === "figma" ? ("actions" as const) : ("script" as const)), lintScript: () => [] };
const actions = [{ action: "renameNode", node: "Label", name: "x" }];
const stage = (extra: Record<string, unknown>) => ({ id: "s2", name: "Labels", app: "figma", kind: "actions", outputs: [], steps: ["a"], ...extra });

describe("reading the model's routine", () => {
  it("finds a Figma stage's actions wherever the model put them", () => {
    for (const variant of [{ actions }, { body: { actions } }, { body: actions }, { actions: JSON.stringify(actions) }, { script: JSON.stringify({ actions }) }]) {
      const draft = toStagedDraft({ name: "R", description: "", params: [], stages: [stage(variant)] }, {});
      expect((draft.stages![0].body as { actions: unknown[] }).actions).toEqual(actions);
    }
  });

  it("finds a script stage's body under script or body", () => {
    const ps = (extra: Record<string, unknown>) => ({ id: "s1", name: "Cut out", app: "photoshop", kind: "script", outputs: [], steps: ["a"], ...extra });
    expect(toStagedDraft({ name: "R", description: "", params: [], stages: [ps({ script: "ctx.log(1);" })] }, {}).stages![0].body).toBe("ctx.log(1);");
    expect(toStagedDraft({ name: "R", description: "", params: [], stages: [ps({ body: "ctx.log(2);" })] }, {}).stages![0].body).toBe("ctx.log(2);");
  });

  it("reports problems in the model's own terms", () => {
    const draft = toStagedDraft({ name: "R", description: "", params: [], stages: [stage({ actions: [] })] }, {});
    const errors = errorsForModel(validateRoutine({ params: draft.params, stages: draft.stages! }, apps).errors, draft);
    expect(errors[0]).toMatchObject({ path: "stages[0].actions" });
    expect(errors[0].message).toContain('Put its action list in the stage\'s "actions" array');
    const bad = toStagedDraft({ name: "R", description: "", params: [], stages: [stage({ actions: [{ action: "setText", node: "A" }] })] }, {});
    expect(errorsForModel(validateRoutine({ params: [], stages: bad.stages! }, apps).errors, bad)[0].path).toBe("stages[0].actions[0].text");
  });
});

describe("new Figma abilities", () => {
  it("accepts word lists, files by name and larger exports", () => {
    const res = validateAuthoringActions({
      actions: [
        { action: "setTextStyleRanges", node: "Ingredients", ranges: [{ matchAny: "{{item.allergens}}", wholeWord: true }], style: { fontStyle: "Bold" } },
        { action: "setImageFill", node: "Photo", image: { files: "{{stage.s1.outputs.files}}", name: "{{item.image}}" } },
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

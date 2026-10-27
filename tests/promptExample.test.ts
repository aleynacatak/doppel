import { describe, expect, it } from "vitest";
import { stageSystemPrompt } from "../electron/core/services/aiPrompts";
import { toStagedDraft } from "../electron/core/services/modelAiService";
import { validateRoutine } from "../electron/core/stages/validator";
import { lintPhotoshopScript } from "../electron/adapters/photoshop/lint";

// The example routine in the model's instructions must itself be valid, or the model learns a broken format.
describe("format example in the creation prompt", () => {
  it("is valid JSON and passes Doppl's validator", () => {
    const prompt = stageSystemPrompt([], 12);
    const start = prompt.indexOf('{"name":"Cards and previews"');
    const end = prompt.indexOf("\nA stage's action list goes in");
    const example = JSON.parse(prompt.slice(start, end));
    const draft = toStagedDraft(example, {});
    const res = validateRoutine(
      { params: draft.params, stages: draft.stages! },
      { has: () => true, stageKind: (id) => (id === "figma" ? "actions" : "script"), lintScript: (_id, s) => lintPhotoshopScript(s) },
    );
    expect(res.errors).toEqual([]);
    expect(draft.stages!.map((s) => s.appId)).toEqual(["photoshop", "figma"]);
  });
});

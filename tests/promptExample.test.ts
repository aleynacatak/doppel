import { describe, expect, it } from "vitest";
import { lintPhotoshopScript } from "../electron/adapters/photoshop/lint";
import { ROUTINE_FORMAT_EXAMPLE, STAGE_TURN_SCHEMA, stageSystemPrompt } from "../electron/core/services/aiPrompts";
import { toStagedDraft } from "../electron/core/services/modelAiService";
import { validateRoutine } from "../electron/core/stages/validator";

// The example routine in the model's instructions must itself be valid, or the model learns a broken format.
describe("format example in the creation prompt", () => {
  it("is in the prompt and passes Doppl's validator", () => {
    expect(stageSystemPrompt([], 12)).toContain(JSON.stringify(ROUTINE_FORMAT_EXAMPLE));
    const draft = toStagedDraft(JSON.parse(JSON.stringify(ROUTINE_FORMAT_EXAMPLE)), {});
    const res = validateRoutine(
      { params: draft.params, stages: draft.stages! },
      { has: () => true, stageKind: (id) => (id === "figma" ? "actions" : "script"), lintScript: (_id, s) => lintPhotoshopScript(s) },
    );
    expect(res.errors).toEqual([]);
    expect((draft.stages![1].body as { actions: unknown[] }).actions).toHaveLength(4);
  });

  it("asks for Figma actions as text, which any enforced schema lets through", () => {
    const stage = (STAGE_TURN_SCHEMA.properties.routine as any).properties.stages.items;
    expect(stage.properties.actions.type).toBe("string");
  });
});

import { describe, expect, it } from "vitest";
import { lintExtendScript } from "../electron/adapters/indesign/lint";
import { lintPhotoshopScript } from "../electron/adapters/photoshop/lint";
import type { DesignAppAdapter } from "../electron/adapters/types";
import { validateRoutine } from "../electron/core/routines/contract";
import { planProblems, toFlowPlan, toRoutineDraft } from "../electron/core/routines/modelRoutine";
import { WORKED_EXAMPLES, workedExamplesText } from "../electron/core/services/workedExamples";
import { PLAN_FORMAT_EXAMPLE, PLAN_TURN_SCHEMA, ROUTINE_FORMAT_EXAMPLES, ROUTINE_TURN_SCHEMA, planSystemPrompt, routineSystemPrompt } from "../electron/core/services/aiPrompts";

// The examples in the model's instructions must themselves be valid, or the model learns a broken format.
// And Meta's structured output wants schema-defined fields in alphabetical order (see aiPrompts.ts).

const adapter = (id: string, stageKind: "actions" | "script") => ({ id, name: id, stageKind }) as unknown as DesignAppAdapter;
const apps = {
  has: () => true,
  stageKind: (id: string) => (id === "figma" ? ("actions" as const) : ("script" as const)),
  lintScript: (id: string, s: string) => (id === "photoshop" ? lintPhotoshopScript(s) : lintExtendScript(s)),
};

describe("worked examples in the app guides", () => {
  for (const [app, list] of Object.entries(WORKED_EXAMPLES)) {
    for (const { title, routine } of list) {
      it(`${app}: ${title}`, () => {
        const kind = app === "figma" ? "actions" : "script";
        const draft = toRoutineDraft(JSON.parse(JSON.stringify(routine)), app, kind, "");
        expect(validateRoutine(draft, apps, undefined, app).errors).toEqual([]);
      });
    }
    it(`${app}: shows the code where each format puts it`, () => {
      expect(workedExamplesText(app, true)).toContain('"@code:1"');
      expect(workedExamplesText(app, true)).toContain(app === "figma" ? "```json" : "```javascript");
      expect(workedExamplesText(app, false)).not.toContain("@code:1");
    });
  }
});

describe("format examples in the creation prompts", () => {
  for (const [app, example] of Object.entries(ROUTINE_FORMAT_EXAMPLES)) {
    it(`shows a valid ${app} routine`, () => {
      const kind = app === "figma" ? "actions" : "script";
      expect(routineSystemPrompt({ adapter: adapter(app, kind), manifest: "" }, 12)).toContain(JSON.stringify(example));
      const draft = toRoutineDraft(JSON.parse(JSON.stringify(example)), app, kind, "");
      expect(validateRoutine(draft, apps, undefined, app).errors).toEqual([]);
    });
  }

  it("shows a plan that connects", () => {
    expect(planSystemPrompt(["photoshop", "figma"], 6)).toContain(JSON.stringify(PLAN_FORMAT_EXAMPLE));
    expect(planProblems(toFlowPlan(JSON.parse(JSON.stringify(PLAN_FORMAT_EXAMPLE))), ["photoshop", "figma"])).toEqual([]);
  });

  it("defines the answer's fields in alphabetical order, and leaves the routine and plan free", () => {
    for (const schema of [ROUTINE_TURN_SCHEMA, PLAN_TURN_SCHEMA]) {
      const keys = Object.keys(schema.properties);
      expect(keys).toEqual([...keys].sort());
    }
    expect(ROUTINE_TURN_SCHEMA.properties.routine).not.toHaveProperty("properties");
    expect(PLAN_TURN_SCHEMA.properties.plan).not.toHaveProperty("properties");
  });

  it("writes every example answer with its fields in alphabetical order", () => {
    const prompts = [routineSystemPrompt({ adapter: adapter("figma", "actions"), manifest: "" }, 12), planSystemPrompt(["photoshop", "figma"], 6)];
    for (const prompt of prompts) {
      const answers = prompt.split("\n").filter((l) => l.startsWith('{"action"'));
      expect(answers.length).toBeGreaterThan(1);
      for (const line of answers) {
        const keys = [...line.matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]).filter((k, i, all) => all.indexOf(k) === i);
        const top = keys.filter((k) => ["action", "app", "depth", "document", "nodes", "plan", "question", "reason", "routine", "sampleItemIndex"].includes(k));
        expect(top).toEqual([...top].sort());
      }
    }
  });
});

import type { RoutineTemplate } from "../../adapters/types";
import type { AiCallContext, AiService, DraftState } from "../services/aiService";
import type { ClarifyingQuestion, DocumentSummary, EnvironmentCheck, QcCheck, Routine, RoutineDraft, Run, RunOutput, Task } from "../types";
import { clone, delay, newId } from "../util";
import type { DevFlagsStore } from "./devFlags";

const NAMING_QUESTION_ID = "naming";
const PICK_QUESTION_ID = "pick-template";

/**
 * Mock AI: picks a prebuilt routine from the template library by keyword matching on the request,
 * asks a clarifying question where a real model plausibly would, and counts "calls" with delays.
 */
export class MockAiService implements AiService {
  readonly canFixScripts = false;

  constructor(
    private readonly templates: RoutineTemplate[],
    private readonly flags: DevFlagsStore,
  ) {}

  private async call(ctx: AiCallContext, ms: number) {
    await delay(ms * ctx.speed, ctx.isCancelled);
    ctx.onAiCall();
  }

  async readDocument(_task: Task, _summary: DocumentSummary, ctx: AiCallContext) {
    await this.call(ctx, 900);
  }

  private score(template: RoutineTemplate, request: string): number {
    const text = request.toLowerCase();
    return template.keywords.reduce((n, k) => n + (text.includes(k) ? (k.includes(" ") ? 2 : 1) : 0), 0);
  }

  private candidates(appId: string) {
    return this.templates.filter((t) => t.appId === appId);
  }

  async draftRoutine(task: Task, summary: DocumentSummary, ctx: AiCallContext): Promise<DraftState> {
    await this.call(ctx, 800);
    await this.call(ctx, 700);
    const ranked = this.candidates(task.appId)
      .map((t) => ({ t, score: this.score(t, task.request) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0] && ranked[0].score > 0 ? ranked[0].t : null;
    const alwaysAsk = this.flags.get().creationOutcome === "always-ask";

    if (!best || (alwaysAsk && !best.naming)) {
      return { question: this.pickQuestion(ranked.map((r) => r.t)), memory: { ranked: ranked.map((r) => r.t.id) } };
    }
    return this.continueWith(best, summary, ctx, {});
  }

  private pickQuestion(templates: RoutineTemplate[]): ClarifyingQuestion {
    return {
      id: PICK_QUESTION_ID,
      text: "I'm not sure which routine you need. Which of these is closest?",
      options: templates.map((t) => ({ id: t.id, label: t.name })),
    };
  }

  private namingQuestion(): ClarifyingQuestion {
    return {
      id: NAMING_QUESTION_ID,
      text: "Should exported files use your existing naming pattern client_format_v1?",
      options: [
        { id: "yes", label: "Yes, use client_format_v1" },
        { id: "no", label: "No, keep the default names" },
        { id: "ask", label: "Ask me every time I run it" },
      ],
    };
  }

  private async continueWith(
    template: RoutineTemplate,
    summary: DocumentSummary,
    ctx: AiCallContext,
    memory: Record<string, unknown>,
  ): Promise<DraftState> {
    const next = { ...memory, templateId: template.id };
    if (template.naming && !memory.naming) {
      return { question: this.namingQuestion(), memory: next };
    }
    await this.call(ctx, 900);
    return { draft: this.buildDraft(template, summary, (memory.naming as string) ?? "no"), memory: next };
  }

  async answerQuestion(_task: Task, summary: DocumentSummary, state: DraftState, optionId: string, ctx: AiCallContext): Promise<DraftState> {
    await this.call(ctx, 600);
    const memory = state.memory;
    if (state.question?.id === PICK_QUESTION_ID) {
      const template = this.templates.find((t) => t.id === optionId) ?? this.templates.find((t) => t.id === (memory.ranked as string[])[0])!;
      return this.continueWith(template, summary, ctx, memory);
    }
    const template = this.templates.find((t) => t.id === memory.templateId)!;
    return this.continueWith(template, summary, ctx, { ...memory, naming: optionId });
  }

  private buildDraft(template: RoutineTemplate, summary: DocumentSummary, naming: string): RoutineDraft {
    const params = clone(template.params);
    if (template.naming) {
      const p = params.find((x) => x.key === template.naming!.paramKey);
      if (p && naming === "yes") {
        p.default = template.naming.houseStyle;
        if (template.naming.houseStyle.includes("{client}") && !params.some((x) => x.key === "client")) {
          params.unshift({ key: "client", label: "Client", type: "text", required: true, default: "client" });
        }
      }
      if (p && naming === "ask") {
        delete p.default;
        p.required = true;
      }
    }
    let script = template.script;
    if (this.flags.get().creationOutcome === "absolute-path") {
      // Dev panel: simulate a model that hardcoded a location, so the save-time portability check fires.
      script =
        (template.appId === "indesign"
          ? `var logFile = new File("/Users/designer/Desktop/doppel-log.txt");\n`
          : `const LOG_PATH = "/Users/designer/Desktop/doppel-log.txt";\n`) + script;
    }
    return {
      name: template.name,
      description: template.description,
      appId: template.appId,
      steps: template.steps.map((s) => ({ id: newId(), plainLanguage: s })),
      params,
      script,
      appVersion: summary.appVersion,
      requiredFonts: [...template.requiredFonts],
      templateId: template.id,
      experimental: template.experimental,
      modifiesDocument: template.modifiesDocument,
      qcProfile: template.qcProfile,
      builtInQc: template.builtInQc,
    };
  }

  async fixRoutine(_task: Task, _summary: DocumentSummary | null, draft: RoutineDraft): Promise<RoutineDraft> {
    return draft;
  }

  async reviewTrial(_task: Task, _draft: RoutineDraft, _outputs: RunOutput[], ctx: AiCallContext): Promise<Record<string, QcCheck[]>> {
    await this.call(ctx, 900);
    return {};
  }

  async explainFailure(_routine: Routine, failedRun: Run | null, env: EnvironmentCheck | null, ctx: AiCallContext): Promise<string> {
    await this.call(ctx, 1000);
    if (failedRun?.errorDetail) return failedRun.errorDetail;
    if (env?.versionMismatch) return `The routine was written for version ${env.routineVersion}; you have ${env.currentVersion}.`;
    if (env?.missingFonts.length) return `The routine depends on fonts that aren't installed: ${env.missingFonts.join(", ")}.`;
    return "The routine stopped on content it didn't expect.";
  }

  async repairRoutine(routine: Routine, failedRun: Run | null, env: EnvironmentCheck | null, ctx: AiCallContext): Promise<RoutineDraft> {
    await this.call(ctx, 900);
    await this.call(ctx, 800);
    await this.call(ctx, 700);
    const nextVersion = routine.version + 1;
    const reasons: string[] = [];
    if (failedRun) reasons.push("adapts when the expected objects moved or were grouped");
    if (env?.versionMismatch && env.currentVersion) reasons.push(`updated for app version ${env.currentVersion}`);
    if (env?.missingFonts.length) reasons.push(`no longer depends on ${env.missingFonts.join(", ")}`);
    if (reasons.length === 0) reasons.push("general robustness fixes");
    const repairStep = "Before each output, check that the expected objects are still there and adapt to the new structure";
    const steps = routine.steps.some((s) => s.plainLanguage === repairStep)
      ? routine.steps
      : [...routine.steps, { id: newId(), plainLanguage: repairStep }];
    return {
      name: routine.name,
      description: routine.description,
      appId: routine.appId,
      steps,
      params: clone(routine.params),
      script: `// Repaired in version ${nextVersion}: ${reasons.join("; ")}.\n${routine.script.replace(/^\/\/ Repaired in version \d+:.*\n/, "")}`,
      appVersion: env?.currentVersion || routine.appVersion,
      requiredFonts: routine.requiredFonts.filter((f) => !env?.missingFonts.includes(f)),
      templateId: routine.templateId,
      experimental: routine.experimental,
      modifiesDocument: routine.modifiesDocument,
      qcProfile: routine.qcProfile,
      builtInQc: routine.builtInQc,
    };
  }

  async reviewOutput(output: RunOutput, ctx: AiCallContext): Promise<QcCheck> {
    await this.call(ctx, 250);
    const cropped = output.qc?.checks.some((c) => c.level === "object" && !c.passed && /cut off/i.test(c.reason ?? ""));
    return cropped
      ? { level: "visual", label: "AI visual review", passed: false, reason: "The product looks cropped compared to the master" }
      : { level: "visual", label: "AI visual review", passed: true };
  }
}

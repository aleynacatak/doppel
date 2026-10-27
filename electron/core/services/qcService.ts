import type { DesignAppAdapter } from "../../adapters/types";
import type { DevFlagsStore } from "../mock/devFlags";
import type { AppId, QcCheck, QcMode, QcOptions, RuleFinding, RuleFindingType, RunOutput } from "../types";
import type { AiCallContext, AiService } from "./aiService";

export interface QcSubject {
  appId: AppId;
  qcMode: QcMode;
  qcOptions: QcOptions;
  qcProfile: "print" | "web";
  /** The routine reports its own rule findings (Preflight report). */
  builtInQc?: boolean;
}

const RULES: { types: RuleFindingType[]; label: (minPpi: number) => string }[] = [
  { types: ["overset"], label: () => "Text fits its frames" },
  { types: ["link-missing", "link-modified"], label: () => "Links are present and up to date" },
  { types: ["font-missing"], label: () => "Fonts are installed" },
  { types: ["low-res"], label: (ppi) => `Images are at least ${ppi} ppi` },
];

/** Known mock problems, so the core demo shows the same two flagged outputs every time. */
const MOCK_OBJECT_PROBLEMS: Record<string, { check: "inside" | "overlap"; reason: string }> = {
  "format-instagram-story": { check: "inside", reason: "Product is cut off at the right edge" },
  "format-x-header": { check: "overlap", reason: "Headline overlaps the product" },
};

/**
 * Quality control on run outputs, in three levels:
 * rule (real for InDesign: overset, links, fonts, resolution), object (mocked), visual (mock AI, costs AI calls).
 */
export class QcService {
  constructor(
    private readonly ai: AiService,
    private readonly flags: DevFlagsStore,
  ) {}

  /** Rule findings for the document, or null when rules aren't checked (manual QC). */
  async collectFindings(
    adapter: DesignAppAdapter,
    subject: QcSubject,
    outputs: RunOutput[],
    documentId: string | undefined,
    scriptData: unknown,
  ): Promise<RuleFinding[] | null> {
    if (subject.builtInQc) {
      const findings = (scriptData as { findings?: RuleFinding[] } | null)?.findings;
      return Array.isArray(findings) ? findings : [];
    }
    if (subject.qcMode === "manual") return null;
    return adapter.ruleChecks(documentId, {
      minPpi: Math.max(subject.qcOptions.minPpiPrint, subject.qcOptions.minPpiWeb),
      outputs: outputs.map((o) => ({ key: o.id, label: o.label, filePath: o.filePath, page: o.page, pageIndex: o.pageIndex, profile: o.profile })),
    });
  }

  /** Sets `qc` on every finished output (or only those in `only`). */
  async evaluate(
    subject: QcSubject,
    outputs: RunOutput[],
    findings: RuleFinding[] | null,
    ctx: AiCallContext,
    only?: Set<string>,
  ): Promise<void> {
    const qcOutcome = this.flags.get().qcOutcome;
    const usable = (findings ?? []).filter((f) => !(qcOutcome === "all-pass" && f.simulated));
    const done = outputs.filter((o) => o.status === "done");
    const forcedFlags = this.forcedObjectProblems(subject.appId, done);

    for (const output of done) {
      if (only && !only.has(output.id)) continue;
      const checks: QcCheck[] = [];

      if (findings !== null) {
        const mine = this.findingsFor(output, usable, outputs);
        const profile = output.profile ?? subject.qcProfile;
        const minPpi = profile === "web" ? subject.qcOptions.minPpiWeb : subject.qcOptions.minPpiPrint;
        for (const rule of RULES) {
          const hits = mine.filter(
            (f) => rule.types.includes(f.type) && (f.type !== "low-res" || f.value === undefined || f.value < minPpi),
          );
          checks.push({ level: "rule", label: rule.label(minPpi), passed: hits.length === 0, reason: summarize(hits) });
        }
      }

      if (subject.qcMode !== "manual") {
        const problem = qcOutcome === "all-pass" ? undefined : (MOCK_OBJECT_PROBLEMS[output.id] ?? forcedFlags.get(output.id));
        checks.push({
          level: "object",
          label: "Key objects stay inside the frame",
          passed: problem?.check !== "inside",
          reason: problem?.check === "inside" ? problem.reason : undefined,
        });
        checks.push({
          level: "object",
          label: "Text doesn't overlap images",
          passed: problem?.check !== "overlap",
          reason: problem?.check === "overlap" ? problem.reason : undefined,
        });
      }

      output.qc = checks.length ? { status: checks.every((c) => c.passed) ? "pass" : "flagged", checks } : undefined;

      if (subject.qcMode === "auto_ai") {
        const visual = await this.ai.reviewOutput(output, ctx);
        checks.push(visual);
        output.qc = { status: checks.every((c) => c.passed) ? "pass" : "flagged", checks };
      }
    }
  }

  /** Dev panel "some flagged": make sure at least two outputs are flagged at object level. */
  private forcedObjectProblems(appId: AppId, done: RunOutput[]) {
    const forced = new Map<string, { check: "inside" | "overlap"; reason: string }>();
    if (this.flags.get().qcOutcome !== "some-flagged") return forced;
    if (done.some((o) => MOCK_OBJECT_PROBLEMS[o.id])) return forced;
    const isFigma = appId === "figma";
    if (done[0]) forced.set(done[0].id, { check: "inside", reason: isFigma ? "Product is cut off at the right edge" : "An image is cut off at the right page edge" });
    const second = done[2] ?? done[1];
    if (second) forced.set(second.id, { check: "overlap", reason: isFigma ? "Headline overlaps the product" : "The headline overlaps an image" });
    return forced;
  }

  /**
   * Which findings belong to an output: findings tied to it, findings on its page, and document-level
   * findings for outputs that cover the whole document (or the first output when every output is a page).
   */
  private findingsFor(output: RunOutput, findings: RuleFinding[], all: RunOutput[]): RuleFinding[] {
    const hasDocLevelOutput = all.some((o) => o.pageIndex === undefined);
    return findings.filter((f) => {
      if (f.outputKey) return f.outputKey === output.id;
      if (f.pageIndex !== undefined) return output.pageIndex === undefined || output.pageIndex === f.pageIndex;
      return output.pageIndex === undefined || (!hasDocLevelOutput && output.id === all[0]?.id);
    });
  }
}

function summarize(hits: RuleFinding[]): string | undefined {
  if (hits.length === 0) return undefined;
  const unique = [...new Set(hits.map((h) => h.message))];
  const shown = unique.slice(0, 3).join("; ");
  return unique.length > 3 ? `${shown}; and ${unique.length - 3} more` : shown;
}

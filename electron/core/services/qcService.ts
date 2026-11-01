import type { DesignAppAdapter } from "../../adapters/types";
import type { ObjectCheckDef, QcCheck, QcMode, QcOptions, QcResult, RuleFinding, RunOutput } from "../types";
import type { AiCallContext, AiService } from "./aiService";

export interface QcSubject {
  qcMode: QcMode;
  qcOptions: QcOptions;
  qcProfile: "print" | "web";
  /** The routine reports its own rule findings (Preflight report). */
  builtInQc?: boolean;
}

/**
 * Quality control on run outputs:
 *   rule + object levels: the app's own checks (adapter.qcChecks) from findings in the document;
 *   visual level ("Automatic check + AI review"): the model looks at each preview (costs AI calls).
 */
export class QcService {
  constructor(private readonly ai: AiService) {}

  /** Findings for the run: from the routine itself, from the app during the run, or from the app's checks. Null = not checked. */
  async collectFindings(
    adapter: DesignAppAdapter,
    subject: QcSubject,
    outputs: RunOutput[],
    documentId: string | undefined,
    scriptData: unknown,
    runFindings: RuleFinding[] | undefined,
  ): Promise<RuleFinding[] | null> {
    if (subject.builtInQc) {
      const findings = (scriptData as { findings?: RuleFinding[] } | null)?.findings;
      return Array.isArray(findings) ? findings : [];
    }
    if (subject.qcMode === "manual") return null;
    if (runFindings) return runFindings;
    return adapter.ruleChecks(documentId, {
      minPpi: Math.max(subject.qcOptions.minPpiPrint, subject.qcOptions.minPpiWeb),
      outputs: outputs.map((o) => ({ key: o.id, label: o.label, filePath: o.filePath, page: o.page, pageIndex: o.pageIndex, nodeId: o.nodeId, profile: o.profile })),
    });
  }

  /** Sets `qc` on every finished output (or only those in `only`). */
  async evaluate(
    adapter: DesignAppAdapter,
    subject: QcSubject,
    outputs: RunOutput[],
    findings: RuleFinding[] | null,
    ctx: AiCallContext,
    only?: Set<string>,
  ): Promise<void> {
    for (const output of outputs) {
      if (output.status !== "done" || (only && !only.has(output.id))) continue;
      const checks: QcCheck[] = [];
      if (findings !== null) {
        const mine = this.findingsFor(output, findings, outputs);
        const profile = output.profile ?? subject.qcProfile;
        const minPpi = profile === "web" ? subject.qcOptions.minPpiWeb : subject.qcOptions.minPpiPrint;
        // No findings from a document Doppl never saw would read as a pass: say it wasn't checked.
        const unchecked = mine.find((f) => f.type === "not-checked");
        for (const def of adapter.qcChecks) {
          if (unchecked) {
            if (!def.onlyWhenFound) checks.push({ level: def.level, label: def.label(minPpi), passed: true, skipped: true, reason: unchecked.message });
            continue;
          }
          const hits = mine.filter((f) => def.types.includes(f.type) && (f.type !== "low-res" || f.value === undefined || f.value < minPpi));
          if (def.onlyWhenFound && hits.length === 0) continue;
          checks.push({ level: def.level, label: def.label(minPpi), passed: hits.length === 0, reason: summarize(hits) });
        }
      }
      if (subject.qcMode === "auto_ai") checks.push(await this.ai.reviewOutput(output, ctx));
      output.qc = checks.length ? { status: qcStatus(checks), checks } : undefined;
    }
  }

  /** Object checks the routine defines ("<object> is inside <region>"), with SAM. Each segment call counts. */
  async objectChecks(outputs: RunOutput[], defs: ObjectCheckDef[], ctx: AiCallContext): Promise<void> {
    for (const output of outputs) {
      if (output.status !== "done" || output.preview?.kind !== "image") continue;
      const checks = [...(output.qc?.checks ?? [])];
      for (const def of defs) {
        if (ctx.isCancelled()) return;
        try {
          checks.push(await this.ai.checkObjectInRegion(output, def, ctx));
        } catch (err) {
          checks.push({ level: "object", label: `${def.object} is inside ${def.region}`, passed: false, reason: `Not checked: ${(err as Error).message}` });
        }
      }
      output.qc = { status: qcStatus(checks), checks };
    }
  }

  /**
   * Which findings belong to an output: findings tied to it, findings on its page, and document-level
   * findings for outputs that cover the whole document (or the first output when every output is a page).
   */
  private findingsFor(output: RunOutput, findings: RuleFinding[], all: RunOutput[]): RuleFinding[] {
    const hasDocLevelOutput = all.some((o) => o.pageIndex === undefined && !o.nodeId);
    return findings.filter((f) => {
      if (f.outputKey) return f.outputKey === output.id;
      if (f.pageIndex !== undefined) return output.pageIndex === undefined || output.pageIndex === f.pageIndex;
      return (output.pageIndex === undefined && !output.nodeId) || (!hasDocLevelOutput && output.id === all[0]?.id);
    });
  }
}

/** Flagged when a check that ran failed; "not-checked" when none could run. */
export function qcStatus(checks: QcCheck[]): QcResult["status"] {
  const ran = checks.filter((c) => !c.skipped);
  if (ran.length === 0) return "not-checked";
  return ran.every((c) => c.passed) ? "pass" : "flagged";
}

function summarize(hits: RuleFinding[]): string | undefined {
  if (hits.length === 0) return undefined;
  const unique = [...new Set(hits.map((h) => h.message))];
  const shown = unique.slice(0, 3).join("; ");
  return unique.length > 3 ? `${shown}; and ${unique.length - 3} more` : shown;
}

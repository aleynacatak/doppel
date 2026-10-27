import type { Run } from "@core/types";
import { copy } from "@/copy";

export function summarizeOutputs(run: Run) {
  const done = run.outputs.filter((o) => o.status === "done");
  const flagged = done.filter((o) => o.qc?.status === "flagged" && !o.markedOk).length;
  return {
    outputs: run.outputs.length,
    passed: done.length - flagged,
    flagged,
    failed: run.outputs.filter((o) => o.status === "failed").length,
    checked: done.some((o) => o.qc),
    aiCalls: run.aiCalls,
  };
}

/** "12 outputs · 10 passed · 2 flagged · 0 AI calls" */
export function ResultsSummary({ run }: { run: Run }) {
  return <p className="ui-h2">{copy.results.summary(summarizeOutputs(run))}</p>;
}

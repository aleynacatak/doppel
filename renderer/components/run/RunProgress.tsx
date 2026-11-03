"use client";

import type { Flow, FlowContext, Run } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { useShell } from "@/lib/store";
import { FlowCanvas } from "../flow/FlowCanvas";
import { AiCallCounter } from "../common/AiCallCounter";
import { Spinner } from "../common/Progress";
import { NodeProgressList } from "./NodeProgressList";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** Live progress of a run: phase, the flow canvas in run mode (flows), progress per node and item, cancel. */
export function RunProgress({ run, flow, onCancel }: { run: Run; flow?: Flow | null; onCancel: () => void }) {
  const apps = useShell((s) => s.apps);
  const [ctx, setCtx] = useState<FlowContext | null>(null);
  useEffect(() => {
    if (!flow) return;
    doppel().getFlowContext(flow).then(setCtx).catch(() => undefined);
  }, [flow]);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Spinner />
          <span>{run.phase ?? copy.run.progressTitle}</span>
        </div>
        <Button variant="outline" onClick={onCancel}>{copy.run.cancelRun}</Button>
      </div>
      <div className="max-w-md">
        <AiCallCounter count={run.aiCalls} label={copy.run.aiCounterLabel} hint={run.qcMode === "auto_ai" ? copy.run.aiCounterReview : copy.run.aiCounterZero} />
      </div>
      {run.mocked && <p className="text-sm text-muted-foreground">{copy.results.simulated}</p>}
      {flow && (
        <FlowCanvas
          className="h-[480px]"
          flow={flow}
          ctx={ctx}
          apps={apps}
          mode="run"
          run={run}
          updates={{}}
          selection={null}
          onSelect={() => undefined}
          overlay={<Badge variant="secondary" className="absolute right-3 top-3">{copy.flow.aiCalls(run.aiCalls)}</Badge>}
        />
      )}
      <NodeProgressList nodes={run.nodes} />
    </div>
  );
}

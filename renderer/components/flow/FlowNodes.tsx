"use client";

import type { FlowNode, InputValue, NodeProgress } from "@core/types";
import { Handle, type NodeProps, Position, useUpdateNodeInternals } from "@xyflow/react";
import { describeSpec } from "@shared/ports";
import Link from "next/link";
import { useEffect } from "react";
import { copy } from "@/copy";
import { appLabel, fileName } from "@/lib/format";
import { describeValue } from "../run/InputValueField";
import { ProgressBar, Spinner } from "../ui/Progress";
import { Tag } from "../ui/Tag";
import { type PortView, fitOf, issuesFor, nodePorts, routineAt, useFlowView } from "./flowView";

type Kind<K extends FlowNode["kind"]> = Extract<FlowNode, { kind: K }>;

const short = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One port row: label and type, with its handle on the node's edge. Shape by type; dims or highlights while dragging. */
function PortRow({ node, view, side }: { node: FlowNode; view: PortView; side: "source" | "target" }) {
  const v = useFlowView();
  const fit = fitOf(v.connecting, node, side, view);
  return (
    <div className={`ui-flow-port relative flex flex-col ${side === "source" ? "items-end pr-3 text-right" : "pl-3"}`} data-fit={fit ?? undefined}>
      <Handle
        type={side}
        position={side === "source" ? Position.Right : Position.Left}
        id={view.port.key}
        className="ui-flow-handle"
        data-port-type={view.port.type}
        data-fit={fit ?? undefined}
        isConnectable={v.mode === "edit"}
      />
      <span className="ui-small leading-tight">
        {view.port.label}
        {side === "target" && !view.port.required && <span className="ui-muted"> · {copy.ports.optional}</span>}
      </span>
      <span className="ui-flow-port-type leading-tight">{short(describeSpec(view.spec))}</span>
    </div>
  );
}

function RunFooter({ progress, runId }: { progress: NodeProgress | undefined; runId?: string }) {
  if (!progress) return null;
  return (
    <div className="flex flex-col gap-1">
      {progress.total > 0 && <ProgressBar value={(progress.done + progress.failed) / progress.total} label={progress.name} />}
      <div className="ui-small flex items-center justify-between gap-2">
        <span className="ui-muted flex items-center gap-1">
          {progress.status === "running" && <Spinner />}
          {copy.run.stageStatus[progress.status]}
          {progress.total > 0 && ` · ${progress.done + progress.failed}/${progress.total}`}
        </span>
        {progress.failed > 0 &&
          (runId ? (
            <Link href={`/results?run=${runId}#node-${progress.nodeId}`} className="ui-link nodrag">
              {copy.flow.failures(progress.failed)}
            </Link>
          ) : (
            <span>{copy.flow.failures(progress.failed)}</span>
          ))}
      </div>
    </div>
  );
}

export function RoutineNodeView({ id, selected }: NodeProps) {
  const v = useFlowView();
  const node = v.flow.nodes.find((n) => n.id === id) as Kind<"routine"> | undefined;
  const routine = node ? routineAt(v.ctx, id) : undefined;
  // Another version can have other ports: the canvas measures the handles again so connections attach to them.
  const handles = routine ? [...routine.inputs, ...routine.outputs].map((p) => p.key).join(",") : "";
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, handles, updateInternals]);
  if (!node) return null;
  const ports = nodePorts(node, routine);
  const app = v.apps.find((a) => a.id === routine?.appId);
  const issues = issuesFor(v.ctx, { nodeId: id });
  const progress = v.run?.nodes.find((n) => n.nodeId === id);
  const latest = v.updates[id];
  const docPort = routine?.inputs.find((p) => p.type === "document");
  const settings = (routine?.settings ?? [])
    .slice(0, 3)
    .map((s) => {
      const value = node.settings?.[s.key] ?? s.default;
      return value === undefined || value === null || value === "" ? null : `${s.label}: ${Array.isArray(value) ? value.length : String(value)}`;
    })
    .filter(Boolean)
    .join(" · ");
  const flagged = v.run ? v.run.outputs.filter((o) => o.node === id && o.qc?.status === "flagged" && !o.markedOk).length : 0;
  return (
    <div className="ui-flow-node w-64" data-selected={selected} data-invalid={issues.length > 0} data-active={v.mode === "run" && progress?.status === "running"}>
      <div className="flex items-center gap-2 px-3 pt-2">
        {routine && <Tag tone="strong">{appLabel(routine.appId)}</Tag>}
        <span className="ui-h3 min-w-0 flex-1 truncate" title={routine?.name}>
          {routine?.name ?? copy.common.notFound}
        </span>
        <span className="ui-small ui-muted">{copy.flow.version(node.routineVersion)}</span>
        {app && <span className="ui-dot" data-on={app.status === "connected"} title={app.status === "connected" ? copy.flow.appDot.connected : copy.flow.appDot.off} />}
      </div>
      {latest && v.mode === "edit" && (
        <div className="px-3 pt-1">
          <button type="button" className="ui-chip ui-small nodrag" onClick={() => v.onUpdateNode?.(id)}>
            {copy.flow.updateAvailable(latest)} · {copy.flow.update}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-2 py-2">
        <div className="flex flex-col gap-2">
          {ports.inputs.map((p) => (
            <PortRow key={p.port.key} node={node} view={p} side="target" />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {ports.outputs.map((p) => (
            <PortRow key={p.port.key} node={node} view={p} side="source" />
          ))}
        </div>
      </div>
      <div className="ui-divider flex flex-col gap-1 px-3 py-2">
        {routine?.iterate && <span className="ui-small ui-muted">{copy.flow.perItem(routine.inputs.find((p) => p.key === routine.iterate!.input)?.label ?? routine.iterate.input)}</span>}
        {docPort && routine && <span className="ui-small ui-muted">{copy.routine.documentPort(appLabel(routine.appId))}</span>}
        {settings && <span className="ui-small ui-muted line-clamp-2">{settings}</span>}
        {v.mode === "run" ? (
          <RunFooter progress={progress} runId={v.run?.status !== "running" ? v.run?.id : undefined} />
        ) : progress ? (
          <span className="ui-small ui-muted">{copy.flow.lastRun(progress.done, progress.failed, flagged)}</span>
        ) : (
          <span className="ui-small ui-muted">{copy.flow.neverRun}</span>
        )}
        {issues[0] && v.mode === "edit" && <span className="ui-small">{issues[0].message}</span>}
      </div>
    </div>
  );
}

export function InputNodeView({ id, selected }: NodeProps) {
  const v = useFlowView();
  const node = v.flow.nodes.find((n) => n.id === id) as Kind<"input"> | undefined;
  if (!node) return null;
  const [view] = nodePorts(node, undefined).outputs;
  const progress = v.run?.nodes.find((n) => n.nodeId === id);
  const picked = v.mode === "run" ? v.run?.inputs[id] : v.pickedInputs?.[id];
  const issues = issuesFor(v.ctx, { nodeId: id });
  return (
    <div className="ui-flow-node w-56" data-selected={selected} data-invalid={issues.length > 0} data-kind="input">
      <div className="ui-label px-3 pt-2">{copy.flow.inputNode}</div>
      <div className="py-2">
        <PortRow node={node} view={view} side="source" />
      </div>
      <div className="ui-divider flex flex-col gap-1 px-3 py-2">
        {v.mode === "edit" && v.onPickInput ? (
          <button type="button" className="ui-chip ui-small nodrag self-start" onClick={() => v.onPickInput?.(id)}>
            {describeValue(picked as InputValue) ?? copy.run.choose}
          </button>
        ) : (
          <span className="ui-small ui-muted truncate">{describeValue(picked as InputValue) ?? copy.run.notChosen}</span>
        )}
        {progress?.failed ? <span className="ui-small">{copy.flow.failures(progress.failed)}</span> : null}
        {progress?.status === "failed" && progress.error && <span className="ui-small">{progress.error}</span>}
      </div>
    </div>
  );
}

export function OutputNodeView({ id, selected }: NodeProps) {
  const v = useFlowView();
  const node = v.flow.nodes.find((n) => n.id === id) as Kind<"output"> | undefined;
  if (!node) return null;
  const [view] = nodePorts(node, undefined).inputs;
  const progress = v.run?.nodes.find((n) => n.nodeId === id);
  const issues = issuesFor(v.ctx, { nodeId: id });
  return (
    <div className="ui-flow-node w-56" data-selected={selected} data-invalid={issues.length > 0} data-kind="output">
      <div className="ui-label px-3 pt-2">{copy.flow.saveToFolder}</div>
      <div className="py-2">
        <PortRow node={node} view={{ ...view, port: { ...view.port, required: true } }} side="target" />
      </div>
      {(progress || issues[0]) && (
        <div className="ui-divider flex flex-col gap-1 px-3 py-2">
          {progress?.status === "done" && (
            <span className="ui-small" title={progress.documentName}>
              {copy.results.savedTo(progress.done, fileName(progress.documentName ?? ""))}
            </span>
          )}
          {progress?.note && <span className="ui-small ui-muted">{progress.note}</span>}
          {issues[0] && v.mode === "edit" && <span className="ui-small">{issues[0].message}</span>}
        </div>
      )}
    </div>
  );
}

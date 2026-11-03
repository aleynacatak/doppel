"use client";

import type { ConverterOption, Flow, FlowContext, FlowEdge, FlowNode, InputValue, MatchRule, ParamValue, PortDef, PortType } from "@core/types";
import { describeSpec, inputSpec, isListType, normalizeExtensions } from "@shared/ports";
import { contractChanges } from "@shared/routineDiff";
import Link from "next/link";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { InputValueField } from "../run/InputValueField";
import { ParamField } from "../run/ParamField";
import { Field } from "../common/Field";
import { Tag } from "../common/Tag";
import { MatchRuleEditor } from "./MatchRuleEditor";
import { edgeCarries, issuesFor, nodeName, routineAt } from "./flowView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

const PORT_TYPES: PortType[] = ["rows", "fileList", "file", "folder", "text", "number", "boolean"];
const SCALARS: PortType[] = ["text", "number", "boolean"];
const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

interface Props {
  flow: Flow;
  ctx: FlowContext | null;
  selection: { kind: "node" | "edge"; id: string } | null;
  picked: Record<string, InputValue>;
  onPick: (nodeId: string, value: InputValue) => void;
  onChange: (flow: Flow) => void;
  onUpdateNode: (nodeId: string) => void;
  onMakeCompatible: (edgeId: string, side: "source" | "target") => void;
  onInsertConverter: (edgeId: string, routineId: string) => void;
}

function Issues({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm">
      {messages.map((m, i) => (
        <li key={i}>{m}</li>
      ))}
    </ul>
  );
}

function FlowDetails({ flow, onChange }: { flow: Flow; onChange: (f: Flow) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label={copy.flow.nameLabel} htmlFor="flow-name">
        <Input id="flow-name" value={flow.name} onChange={(e) => onChange({ ...flow, name: e.target.value })} />
      </Field>
      <Field label={copy.flow.descriptionLabel} htmlFor="flow-description">
        <Textarea id="flow-description" className="h-20" value={flow.description} onChange={(e) => onChange({ ...flow, description: e.target.value })} />
      </Field>
      <p className="text-sm text-muted-foreground">{copy.flow.inspectorEmpty}</p>
    </div>
  );
}

function setNode(flow: Flow, id: string, patch: (n: FlowNode) => FlowNode): Flow {
  return { ...flow, nodes: flow.nodes.map((n) => (n.id === id ? patch(n) : n)) };
}

function RoutineNodeInspector({ node, ...p }: Props & { node: Extract<FlowNode, { kind: "routine" }> }) {
  const { flow, ctx, onChange } = p;
  const routine = routineAt(ctx, node.id);
  const latest = ctx?.latest[node.routineId];
  const outdated = !!latest && latest > node.routineVersion;
  const { data: newest } = useAsync(() => (outdated ? doppel().getRoutine(node.routineId) : Promise.resolve(null)), [node.routineId, outdated, latest]);
  const issues = issuesFor(ctx, { nodeId: node.id }).map((i) => i.message);
  if (!routine) return <Issues messages={issues.length ? issues : [copy.common.notFound]} />;
  const breaking = outdated && newest ? contractChanges(routine, newest).filter((c) => c.breaking) : [];
  const sourceOf = (port: string) => {
    const e = flow.edges.find((x) => x.to.nodeId === node.id && x.to.port === port);
    const from = e && flow.nodes.find((n) => n.id === e.from.nodeId);
    return from ? nodeName(from, ctx) : null;
  };
  const targetsOf = (port: string) =>
    flow.edges
      .filter((x) => x.from.nodeId === node.id && x.from.port === port)
      .map((e) => nodeName(flow.nodes.find((n) => n.id === e.to.nodeId), ctx));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="strong">{appLabel(routine.appId)}</Tag>
          {routine.starter && <Tag tone="quiet">{copy.routine.madeByDoppl}</Tag>}
        </div>
        <div className="text-base font-semibold">{routine.name}</div>
        <div className="flex flex-wrap gap-3">
          <Link href={`/routine?id=${routine.id}`} className="text-sm text-primary underline-offset-4 hover:underline">
            {copy.flow.openRoutine}
          </Link>
          <Link href={`/refine?routine=${node.routineId}&flow=${flow.id}&node=${node.id}`} className="text-sm text-primary underline-offset-4 hover:underline">
            {copy.flow.refineNode}
          </Link>
        </div>
        <div className="text-sm text-muted-foreground">{copy.flow.pinned(node.routineVersion, latest ?? node.routineVersion)}</div>
        {outdated && breaking.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-sm">
            <p>{copy.flow.breakingUpdate}</p>
            <ul className="flex flex-col gap-1">
              {breaking.map((c, i) => (
                <li key={i}>{c.message}</li>
              ))}
            </ul>
          </div>
        )}
        {outdated && (
          <Button variant="outline" size="sm" className="h-auto whitespace-normal text-left" onClick={() => p.onUpdateNode(node.id)}>
            {copy.flow.updateAvailable(latest!)} · {copy.flow.update}
          </Button>
        )}
      </div>
      <Issues messages={issues} />
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">{copy.flow.inputsTitle}</div>
        {routine.inputs.map((port) => {
          const from = sourceOf(port.key);
          const scalar = SCALARS.includes(port.type);
          return (
            <div key={port.key} className="flex flex-col gap-1.5">
              <div className="text-sm">
                {port.label} <span className="text-muted-foreground">· {port.type === "document" ? copy.routine.documentPort(appLabel(routine.appId)) : describeSpec(inputSpec(port, routine.appId))}</span>
              </div>
              {port.type !== "document" && <div className="text-sm text-muted-foreground">{from ? copy.flow.listFrom(from) : "Not connected"}</div>}
              {scalar && !from && (
                <InputValueField
                  id={`value-${node.id}-${port.key}`}
                  port={{ ...port, label: copy.flow.valuesTitle, description: copy.flow.valueHint }}
                  value={node.values?.[port.key] ?? null}
                  onChange={(v) => onChange(setNode(flow, node.id, (n) => (n.kind === "routine" ? { ...n, values: { ...(n.values ?? {}), [port.key]: v as string | number | boolean } } : n)))}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">{copy.flow.outputsTitle}</div>
        {routine.outputs.map((port) => (
          <div key={port.key} className="text-sm">
            {port.label}
            {targetsOf(port.key).length > 0 && <span className="text-muted-foreground"> → {targetsOf(port.key).join(", ")}</span>}
          </div>
        ))}
      </div>
      {routine.settings.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="text-sm font-medium">{copy.flow.settingsTitle}</div>
          {routine.settings.map((s) => (
            <ParamField
              key={s.key}
              routineId={routine.id}
              param={s}
              value={(node.settings?.[s.key] ?? s.default ?? null) as ParamValue}
              onChange={(v) => onChange(setNode(flow, node.id, (n) => (n.kind === "routine" ? { ...n, settings: { ...(n.settings ?? {}), [s.key]: v } } : n)))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PortEditor({ node, ...p }: Props & { node: Extract<FlowNode, { kind: "input" | "output" }> }) {
  const { flow, onChange } = p;
  const port = node.port;
  const set = (patch: Partial<PortDef>) => onChange(setNode(flow, node.id, (n) => (n.kind === "input" || n.kind === "output" ? { ...n, port: { ...n.port, ...patch } } : n)));
  const issues = issuesFor(p.ctx, { nodeId: node.id }).map((i) => i.message);
  return (
    <div className="flex flex-col gap-4">
      <div className="text-base font-semibold">{node.kind === "input" ? copy.flow.inputNode : copy.flow.saveToFolder}</div>
      <Issues messages={issues} />
      <Field label={copy.flow.portLabel} htmlFor={`label-${node.id}`}>
        <Input id={`label-${node.id}`} value={port.label} onChange={(e) => set({ label: e.target.value })} />
      </Field>
      {node.kind === "input" && (
        <>
          <Field label={copy.flow.portType} htmlFor={`type-${node.id}`}>
            <NativeSelect id={`type-${node.id}`} className="w-full" value={port.type} onChange={(e) => set({ type: e.target.value as PortType, extensions: undefined, columns: undefined })}>
              {PORT_TYPES.map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {copy.ports.types[t]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {(port.type === "file" || port.type === "fileList") && (
            <Field label={copy.flow.portExtensions} htmlFor={`ext-${node.id}`}>
              <Input
                id={`ext-${node.id}`}
                defaultValue={(port.extensions ?? []).join(", ")}
                onBlur={(e) => set({ extensions: normalizeExtensions(list(e.target.value)) })}
              />
            </Field>
          )}
          {port.type === "rows" && (
            <Field label={copy.flow.portColumns} htmlFor={`cols-${node.id}`}>
              <Input id={`cols-${node.id}`} defaultValue={(port.columns ?? []).join(", ")} onBlur={(e) => set({ columns: list(e.target.value) })} />
            </Field>
          )}
          <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
            <Checkbox className="mt-0.5" checked={port.required} onCheckedChange={(checked) => set({ required: checked })} />
            <span>{copy.flow.portRequired}</span>
          </label>
          <InputValueField id={`pick-${node.id}`} port={{ ...port, label: copy.run.inputsTitle }} value={p.picked[node.id]} onChange={(v) => p.onPick(node.id, v)} />
        </>
      )}
    </div>
  );
}

function EdgeInspector({ edge, ...p }: Props & { edge: FlowEdge }) {
  const { flow, ctx, onChange } = p;
  const from = flow.nodes.find((n) => n.id === edge.from.nodeId);
  const to = flow.nodes.find((n) => n.id === edge.to.nodeId);
  const issues = issuesFor(ctx, { edgeId: edge.id });
  const incompatible = issues.some((i) => i.code === "incompatible");
  const targetRoutine = to?.kind === "routine" ? routineAt(ctx, to.id) : undefined;
  const sourceRoutine = from?.kind === "routine" ? routineAt(ctx, from.id) : undefined;
  const toPort = to?.kind === "output" ? to.port : targetRoutine?.inputs.find((x) => x.key === edge.to.port);
  const iterPort = targetRoutine?.iterate ? targetRoutine.inputs.find((x) => x.key === targetRoutine.iterate!.input) : undefined;
  const join = !!iterPort && !!toPort && toPort.key !== iterPort.key && isListType(toPort.type);
  const [converters, setConverters] = useState<ConverterOption[] | null>(null);
  useEffect(() => {
    if (!incompatible) return;
    let alive = true;
    doppel()
      .converterOptions(flow, edge.id)
      .then((c) => alive && setConverters(c))
      .catch(() => alive && setConverters([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incompatible, edge.id, flow.nodes.length]);
  const setMatch = (match: MatchRule) => onChange({ ...flow, edges: flow.edges.map((e) => (e.id === edge.id ? { ...e, match } : e)) });
  // A new version removed or renamed the port this connection used: offer the routine's ports as they are now.
  const lostFrom = !!sourceRoutine && !sourceRoutine.outputs.some((o) => o.key === edge.from.port);
  const lostTo = !!targetRoutine && !targetRoutine.inputs.some((i) => i.key === edge.to.port);
  const reconnect = (side: "from" | "to", port: string) =>
    onChange({ ...flow, edges: flow.edges.map((e) => (e.id === edge.id ? { ...e, [side]: { ...e[side], port } } : e)) });
  const fromPortLabel = from?.kind === "routine" ? (sourceRoutine?.outputs.find((x) => x.key === edge.from.port)?.label ?? edge.from.port) : from?.kind === "input" ? from.port.label : edge.from.port;
  return (
    <div className="flex flex-col gap-6">
      <div className="text-base font-semibold">{copy.flow.edgeTitle}</div>
      <div className="text-sm flex flex-col gap-1.5">
        <div>
          <span className="text-sm font-medium">{copy.flow.edgeFrom}</span> {nodeName(from, ctx)} · {fromPortLabel}
        </div>
        <div className="text-muted-foreground">{copy.flow.edgeCarries(edgeCarries(flow, ctx, edge.id) ?? "?")}</div>
        <div>
          <span className="text-sm font-medium">{copy.flow.edgeTo}</span> {nodeName(to, ctx)} · {toPort?.label ?? edge.to.port}
        </div>
        {toPort && to?.kind === "routine" && targetRoutine && <div className="text-muted-foreground">{copy.flow.edgeTakes(describeSpec(inputSpec(toPort, targetRoutine.appId)))}</div>}
      </div>
      <Issues messages={issues.map((i) => i.message)} />
      {(lostFrom || lostTo) && (
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.flow.reconnectTitle}</div>
          {lostFrom &&
            sourceRoutine!.outputs.map((o) => (
              <Button variant="outline" key={o.key} size="sm" className="h-auto whitespace-normal text-left" onClick={() => reconnect("from", o.key)}>
                {copy.flow.reconnectFrom(o.label)}
              </Button>
            ))}
          {lostTo &&
            targetRoutine!.inputs
              .filter((i) => i.type !== "document")
              .map((i) => (
                <Button variant="outline" key={i.key} size="sm" className="h-auto whitespace-normal text-left" onClick={() => reconnect("to", i.key)}>
                  {copy.flow.reconnectTo(i.label)}
                </Button>
              ))}
        </div>
      )}
      {incompatible && (
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium">{copy.flow.incompatibleTitle}</div>
          {converters === null ? null : converters.length ? (
            converters.map((c) => (
              <Button variant="outline" key={c.routineId} size="sm" className="h-auto whitespace-normal text-left" onClick={() => p.onInsertConverter(edge.id, c.routineId)}>
                {copy.flow.insertConverter(c.name)}
              </Button>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{copy.flow.noConverters}</p>
          )}
          {sourceRoutine && !sourceRoutine.starter && (
            <Button variant="outline" size="sm" className="h-auto whitespace-normal text-left" onClick={() => p.onMakeCompatible(edge.id, "source")}>
              {copy.flow.makeCompatible}: {copy.flow.adaptSource(sourceRoutine.name)}
            </Button>
          )}
          {targetRoutine && !targetRoutine.starter && (
            <Button variant="outline" size="sm" className="h-auto whitespace-normal text-left" onClick={() => p.onMakeCompatible(edge.id, "target")}>
              {copy.flow.makeCompatible}: {copy.flow.adaptTarget(targetRoutine.name)}
            </Button>
          )}
          <p className="text-sm text-muted-foreground">{copy.flow.makeCompatibleHint}</p>
        </div>
      )}
      {join && targetRoutine && iterPort && toPort && !incompatible && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{copy.flow.joinHint(targetRoutine.name, iterPort.label)}</p>
          <MatchRuleEditor flow={flow} edgeId={edge.id} rule={edge.match} onChange={setMatch} iterPort={iterPort} joinedPort={toPort} inputs={p.picked} />
        </div>
      )}
    </div>
  );
}

/** The right-hand panel: the selected node (settings, ports, version) or connection (types, joins, fixes). */
export function FlowInspector(props: Props & { onRemove: () => void }) {
  const { flow, selection } = props;
  if (!selection) return <FlowDetails flow={flow} onChange={props.onChange} />;
  if (selection.kind === "edge") {
    const edge = flow.edges.find((e) => e.id === selection.id);
    if (!edge) return <FlowDetails flow={flow} onChange={props.onChange} />;
    return (
      <div className="flex flex-col gap-6">
        <EdgeInspector {...props} edge={edge} />
        <Button variant="outline" size="sm" onClick={props.onRemove}>
          {copy.flow.removeEdge}
        </Button>
      </div>
    );
  }
  const node = flow.nodes.find((n) => n.id === selection.id);
  if (!node) return <FlowDetails flow={flow} onChange={props.onChange} />;
  return (
    <div className="flex flex-col gap-6">
      {node.kind === "routine" ? <RoutineNodeInspector {...props} node={node} /> : <PortEditor {...props} node={node} />}
      <Button variant="outline" size="sm" onClick={props.onRemove}>
        {copy.flow.removeNode}
      </Button>
    </div>
  );
}

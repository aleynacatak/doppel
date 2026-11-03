"use client";

import type { PortType, Routine } from "@core/types";
import { type DragEvent, useEffect, useRef } from "react";
import { acceptedByOutput, compatible, inputSpec, type PortSpec } from "@shared/ports";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Tag } from "../common/Tag";
import { DRAG_TYPE, type DragItem } from "./FlowCanvas";
import { IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Item as UiItem, ItemActions, ItemContent } from "@/components/ui/item";
import { Card } from "@/components/ui/card";

const INPUT_TYPES: { type: PortType; label: string }[] = [
  { type: "rows", label: "Data file (rows)" },
  { type: "fileList", label: "Files or a folder" },
  { type: "file", label: "A file" },
  { type: "folder", label: "A folder" },
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "boolean", label: "Yes / no" },
];

function Item({ item, children, onAdd }: { item: DragItem; children: React.ReactNode; onAdd: (item: DragItem) => void }) {
  const start = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
    e.dataTransfer.effectAllowed = "copy";
  };
  return (
    <UiItem render={<li />} variant="outline" size="xs" draggable onDragStart={start} className="ui-flow-library-item" title={copy.flow.dragHint}>
      <ItemContent className="min-w-0">{children}</ItemContent>
      <ItemActions>
        <Button variant="ghost" size="icon-xs" onClick={() => onAdd(item)} aria-label="Add">
          <IconPlus />
        </Button>
      </ItemActions>
    </UiItem>
  );
}

/** What can go on the canvas: inputs, a "Save to folder" output, and routines (mine and starters). */
export function LibraryPanel({ mine, starters, onAdd }: { mine: Routine[]; starters: Routine[]; onAdd: (item: DragItem) => void }) {
  const routineItem = (r: Routine) => (
    <Item key={r.id} item={{ kind: "routine", routineId: r.id }} onAdd={onAdd}>
      <span className="flex flex-col">
        <span className="text-sm truncate">{r.name}</span>
        <span className="flex gap-1">
          <Tag>{appLabel(r.appId)}</Tag>
          {r.starter && <Tag tone="quiet">{copy.routine.madeByDoppl}</Tag>}
        </span>
      </span>
    </Item>
  );
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{copy.flow.dragHint}</p>
      <section className="flex flex-col gap-1.5">
        <div className="text-sm font-medium">{copy.flow.libraryInputs}</div>
        <ul className="flex flex-col gap-1.5">
          {INPUT_TYPES.map((t) => (
            <Item key={t.type} item={{ kind: "input", type: t.type }} onAdd={onAdd}>
              <span className="text-sm">{t.label}</span>
            </Item>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1.5">
        <div className="text-sm font-medium">{copy.flow.libraryOutput}</div>
        <ul className="flex flex-col gap-1.5">
          <Item item={{ kind: "output" }} onAdd={onAdd}>
            <span className="text-sm">{copy.flow.saveToFolder}</span>
          </Item>
        </ul>
      </section>
      <section className="flex flex-col gap-1.5">
        <div className="text-sm font-medium">{copy.flow.libraryMine}</div>
        {mine.length ? <ul className="flex flex-col gap-1.5">{mine.map(routineItem)}</ul> : <p className="text-sm text-muted-foreground">{copy.library.noMyRoutines}</p>}
      </section>
      {starters.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <div className="text-sm font-medium">{copy.flow.libraryStarters}</div>
          <ul className="flex flex-col gap-1.5">{starters.map(routineItem)}</ul>
        </section>
      )}
    </div>
  );
}

export type AddChoice = { kind: "output" } | { kind: "routine"; routineId: string; port: string };

/** Dropped a connection on empty canvas: the routines whose inputs take it, and "Save to folder". */
export function AddNodeMenu({
  at,
  spec,
  what,
  routines,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  spec: PortSpec;
  what: string;
  routines: Routine[];
  onPick: (choice: AddChoice) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  const options = routines.flatMap((r) => {
    const port = r.inputs.find((p) => p.type !== "document" && compatible(spec, inputSpec(p, r.appId)).ok);
    return port ? [{ routine: r, port }] : [];
  });
  return (
    <Card ref={ref} className="gap-0 py-0 ui-flow-menu fixed z-50 flex max-h-80 w-72 flex-col gap-1.5 overflow-y-auto p-3" style={{ left: at.x, top: at.y }}>
      <div className="text-sm font-medium px-1">{copy.flow.addMenuTitle(what)}</div>
      {acceptedByOutput(spec).ok && (
        <button type="button" className="ui-flow-menu-item text-sm" onClick={() => onPick({ kind: "output" })}>
          {copy.flow.saveToFolder}
        </button>
      )}
      {options.map(({ routine, port }) => (
        <button key={routine.id} type="button" className="ui-flow-menu-item flex flex-col items-start" onClick={() => onPick({ kind: "routine", routineId: routine.id, port: port.key })}>
          <span className="text-sm">{routine.name}</span>
          <span className="text-sm text-muted-foreground">
            {appLabel(routine.appId)} · → {port.label}
          </span>
        </button>
      ))}
      {options.length === 0 && <p className="text-sm text-muted-foreground px-1">{copy.flow.addMenuEmpty}</p>}
    </Card>
  );
}

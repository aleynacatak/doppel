"use client";

import type { FigmaActionList, Stage } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Tag } from "../ui/Tag";
import { ScriptViewer } from "./ScriptViewer";

/** "{{params.products.rows}}" → "products rows" (for "Once per item of …"). */
function describeList(over: string) {
  return over.replace(/[{}]/g, "").replace(/^params\./, "").replace(/^stage\.(\w+)\.outputs\./, "$1 → ").replace(/\./g, " ");
}

/** A multi-app routine's stages, in order, each with its app, what it repeats over, and its steps. */
export function StagesList({ stages, showBodies = false }: { stages: Stage[]; showBodies?: boolean }) {
  return (
    <ol className="flex flex-col gap-4">
      {stages.map((s, i) => (
        <li key={s.id} className="ui-card flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone="strong">{appLabel(s.appId)}</Tag>
            <span className="ui-small ui-muted">{copy.routine.stageLine(i + 1)}</span>
            <span className="ui-h3">{s.name}</span>
          </div>
          {s.repeat && <p className="ui-small ui-muted">{copy.routine.repeatsOver(describeList(s.repeat.over))}</p>}
          {s.steps?.length ? (
            <ol className="flex flex-col gap-1">
              {s.steps.map((step, j) => (
                <li key={j} className="flex gap-3">
                  <span className="ui-muted w-5 shrink-0 text-right">{j + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {showBodies && (
            <ScriptViewer
              script={s.kind === "actions" ? JSON.stringify((s.body as FigmaActionList).actions, null, 2) : String(s.body)}
              language={s.kind === "actions" ? "Doppl action list (JSON)" : "ExtendScript"}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

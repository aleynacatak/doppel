"use client";

import type { Flow, InputValue, MatchPreview, MatchRule, PortDef } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Field } from "../ui/Field";
import { Spinner } from "../ui/Progress";

const RULES: MatchRule["by"][] = ["index", "fileNameEqualsColumn", "columnEquals"];

/** A rule with sensible empty fields when its kind changes. */
function ruleOf(by: MatchRule["by"], columns: string[], otherColumns: string[]): MatchRule {
  if (by === "index") return { by };
  if (by === "fileNameEqualsColumn") return { by, column: columns[0] ?? "", ignoreExtension: true };
  return { by, leftColumn: columns[0] ?? "", rightColumn: otherColumns[0] ?? columns[0] ?? "" };
}

function ColumnSelect({ value, columns, onChange, label, id }: { value: string; columns: string[]; onChange: (v: string) => void; label: string; id: string }) {
  return (
    <Field label={label} htmlFor={id}>
      {columns.length ? (
        <select id={id} className="ui-select max-w-xs" value={value} onChange={(e) => onChange(e.target.value)}>
          {!columns.includes(value) && <option value={value}>{value || "—"}</option>}
          {columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      ) : (
        <input id={id} className="ui-input max-w-xs" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/**
 * How a second list pairs with the items a routine iterates over, with the first pairs it makes. The preview uses
 * the values picked for the inputs (or the flow's last run).
 */
export function MatchRuleEditor({
  flow,
  edgeId,
  rule,
  onChange,
  iterPort,
  joinedPort,
  inputs,
}: {
  flow: Flow;
  edgeId: string;
  rule: MatchRule | undefined;
  onChange: (rule: MatchRule) => void;
  iterPort: PortDef;
  joinedPort: PortDef;
  inputs?: Record<string, InputValue>;
}) {
  const [preview, setPreview] = useState<(MatchPreview & { rule: MatchRule | null }) | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([flow.nodes, flow.edges.map((e) => [e.id, e.from, e.to]), edgeId, rule, inputs]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    doppel()
      .previewMatch(flow, edgeId, rule ?? null, inputs)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        // No rule yet: take the suggested one.
        if (!rule && p.rule) onChange(p.rule);
      })
      .catch(() => alive && setPreview(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rowsColumns = (iterPort.type === "rows" ? iterPort.columns : joinedPort.columns) ?? [];
  const otherColumns = (iterPort.type === "rows" && joinedPort.type === "rows" ? joinedPort.columns : []) ?? [];
  const current = rule ?? preview?.rule ?? undefined;
  return (
    <div className="flex flex-col gap-3">
      <Field label={copy.match.rule} htmlFor={`rule-${edgeId}`}>
        <select
          id={`rule-${edgeId}`}
          className="ui-select max-w-xs"
          value={current?.by ?? ""}
          onChange={(e) => onChange(ruleOf(e.target.value as MatchRule["by"], rowsColumns, otherColumns))}
        >
          {!current && <option value="">—</option>}
          {RULES.map((r) => (
            <option key={r} value={r}>
              {copy.match.labels[r]}
            </option>
          ))}
        </select>
      </Field>
      {current?.by === "fileNameEqualsColumn" && (
        <>
          <ColumnSelect id={`col-${edgeId}`} label={copy.match.column} value={current.column} columns={rowsColumns} onChange={(column) => onChange({ ...current, column })} />
          <label className="ui-choice">
            <input type="checkbox" checked={current.ignoreExtension} onChange={(e) => onChange({ ...current, ignoreExtension: e.target.checked })} />
            <span>{copy.match.ignoreExtension}</span>
          </label>
        </>
      )}
      {current?.by === "columnEquals" && (
        <>
          <ColumnSelect id={`left-${edgeId}`} label={copy.match.leftColumn} value={current.leftColumn} columns={iterPort.columns ?? []} onChange={(leftColumn) => onChange({ ...current, leftColumn })} />
          <ColumnSelect id={`right-${edgeId}`} label={copy.match.rightColumn} value={current.rightColumn} columns={joinedPort.columns ?? []} onChange={(rightColumn) => onChange({ ...current, rightColumn })} />
        </>
      )}
      <div className="flex flex-col gap-1">
        <div className="ui-label flex items-center gap-2">
          {copy.match.preview} {loading && <Spinner />}
        </div>
        {preview?.note ? (
          <p className="ui-small ui-muted">{preview.note}</p>
        ) : preview ? (
          <>
            <table className="ui-table ui-small">
              <tbody>
                {preview.pairs.map((p, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2">{p.item}</td>
                    <td className="py-1 pr-2 ui-muted">→</td>
                    <td className="py-1" title={p.problem}>
                      {p.match ?? <span className="ui-muted">{copy.match.noMatch}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="ui-small ui-muted">{copy.match.previewCount(preview.total, preview.unmatched)}</p>
          </>
        ) : null}
      </div>
    </div>
  );
}

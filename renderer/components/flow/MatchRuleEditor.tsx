"use client";

import type { Flow, InputValue, MatchPreview, MatchRule, PortDef } from "@core/types";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { Field } from "../ui/Field";
import { Spinner } from "../ui/Progress";

/** The two choices a designer sees: by name (Doppl finds how), or in order. */
type Choice = "name" | "index";
const choiceOf = (rule: MatchRule | undefined): Choice | "" => (!rule ? "" : rule.by === "index" ? "index" : "name");

/** "By name" for these two lists, when Doppl has no suggestion: the file named in a column, similar file names, or equal columns. */
function byName(iterPort: PortDef, joinedPort: PortDef, rowsColumns: string[], otherColumns: string[], optional?: boolean): MatchRule {
  const keep = optional ? { optional } : {};
  if (iterPort.type === "rows" && joinedPort.type === "rows") {
    const shared = rowsColumns.find((c) => otherColumns.includes(c));
    return { by: "columnEquals", leftColumn: shared ?? rowsColumns[0] ?? "", rightColumn: shared ?? otherColumns[0] ?? "", ...keep };
  }
  if (iterPort.type === "rows" || joinedPort.type === "rows") return { by: "fileNameEqualsColumn", column: rowsColumns[0] ?? "", ignoreExtension: true, loose: true, ...keep };
  return { by: "sameFileName", ...keep };
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
          value={choiceOf(current)}
          onChange={async (e) => {
            const optional = current?.optional ? { optional: true } : {};
            if (e.target.value === "index") return onChange({ by: "index", ...optional });
            // By name: the way that pairs the most items (Doppl's suggestion), else the plain one for these lists.
            const suggested = await doppel()
              .previewMatch(flow, edgeId, null, inputs)
              .then((p) => p.rule)
              .catch(() => null);
            onChange(suggested && suggested.by !== "index" ? { ...suggested, ...optional } : byName(iterPort, joinedPort, rowsColumns, otherColumns, current?.optional));
          }}
        >
          {!current && <option value="">—</option>}
          <option value="name">{copy.match.choices.name}</option>
          <option value="index">{copy.match.choices.index}</option>
        </select>
      </Field>
      {current?.by === "fileNameEqualsColumn" && (
        <ColumnSelect id={`col-${edgeId}`} label={copy.match.column} value={current.column} columns={rowsColumns} onChange={(column) => onChange({ ...current, column, loose: true })} />
      )}
      {current && (
        <label className="ui-choice">
          <input type="checkbox" checked={!!current.optional} onChange={(e) => onChange({ ...current, optional: e.target.checked || undefined })} />
          <span>{copy.match.optional}</span>
        </label>
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
            {/* Nothing pairs: say why here, not only on hover. */}
            {preview.total > 0 && preview.unmatched === preview.total && preview.pairs[0]?.problem && (
              <p className="ui-small">
                {copy.match.why} {preview.pairs[0].problem}
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

import type { ParamDef, ParamValue, ParamValues } from "@core/types";
import { copy } from "@/copy";
import { ParamField } from "./ParamField";

/** Form generated from the routine's ParamDef[]. */
export function ParamForm({
  routineId,
  params,
  values,
  onChange,
}: {
  routineId: string;
  params: ParamDef[];
  values: ParamValues;
  onChange: (key: string, value: ParamValue) => void;
}) {
  if (params.length === 0) return <p className="ui-muted">{copy.routine.noParams}</p>;
  return (
    <div className="flex flex-col gap-4">
      {params.map((p) => (
        <ParamField key={p.key} routineId={routineId} param={p} value={values[p.key]} onChange={(v) => onChange(p.key, v)} />
      ))}
    </div>
  );
}

/** Initial values: what was used last time, else the defaults. */
export function initialValues(params: ParamDef[], last?: ParamValues): ParamValues {
  const values: ParamValues = {};
  for (const p of params) {
    values[p.key] = last?.[p.key] ?? (p.default as ParamValue | undefined) ?? (p.type === "formatList" ? [] : p.type === "boolean" ? false : null);
  }
  return values;
}

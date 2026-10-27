"use client";

import type { ParamDef, ParamValue } from "@core/types";
import { useEffect } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";

interface Props {
  routineId: string;
  param: ParamDef;
  value: ParamValue | undefined;
  onChange: (value: ParamValue) => void;
}

function PathPicker({ param, value, onChange }: Omit<Props, "routineId">) {
  const pick = async () => {
    if (param.type === "folder") {
      const folder = await doppel().pickFolder();
      if (folder) onChange(folder);
    } else {
      const [file] = await doppel().pickFiles({ extensions: param.extensions });
      if (file) onChange(file);
    }
  };
  const path = typeof value === "string" && value ? value : null;
  return (
    <div className="flex items-center gap-3">
      <Button onClick={pick}>{path ? copy.run.change : copy.run.choose}</Button>
      <span className={path ? "truncate" : "ui-muted"} title={path ?? undefined}>
        {path ? fileName(path) : copy.run.notChosen}
      </span>
    </div>
  );
}

function SelectField({ routineId, param, value, onChange }: Props) {
  const { data: options, loading } = useAsync(() => doppel().getParamOptions(routineId, param.key), [routineId, param.key]);
  // Keep the value valid: fall back to the default or the first option the app offers.
  useEffect(() => {
    if (!options?.length) return;
    if (!options.some((o) => o.value === value)) {
      onChange(options.find((o) => o.value === param.default)?.value ?? options[0].value);
    }
  }, [options, value, param.default, onChange]);
  return (
    <select id={param.key} className="ui-select max-w-md" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} disabled={loading}>
      {loading && <option>{copy.run.loadingOptions}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function FormatList({ param, value, onChange }: Omit<Props, "routineId">) {
  const selected = Array.isArray(value) ? value : [];
  const options = param.options ?? [];
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <button type="button" className="ui-small ui-link" onClick={() => onChange(options.map((o) => o.value))}>
          {copy.run.selectAll}
        </button>
        <button type="button" className="ui-small ui-link" onClick={() => onChange([])}>
          {copy.run.selectNone}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((o) => (
          <label key={o.value} className="ui-choice">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** One input generated from a ParamDef. */
export function ParamField(props: Props) {
  const { param, value, onChange } = props;
  const label = `${param.label}${param.required ? "" : ` (${copy.routine.optional.toLowerCase()})`}`;

  if (param.type === "boolean") {
    return (
      <label className="ui-choice">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>
          {param.label}
          {param.help && <span className="ui-small ui-muted block">{param.help}</span>}
        </span>
      </label>
    );
  }

  let input: React.ReactNode;
  switch (param.type) {
    case "file":
    case "folder":
      input = <PathPicker param={param} value={value} onChange={onChange} />;
      break;
    case "select":
      input = <SelectField {...props} />;
      break;
    case "formatList":
      input = <FormatList param={param} value={value} onChange={onChange} />;
      break;
    case "number":
      input = (
        <input
          id={param.key}
          type="number"
          className="ui-input max-w-40"
          min={param.min}
          max={param.max}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
      break;
    default:
      input = (
        <input
          id={param.key}
          className="ui-input max-w-md"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <Field label={label} hint={param.help} htmlFor={param.key}>
      {input}
    </Field>
  );
}

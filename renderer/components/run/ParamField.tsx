"use client";

import type { ParamDef, ParamValue, SettingDef } from "@core/types";
import { useEffect } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { Field } from "../common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  routineId: string;
  /** Selected document (options like Figma frames depend on it). */
  documentId?: string;
  /** A routine setting (or an older param). */
  param: ParamDef | SettingDef;
  value: ParamValue | undefined;
  onChange: (value: ParamValue) => void;
}

function PathPicker({ param, value, onChange }: Omit<Props, "routineId" | "documentId"> & { param: ParamDef }) {
  const pick = async () => {
    if (param.type === "folder") {
      const folder = await doppel().pickFolder();
      if (folder) onChange(folder);
    } else {
      const extensions = param.type === "dataFile" ? ["csv", "tsv", "txt", "json", "xlsx"] : param.extensions;
      const [file] = await doppel().pickFiles({ extensions });
      if (file) onChange(file);
    }
  };
  const path = typeof value === "string" && value ? value : null;
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" onClick={pick}>{path ? copy.run.change : copy.run.choose}</Button>
      <span className={path ? "truncate" : "text-muted-foreground"} title={path ?? undefined}>
        {path ? fileName(path) : copy.run.notChosen}
      </span>
    </div>
  );
}

function SelectField({ routineId, documentId, param, value, onChange }: Props) {
  const { data: options, loading } = useAsync(
    () => doppel().getSettingOptions(routineId, param.key, documentId),
    [routineId, param.key, documentId],
  );
  // Keep the value valid: fall back to the default or the first option the app offers.
  useEffect(() => {
    if (!options?.length) return;
    if (!options.some((o) => o.value === value)) {
      onChange(options.find((o) => o.value === param.default)?.value ?? options[0].value);
    }
  }, [options, value, param.default, onChange]);
  return (
    <NativeSelect id={param.key} className="w-full max-w-md" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} disabled={loading}>
      {loading && <NativeSelectOption>{copy.run.loadingOptions}</NativeSelectOption>}
      {options?.map((o) => (
        <NativeSelectOption key={o.value} value={o.value}>
          {o.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function FormatList({ param, value, onChange }: Omit<Props, "routineId" | "documentId">) {
  const selected = Array.isArray(value) ? value : [];
  const options = param.options ?? [];
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <Button variant="link" className="h-auto p-0 text-sm" onClick={() => onChange(options.map((o) => o.value))}>
          {copy.run.selectAll}
        </Button>
        <Button variant="link" className="h-auto p-0 text-sm" onClick={() => onChange([])}>
          {copy.run.selectNone}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((o) => (
          <label key={o.value} className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
            <Checkbox className="mt-0.5" checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** One field for a setting (or an older param). */
export function ParamField(props: Props) {
  const { param, value, onChange } = props;
  const label = `${param.label}${param.required ? "" : ` (${copy.routine.optional.toLowerCase()})`}`;

  if (param.type === "boolean") {
    return (
      <label className="flex items-start gap-2 data-[disabled=true]:text-muted-foreground">
        <Checkbox className="mt-0.5" checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        <span>
          {param.label}
          {param.help && <span className="text-sm text-muted-foreground block">{param.help}</span>}
        </span>
      </label>
    );
  }

  let input: React.ReactNode;
  switch (param.type) {
    case "file":
    case "folder":
    case "dataFile":
      input = <PathPicker param={param as ParamDef} value={value} onChange={onChange} />;
      break;
    case "select":
      input = <SelectField {...props} />;
      break;
    case "formatList":
      input = <FormatList param={param} value={value} onChange={onChange} />;
      break;
    case "number":
      input = (
        <Input
          id={param.key}
          type="number"
          className="max-w-40"
          min={param.min}
          max={param.max}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
      break;
    default:
      input = (
        <Input
          id={param.key}
          className="max-w-md"
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

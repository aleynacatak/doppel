"use client";

import type { InputValue, PortDef } from "@core/types";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { fileName } from "@/lib/format";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";

const DATA_EXTENSIONS = ["csv", "tsv", "txt", "json", "xlsx"];

/** What was picked, in a few words: a file name, "6 files", a folder. */
export function describeValue(value: InputValue | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) return value.length === 1 ? fileName(value[0]) : copy.run.filesChosen(value.length);
  if (typeof value === "string" && value.startsWith("/")) return fileName(value);
  return String(value);
}

/** A picker for one flow input (or routine input): a file, files or a folder, a data file, a folder, or a value. */
export function InputValueField({ port, value, onChange, id }: { port: PortDef; value: InputValue | undefined; onChange: (v: InputValue) => void; id: string }) {
  const label = `${port.label}${port.required ? "" : ` (${copy.routine.optional.toLowerCase()})`}`;
  const pickFile = async (extensions?: string[]) => {
    const [file] = await doppel().pickFiles({ extensions });
    if (file) onChange(file);
  };
  const pickFiles = async () => {
    const files = await doppel().pickFiles({ extensions: port.extensions, multiple: true });
    if (files.length) onChange(files);
  };
  const pickFolder = async () => {
    const folder = await doppel().pickFolder();
    if (folder) onChange(folder);
  };
  const shown = describeValue(value);
  const chosen = (
    <span className={shown ? "truncate" : "ui-muted"} title={Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : undefined}>
      {port.type === "fileList" && typeof value === "string" && value ? copy.run.folderChosen(fileName(value)) : (shown ?? copy.run.notChosen)}
    </span>
  );

  let input: React.ReactNode;
  switch (port.type) {
    case "rows":
      input = (
        <div className="flex items-center gap-3">
          <Button onClick={() => pickFile(DATA_EXTENSIONS)}>{shown ? copy.run.change : copy.run.choose}</Button>
          {chosen}
        </div>
      );
      break;
    case "file":
      input = (
        <div className="flex items-center gap-3">
          <Button onClick={() => pickFile(port.extensions)}>{shown ? copy.run.change : copy.run.choose}</Button>
          {chosen}
        </div>
      );
      break;
    case "fileList":
      input = (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={pickFiles}>{copy.run.chooseFiles}</Button>
          <Button onClick={pickFolder}>{copy.run.chooseFolder}</Button>
          {chosen}
        </div>
      );
      break;
    case "folder":
      input = (
        <div className="flex items-center gap-3">
          <Button onClick={pickFolder}>{shown ? copy.run.change : copy.run.choose}</Button>
          {chosen}
        </div>
      );
      break;
    case "boolean":
      return (
        <label className="ui-choice">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{port.label}</span>
        </label>
      );
    case "number":
      input = (
        <input id={id} type="number" className="ui-input max-w-40" value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      );
      break;
    default:
      input = <input id={id} className="ui-input max-w-md" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
  const hint = [port.description, port.extensions?.length ? port.extensions.map((e) => e.toUpperCase()).join(", ") : null, port.type === "rows" && port.columns?.length ? `Columns: ${port.columns.join(", ")}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Field label={label} hint={hint || undefined} htmlFor={id}>
      {input}
    </Field>
  );
}

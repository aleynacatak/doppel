import { copy } from "@/copy";
import { Field } from "../ui/Field";

export function RequestInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={copy.newTask.requestLabel} htmlFor="request">
      <textarea
        id="request"
        className="ui-textarea"
        rows={6}
        value={value}
        placeholder={copy.newTask.requestPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
    </Field>
  );
}

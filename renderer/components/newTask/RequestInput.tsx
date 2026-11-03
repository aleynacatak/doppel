import { copy } from "@/copy";
import { Field } from "../common/Field";
import { Textarea } from "@/components/ui/textarea";

export function RequestInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={copy.newTask.requestLabel} htmlFor="request">
      <Textarea
        id="request"
        rows={6}
        value={value}
        placeholder={copy.newTask.requestPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
    </Field>
  );
}

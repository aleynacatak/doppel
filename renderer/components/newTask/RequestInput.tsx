import { copy } from "@/copy";
import { Textarea } from "@/components/ui/textarea";

export function RequestInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Textarea
      id="request"
      className="min-h-32"
      aria-label={copy.newTask.requestLabel}
      value={value}
      placeholder={copy.newTask.requestPlaceholder}
      onChange={(e) => onChange(e.target.value)}
      autoFocus
    />
  );
}

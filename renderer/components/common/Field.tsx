import type { ReactNode } from "react";
import { FieldDescription, FieldLabel, Field as UiField } from "@/components/ui/field";

export function Field({ label, hint, htmlFor, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <UiField>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {/* shadcn's Field stretches its direct children; this lets a short input keep its own width. */}
      <div>{children}</div>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </UiField>
  );
}

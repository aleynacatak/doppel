import type { ReactNode } from "react";

export function Field({ label, hint, htmlFor, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="ui-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="ui-small ui-muted">{hint}</p>}
    </div>
  );
}

export function ProgressBar({ value, label }: { value?: number; label?: string }) {
  const indeterminate = value === undefined;
  return (
    <div
      className="ui-progress"
      data-indeterminate={indeterminate}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}
    >
      <div style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="ui-spinner" role="status" aria-label={label ?? "Loading"} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="ui-muted flex items-center gap-2 py-8">
      <Spinner label={label} /> {label}
    </div>
  );
}

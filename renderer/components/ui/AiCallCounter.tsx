/** The prominent AI-call count: creation uses calls, reruns stay at 0. */
export function AiCallCounter({ count, label, hint }: { count: number; label: string; hint?: string }) {
  return (
    <div className="ui-card flex items-center gap-4 px-4 py-3" aria-live="polite">
      <div className="ui-big-number">{count}</div>
      <div className="flex flex-col">
        <div className="ui-h3">{label}</div>
        {hint && <div className="ui-small ui-muted">{hint}</div>}
      </div>
    </div>
  );
}

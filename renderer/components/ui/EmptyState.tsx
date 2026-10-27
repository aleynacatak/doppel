import type { ReactNode } from "react";

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-card ui-surface flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="ui-h2">{title}</div>
      {body && <p className="ui-muted max-w-md">{body}</p>}
      {action}
    </div>
  );
}

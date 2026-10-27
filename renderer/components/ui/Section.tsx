import type { ReactNode } from "react";

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="ui-h2">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

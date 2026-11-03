import type { ReactNode } from "react";

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-medium">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

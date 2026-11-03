import type { ReactNode } from "react";

export function OutputGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-6">{children}</div>;
}

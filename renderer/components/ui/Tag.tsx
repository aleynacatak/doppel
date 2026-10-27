import type { ReactNode } from "react";

/** Small status label. Tone only changes emphasis (wireframe: no colors). */
export function Tag({ children, tone = "default", title }: { children: ReactNode; tone?: "default" | "strong" | "filled" | "quiet"; title?: string }) {
  return (
    <span className="ui-tag" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

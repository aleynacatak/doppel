import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

const VARIANTS = { default: "outline", strong: "secondary", filled: "default", quiet: "outline" } as const;

/** Small status label. Tone only changes emphasis. */
export function Tag({ children, tone = "default", title }: { children: ReactNode; tone?: keyof typeof VARIANTS; title?: string }) {
  return (
    <Badge variant={VARIANTS[tone]} className={tone === "quiet" ? "border-dashed" : undefined} title={title}>
      {children}
    </Badge>
  );
}

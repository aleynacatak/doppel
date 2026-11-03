import { cn } from "cn";
import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** A titled group in its own card. `plain` keeps only the heading, for content that is already cards. */
export function Section({ title, aside, plain, className, children }: { title: ReactNode; aside?: ReactNode; plain?: boolean; className?: string; children: ReactNode }) {
  if (plain) {
    return (
      <section className={cn("flex min-w-0 flex-col gap-4", className)}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-heading text-lg font-medium">{title}</h2>
          {aside}
        </div>
        {children}
      </section>
    );
  }
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        {aside && <CardAction>{aside}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

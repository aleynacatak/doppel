import { Card, CardContent } from "@/components/ui/card";
/** The prominent AI-call count: creation uses calls, reruns stay at 0. */
export function AiCallCounter({ count, label, hint }: { count: number; label: string; hint?: string }) {
  return (
    <Card aria-live="polite" size="sm">
      <CardContent className="flex items-center gap-4">
        <div className="text-3xl font-semibold tabular-nums leading-none">{count}</div>
        <div className="flex flex-col">
          <div className="text-sm font-medium">{label}</div>
          {hint && <div className="text-sm text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

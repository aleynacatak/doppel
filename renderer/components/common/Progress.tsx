import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner as UiSpinner } from "@/components/ui/spinner";

export function ProgressBar({ value, label }: { value?: number; label?: string }) {
  // No known share yet: a pulsing bar.
  if (value === undefined) return <Skeleton className="h-1 w-full" role="progressbar" aria-label={label} />;
  return <Progress value={Math.round(value * 100)} aria-label={label} />;
}

export function Spinner({ label }: { label?: string }) {
  return <UiSpinner aria-label={label ?? "Loading"} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-8">
      <Spinner label={label} /> {label}
    </div>
  );
}

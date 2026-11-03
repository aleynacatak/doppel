import type { QcCheck, QcLevel } from "@core/types";
import { copy } from "@/copy";

const LEVELS: QcLevel[] = ["rule", "object", "visual"];

/** All checks of one output, grouped by level: Rule / Object / Visual. */
export function QcChecks({ checks }: { checks: QcCheck[] }) {
  return (
    <div className="flex flex-col gap-3">
      {LEVELS.filter((level) => checks.some((c) => c.level === level)).map((level) => (
        <div key={level} className="flex flex-col gap-1.5">
          <div className="text-sm font-medium">{copy.results.levels[level]}</div>
          <ul className="flex flex-col gap-1">
            {checks
              .filter((c) => c.level === level)
              .map((c) => (
                <li key={c.label} className="text-sm flex gap-2">
                  <span aria-hidden className="w-3 shrink-0">{c.skipped ? "–" : c.passed ? "✓" : "×"}</span>
                  <span>
                    <span className={c.passed ? "text-muted-foreground" : undefined}>{c.label}</span>
                    {c.skipped && <span className="text-muted-foreground"> · {copy.results.notChecked}</span>}
                    {c.reason && <span className={c.skipped ? "text-muted-foreground block" : "block"}>{c.reason}</span>}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

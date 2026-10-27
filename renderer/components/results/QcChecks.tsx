import type { QcCheck, QcLevel } from "@core/types";
import { copy } from "@/copy";

const LEVELS: QcLevel[] = ["rule", "object", "visual"];

/** All checks of one output, grouped by level: Rule / Object / Visual. */
export function QcChecks({ checks }: { checks: QcCheck[] }) {
  return (
    <div className="flex flex-col gap-2">
      {LEVELS.filter((level) => checks.some((c) => c.level === level)).map((level) => (
        <div key={level} className="flex flex-col gap-1">
          <div className="ui-label">{copy.results.levels[level]}</div>
          <ul className="flex flex-col gap-0.5">
            {checks
              .filter((c) => c.level === level)
              .map((c) => (
                <li key={c.label} className="ui-small flex gap-2">
                  <span aria-hidden className="w-3 shrink-0">{c.passed ? "✓" : "×"}</span>
                  <span>
                    <span className={c.passed ? "ui-muted" : undefined}>{c.label}</span>
                    {c.reason && <span className="block">{c.reason}</span>}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

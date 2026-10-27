import type { RoutineVersion } from "@core/types";
import { copy } from "@/copy";
import { formatDate } from "@/lib/format";

export function VersionHistory({ versions }: { versions: RoutineVersion[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {[...versions].reverse().map((v) => (
        <li key={v.version} className="flex flex-wrap gap-x-3">
          <span className="ui-h3">{copy.common.version(v.version)}</span>
          <span className="ui-muted">{formatDate(v.createdAt)}</span>
          <span className="ui-muted">{copy.plural(v.aiCalls, "AI call")}</span>
          <span className="ui-muted">{v.note}</span>
        </li>
      ))}
    </ul>
  );
}

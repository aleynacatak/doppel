import type { StyleSource } from "@core/types";
import { copy } from "@/copy";
import { formatDate } from "@/lib/format";
import { Button } from "../ui/Button";

export function StyleSources({ sources, onRemove }: { sources: StyleSource[]; onRemove: (id: string) => void }) {
  if (sources.length === 0) return <p className="ui-muted">{copy.style.noSources}</p>;
  return (
    <ul className="ui-card flex flex-col">
      {sources.map((s) => (
        <li key={s.id} className="ui-divider flex items-center justify-between gap-3 px-3 py-2 first:border-t-0">
          <span className="truncate" title={s.path}>
            {s.name}
          </span>
          <span className="flex items-center gap-3">
            <span className="ui-small ui-muted">{formatDate(s.addedAt)}</span>
            <Button variant="ghost" size="small" onClick={() => onRemove(s.id)}>
              {copy.style.remove}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

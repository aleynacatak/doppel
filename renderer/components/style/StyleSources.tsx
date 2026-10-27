import type { StyleSource } from "@core/types";
import { copy } from "@/copy";
import { formatDate } from "@/lib/format";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";

export function StyleSources({ sources, onRemove }: { sources: StyleSource[]; onRemove: (id: string) => void }) {
  if (sources.length === 0) return <p className="ui-muted">{copy.style.noSources}</p>;
  return (
    <ul className="ui-card flex flex-col">
      {sources.map((s) => (
        <li key={s.id} className="ui-divider flex flex-col gap-1 px-3 py-2 first:border-t-0">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <Tag>{s.kind === "figma" ? "Figma" : "InDesign"}</Tag>
              <span className="truncate" title={s.path}>
                {s.name}
              </span>
            </span>
            <span className="flex items-center gap-3">
              <span className="ui-small ui-muted">{formatDate(s.addedAt)}</span>
              <Button variant="ghost" size="small" onClick={() => onRemove(s.id)}>
                {copy.style.remove}
              </Button>
            </span>
          </div>
          {s.error && (
            <p className="ui-small">
              {copy.style.readFailed}: {s.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

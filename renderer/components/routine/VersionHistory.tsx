import type { RoutineVersion } from "@core/types";
import Link from "next/link";
import { copy } from "@/copy";
import { formatDate } from "@/lib/format";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";

/** Every version, newest first: date, what changed, AI calls; earlier ones open read-only and can be restored. */
export function VersionHistory({
  routineId,
  versions,
  current,
  viewing,
  onRestore,
}: {
  routineId?: string;
  versions: RoutineVersion[];
  current?: number;
  /** The version shown read-only right now. */
  viewing?: number;
  onRestore?: (version: number) => void;
}) {
  return (
    <table className="ui-table">
      <tbody>
        {[...versions].reverse().map((v) => (
          <tr key={v.version} data-selected={viewing === v.version}>
            <td className="py-2 pr-4 whitespace-nowrap">
              <span className="ui-h3">{copy.common.version(v.version)}</span>
            </td>
            <td className="ui-muted py-2 pr-4 whitespace-nowrap">{formatDate(v.createdAt)}</td>
            <td className="py-2 pr-4">
              <div>{v.note}</div>
              {v.request && <div className="ui-small ui-muted">“{v.request}”</div>}
            </td>
            <td className="ui-muted py-2 pr-4 whitespace-nowrap">{copy.plural(v.aiCalls, "AI call")}</td>
            <td className="py-2 whitespace-nowrap">
              {current === v.version ? (
                <Tag>{copy.versions.current}</Tag>
              ) : routineId ? (
                <span className="flex gap-2">
                  <Link href={`/routine?id=${routineId}&version=${v.version}`} className="ui-small ui-link">
                    {copy.versions.open}
                  </Link>
                  {onRestore && (
                    <Button size="small" onClick={() => onRestore(v.version)}>
                      {copy.versions.restore}
                    </Button>
                  )}
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

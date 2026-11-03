import type { RoutineVersion } from "@core/types";
import Link from "next/link";
import { copy } from "@/copy";
import { formatDate } from "@/lib/format";
import { Tag } from "../common/Tag";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

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
    <Table>
      <TableBody>
        {[...versions].reverse().map((v) => (
          <TableRow key={v.version} data-selected={viewing === v.version}>
            <TableCell className="py-3 pr-4 whitespace-nowrap">
              <span className="text-sm font-medium">{copy.common.version(v.version)}</span>
            </TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4 whitespace-nowrap">{formatDate(v.createdAt)}</TableCell>
            <TableCell className="py-3 pr-4">
              <div>{v.note}</div>
              {v.request && <div className="text-sm text-muted-foreground">“{v.request}”</div>}
            </TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4 whitespace-nowrap">{copy.plural(v.aiCalls, "AI call")}</TableCell>
            <TableCell className="py-3 whitespace-nowrap">
              {current === v.version ? (
                <Tag>{copy.versions.current}</Tag>
              ) : routineId ? (
                <span className="flex gap-2">
                  <Link href={`/routine?id=${routineId}&version=${v.version}`} className="text-sm text-primary underline-offset-4 hover:underline">
                    {copy.versions.open}
                  </Link>
                  {onRestore && (
                    <Button variant="outline" size="sm" onClick={() => onRestore(v.version)}>
                      {copy.versions.restore}
                    </Button>
                  )}
                </span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

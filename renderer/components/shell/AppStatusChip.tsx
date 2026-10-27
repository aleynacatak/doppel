import type { App } from "@core/types";
import Link from "next/link";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";

export function AppStatusChip({ app }: { app: App }) {
  const connected = app.status === "connected";
  return (
    <Link href="/connect" className="ui-nav-link flex items-center gap-2 px-2 py-1" title={copy.appStatus[app.status]}>
      <span className="ui-dot" data-on={connected} aria-hidden />
      <span className="flex-1">{appLabel(app.id)}</span>
      <span className="ui-small ui-muted">
        {connected ? (app.version ?? copy.appStatus.connected) : app.status === "awaiting-permission" ? copy.appStatusShort.awaiting : copy.appStatus[app.status]}
      </span>
    </Link>
  );
}

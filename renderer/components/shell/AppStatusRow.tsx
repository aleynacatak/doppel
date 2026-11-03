import type { App } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { AppLogo } from "../common/AppLogo";

/** An app's logo and name, with its status on the right. */
export function AppStatusRow({ app }: { app: App }) {
  const connected = app.status === "connected";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AppLogo appId={app.id} />
      <span className="min-w-0 flex-1 truncate">{appLabel(app.id)}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-2 shrink-0 rounded-full border border-primary data-[on=true]:bg-primary" data-on={connected} />
        {connected ? (app.version ?? copy.appStatus.connected) : app.status === "awaiting-permission" ? copy.appStatusShort.awaiting : copy.appStatus[app.status]}
      </span>
    </div>
  );
}

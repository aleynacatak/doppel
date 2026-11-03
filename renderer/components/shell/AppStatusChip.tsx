import type { App } from "@core/types";
import Link from "next/link";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";

export function AppStatusChip({ app }: { app: App }) {
  const connected = app.status === "connected";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<Link href="/connect" />}>
        <span className="size-2 shrink-0 rounded-full border border-primary data-[on=true]:bg-primary" data-on={connected} />
        <span>{appLabel(app.id)}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge className="font-normal text-muted-foreground peer-data-[size=default]/menu-button:top-2">
        {connected ? (app.version ?? copy.appStatus.connected) : app.status === "awaiting-permission" ? copy.appStatusShort.awaiting : copy.appStatus[app.status]}
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

"use client";

import { IconLayoutGrid, IconPlus, IconSettings } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { copy } from "@/copy";
import { useShell } from "@/lib/store";
import { AppStatusChip } from "./AppStatusChip";

const NAV = [
  { href: "/", label: copy.nav.newTask, icon: IconPlus, match: ["/", "/create"] },
  { href: "/routines", label: copy.nav.library, icon: IconLayoutGrid, match: ["/routines", "/routine", "/flow", "/run", "/results"] },
  { href: "/settings", label: copy.nav.settings, icon: IconSettings, match: ["/settings"] },
];

export function AppSidebar() {
  const pathname = usePathname();
  const apps = useShell((s) => s.apps);
  return (
    <Sidebar collapsible="none" className="border-r">
      <SidebarHeader>
        <div className="px-2 py-1.5 font-heading text-base font-semibold">{copy.appName}</div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => {
                  const active = item.match.includes(pathname);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton isActive={active} render={<Link href={item.href} aria-current={active ? "page" : undefined} />}>
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel>{copy.nav.apps}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {apps.map((app) => (
                <AppStatusChip key={app.id} app={app} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

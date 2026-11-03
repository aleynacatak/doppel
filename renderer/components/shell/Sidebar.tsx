"use client";

import { IconLayoutGrid, IconPlus, IconSettings } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { copy } from "@/copy";
import { useShell } from "@/lib/store";
import { ButtonLink } from "../common/ButtonLink";
import { Spinner } from "../common/Progress";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppStatusRow } from "./AppStatusRow";

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
          <Card size="sm">
            <CardHeader className="items-center">
              <CardTitle>{copy.nav.apps}</CardTitle>
              <CardAction>
                <ButtonLink href="/connect" variant="link" size="sm" className="h-auto p-0">
                  {copy.nav.viewApps}
                </ButtonLink>
              </CardAction>
            </CardHeader>
            <CardContent>
              {apps.length === 0 && <Spinner />}
              <ul className="flex flex-col gap-3">
                {apps.slice(0, 3).map((app) => (
                  <li key={app.id}>
                    <AppStatusRow app={app} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

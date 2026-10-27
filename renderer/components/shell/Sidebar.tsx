"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { copy } from "@/copy";
import { useShell } from "@/lib/store";
import { AppStatusChip } from "./AppStatusChip";

const NAV = [
  { href: "/", label: copy.nav.newTask, match: ["/", "/create"] },
  { href: "/routines", label: copy.nav.library, match: ["/routines", "/routine", "/run", "/results"] },
  { href: "/style", label: copy.nav.style, match: ["/style"] },
  { href: "/settings", label: copy.nav.settings, match: ["/settings"] },
];

export function Sidebar() {
  const pathname = usePathname();
  const apps = useShell((s) => s.apps);
  return (
    <nav className="ui-sidebar flex w-56 shrink-0 flex-col justify-between p-3" aria-label="Main">
      <div className="flex flex-col gap-4">
        <div className="ui-h2 px-2 pt-1">{copy.appName}</div>
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="ui-nav-link px-2 py-1.5"
                aria-current={item.match.includes(pathname) ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <div className="ui-label px-2">{copy.nav.apps}</div>
        <ul className="flex flex-col gap-1">
          {apps.map((app) => (
            <li key={app.id}>
              <AppStatusChip app={app} />
            </li>
          ))}
        </ul>
        <div className="ui-small ui-muted px-2 pt-2">{copy.nav.devHint}</div>
      </div>
    </nav>
  );
}

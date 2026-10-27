"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { copy } from "@/copy";
import { doppel, hasBridge } from "@/lib/doppel";
import { useShell } from "@/lib/store";
import { Loading } from "../ui/Progress";
import { Notice } from "../ui/Notice";
import { DevPanel } from "./DevPanel";
import { Sidebar } from "./Sidebar";

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Sidebar + content + dev panel. Loads apps/settings once and keeps app status live. */
export function AppShell({ children }: { children: ReactNode }) {
  const { ready, bridgeMissing, settings, devPanelOpen, setBoot, setBridgeMissing, setApps, toggleDevPanel } = useShell();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!hasBridge()) {
      setBridgeMissing();
      return;
    }
    const api = doppel();
    Promise.all([api.listApps(), api.getSettings(), api.getDevFlags(), api.getAiAccess()]).then(([apps, settings, devFlags, aiAccess]) =>
      setBoot({ apps, settings, devFlags, aiAccess }),
    );
    return api.onAppStatusChange(setApps);
  }, [setBoot, setBridgeMissing, setApps]);

  // First launch: Connect apps.
  useEffect(() => {
    if (settings && !settings.onboarded && pathname !== "/connect") router.replace("/connect");
  }, [settings, pathname, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "d" && !isTyping(e.target)) {
        e.preventDefault();
        toggleDevPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDevPanel]);

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          {!ready ? (
            <Loading />
          ) : bridgeMissing ? (
            <Notice tone="warning" title={copy.common.bridgeMissingTitle}>
              {copy.common.bridgeMissingBody}
            </Notice>
          ) : (
            children
          )}
        </div>
      </main>
      {devPanelOpen && !bridgeMissing && <DevPanel />}
    </div>
  );
}

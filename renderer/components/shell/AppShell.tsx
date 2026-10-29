"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { copy } from "@/copy";
import { doppel, hasBridge } from "@/lib/doppel";
import { useShell } from "@/lib/store";
import { Loading } from "../ui/Progress";
import { Notice } from "../ui/Notice";
import { Sidebar } from "./Sidebar";

/** Sidebar + content. Loads apps/settings once and keeps app status live. */
export function AppShell({ children }: { children: ReactNode }) {
  const { ready, bridgeMissing, settings, setBoot, setBridgeMissing, setApps } = useShell();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!hasBridge()) {
      setBridgeMissing();
      return;
    }
    const api = doppel();
    // Subscribe first, so a status change that lands while loading isn't lost.
    const unsubscribe = api.onAppStatusChange(setApps);
    api.listApps().then(setApps);
    Promise.all([api.getSettings(), api.getAiAccess()]).then(([settings, aiAccess]) => setBoot({ settings, aiAccess }));
    return unsubscribe;
  }, [setBoot, setBridgeMissing, setApps]);

  // Hidden dev panel: Cmd+Shift+D.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        router.push("/dev");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // First launch: Connect apps.
  useEffect(() => {
    if (settings && !settings.onboarded && pathname !== "/connect") router.replace("/connect");
  }, [settings, pathname, router]);

  // The flow editor uses the whole window.
  const wide = pathname === "/flow";
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={wide ? "px-6 py-6" : "mx-auto max-w-5xl px-8 py-8"}>
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
    </div>
  );
}

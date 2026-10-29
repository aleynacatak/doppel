import type { AppId } from "@core/types";

const APP_NAMES: Record<string, string> = { indesign: "InDesign", figma: "Figma", photoshop: "Photoshop" };

/** Short app name for badges ("InDesign" rather than "Adobe InDesign"). */
export const appLabel = (appId: AppId) => APP_NAMES[appId] ?? appId;

/** Every app a flow's routines use (filled in when flows are listed). */
export const flowApps = (f: { appIds?: AppId[] }): AppId[] => f.appIds ?? [];

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatDate = (iso: string) => dateFormat.format(new Date(iso));

/** Calendar dates stored as UTC (e.g. access code expiry "2026-11-20T23:59:59Z") shown as that same day. */
const utcDateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const formatDateUtc = (iso: string) => utcDateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

/** "just now", "5 min ago", "3 days ago", or a date. */
export function formatRelative(iso: string | undefined, now = Date.now()) {
  if (!iso) return "";
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return formatDate(iso);
}

export const fileName = (p: string) => p.split("/").pop() || p;

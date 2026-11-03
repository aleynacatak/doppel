import type { AppId } from "@core/types";
import { IconApps, IconBrandAdobeIndesign, IconBrandAdobePhotoshop, IconBrandFigma } from "@tabler/icons-react";
import { cn } from "cn";
import { appLabel } from "@/lib/format";
import { useShell } from "@/lib/store";
import { Tag } from "./Tag";

const MARKS: Record<string, typeof IconApps> = { indesign: IconBrandAdobeIndesign, photoshop: IconBrandAdobePhotoshop, figma: IconBrandFigma };

/** An app's logo as installed on this Mac; a one-colour mark until it loads, or if the app isn't installed. */
export function AppLogo({ appId, className }: { appId: AppId; className?: string }) {
  const src = useShell((s) => s.appIcons[appId]);
  const Mark = MARKS[appId] ?? IconApps;
  const size = cn("size-5 shrink-0", className);
  return src ? <img src={src} alt="" className={size} /> : <Mark aria-hidden className={size} />;
}

/** The app of a routine or a step: logo and name. */
export function AppTag({ appId, tone = "strong" }: { appId: AppId; tone?: "default" | "strong" }) {
  return (
    <Tag tone={tone}>
      <AppLogo appId={appId} className="size-3.5" />
      {appLabel(appId)}
    </Tag>
  );
}

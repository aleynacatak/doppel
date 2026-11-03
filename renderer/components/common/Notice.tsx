import { IconAlertCircle, IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const ICONS = { info: IconInfoCircle, warning: IconAlertTriangle, error: IconAlertCircle };

export function Notice({
  tone = "info",
  title,
  children,
  actions,
}: {
  tone?: "info" | "warning" | "error";
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const Icon = ICONS[tone];
  return (
    <Alert variant={tone === "error" ? "destructive" : "default"} role={tone === "error" ? "alert" : "status"}>
      <Icon aria-hidden />
      {title && <AlertTitle>{title}</AlertTitle>}
      {children && <AlertDescription className="flex flex-col gap-1.5">{children}</AlertDescription>}
      {actions && <div className="col-start-2 flex flex-wrap gap-2 pt-1">{actions}</div>}
    </Alert>
  );
}

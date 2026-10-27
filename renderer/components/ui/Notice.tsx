import type { ReactNode } from "react";

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
  return (
    <div className="ui-notice flex flex-col gap-2 p-3" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      {title && <div className="ui-h3">{title}</div>}
      {children && <div className="flex flex-col gap-1">{children}</div>}
      {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
    </div>
  );
}

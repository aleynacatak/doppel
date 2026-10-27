import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  tags,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  tags?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2 pb-6">
      {back && (
        <Link href={back.href} className="ui-small ui-muted ui-link">
          ← {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="ui-h1">{title}</h1>
            {tags}
          </div>
          {subtitle && <p className="ui-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

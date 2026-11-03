import { IconArrowLeft } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { ButtonLink } from "./ButtonLink";

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
    <header className="flex flex-col gap-3 pb-2">
      {back && (
        <ButtonLink href={back.href} variant="ghost" size="sm" className="-ml-3 w-fit text-muted-foreground">
          <IconArrowLeft />
          {back.label}
        </ButtonLink>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-semibold">{title}</h1>
            {tags}
          </div>
          {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

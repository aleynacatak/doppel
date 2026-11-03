import type { VariantProps } from "class-variance-authority";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";

/** A link that looks like a button. */
export function ButtonLink({
  href,
  variant = "outline",
  size,
  className,
  children,
}: VariantProps<typeof buttonVariants> & { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonVariants({ variant, size, className })}>
      {children}
    </Link>
  );
}

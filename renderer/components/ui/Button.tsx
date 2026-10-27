import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "normal" | "small";
}

export function Button({ variant = "secondary", size = "normal", type = "button", className = "", ...rest }: ButtonProps) {
  return <button type={type} data-variant={variant} data-size={size} className={`ui-button ${className}`} {...rest} />;
}

export function ButtonLink({
  href,
  variant = "secondary",
  size = "normal",
  children,
}: {
  href: string;
  variant?: Variant;
  size?: "normal" | "small";
  children: ReactNode;
}) {
  return (
    <Link href={href} data-variant={variant} data-size={size} className="ui-button">
      {children}
    </Link>
  );
}

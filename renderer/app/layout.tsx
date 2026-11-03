import type { Metadata } from "next";
import { AppShell } from "@/components/shell/AppShell";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "Doppl",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="antialiased">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

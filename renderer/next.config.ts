import path from "node:path";
import type { NextConfig } from "next";

// Static export: Electron serves renderer/out through the app:// protocol in production.
// IDs created at runtime travel in query parameters (/routine?id=…), never in dynamic segments.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  devIndicators: false,
  // The repo root (one package.json for Electron and Next).
  outputFileTracingRoot: path.join(__dirname, ".."),
  // Pure code shared with the main process (port types, flow graph): electron/shared/.
  experimental: { externalDir: true },
};

export default nextConfig;

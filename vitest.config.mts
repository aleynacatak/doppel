import { defineConfig } from "vitest/config";

// Unit tests for the main process, the shared Figma action code and the plugin interpreter.
// The Cloudflare Worker has its own tests in worker/.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});

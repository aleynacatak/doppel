import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A colour named after a variable that no longer exists draws nothing and raises no error: flow connectors vanished
// that way when the theme moved to shadcn.

const RENDERER = path.join(__dirname, "..", "renderer");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "out", ".next"].includes(entry.name) ? [] : sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

describe("renderer CSS variables", () => {
  it("only uses variables something defines", () => {
    const files = sourceFiles(RENDERER).map((file) => fs.readFileSync(file, "utf8"));
    const defined = new Set(files.flatMap((text) => [...text.matchAll(/(?:^|[\s;{"'[])(--[\w-]+)["']?\s*:/gm)].map((m) => m[1])));
    const used = new Set(files.flatMap((text) => [...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])));
    const missing = [...used].filter((name) => !defined.has(name) && !name.startsWith("--xy-"));
    expect(missing).toEqual([]);
  });
});

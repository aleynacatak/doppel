// Builds the Doppl Figma plugin: figma-plugin/src → figma-plugin/dist (code.js and ui.html with the script inlined).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "figma-plugin");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

// Figma runs plugin code in its own sandbox; ES2020 keeps zod's BigInt support while lowering newer syntax.
const common = { bundle: true, minify: true, target: "es2020", logLevel: "warning", legalComments: "none" };

await build({ ...common, entryPoints: [path.join(root, "src", "code.ts")], outfile: path.join(dist, "code.js"), format: "iife" });

const ui = await build({ ...common, entryPoints: [path.join(root, "src", "ui.ts")], write: false, format: "iife" });
const html = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace("<!--SCRIPT-->", () => `<script>${ui.outputFiles[0].text}</script>`);
fs.writeFileSync(path.join(dist, "ui.html"), html);
console.log("figma-plugin: built dist/code.js and dist/ui.html");

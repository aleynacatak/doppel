// Writes dist-electron/build-config.json: settings baked into the app at build time.
//   DOPPL_API_BASE_URL=https://api.example.com npm run dist
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = { apiBaseUrl: (process.env.DOPPL_API_BASE_URL || "https://api.doppl.work").replace(/\/$/, "") };
fs.mkdirSync(path.join(root, "dist-electron"), { recursive: true });
fs.writeFileSync(path.join(root, "dist-electron", "build-config.json"), JSON.stringify(config, null, 2));
console.log(`build-config: Worker URL ${config.apiBaseUrl}`);

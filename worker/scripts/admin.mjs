#!/usr/bin/env node
// Admin commands for the demo Worker. Reads DOPPL_API_URL and ADMIN_TOKEN from worker/.env (git-ignored).
//
//   npm run codes:create -- --label judges --creations 20 --sam 500 --expires 2026-11-20
//   npm run codes:list
//   npm run codes:revoke -- <id>
//   npm run spend
//   npm run demo:pause / npm run demo:resume
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const file = path.join(root, ".env");
  const vars = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...vars, ...process.env };
}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) out[args[i].slice(2)] = args[i + 1]?.startsWith("--") ? true : args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (typeof fetch !== "function") fail(`This script needs Node 22 or newer (you have ${process.version}). Run: nvm use 22`);

const env = loadEnv();
const base = (env.DOPPL_API_URL || "https://api.doppl.work").replace(/\/$/, "");
if (!env.ADMIN_TOKEN) fail("ADMIN_TOKEN is missing. Put it in worker/.env (see .env.example).");

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    fail(`Couldn't reach ${base}: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${res.status} ${data.error?.code ?? ""}: ${data.error?.message ?? "request failed"}`);
  return data;
}

const usd = (n) => `$${Number(n).toFixed(2)}`;
const [command, ...rest] = process.argv.slice(2);
const f = flags(rest);

switch (command) {
  case "create": {
    if (!f.label || !f.creations || !f.expires) {
      fail("Usage: npm run codes:create -- --label judges --creations 20 --sam 500 --expires 2026-11-20");
    }
    const c = await api("POST", "/admin/codes", {
      label: f.label,
      maxCreations: Number(f.creations),
      maxSamImages: Number(f.sam ?? 0),
      expiresAt: f.expires,
    });
    console.log(`\n  Access code for "${c.label}" (shown only once, copy it now):\n\n      ${c.code}\n`);
    console.log(`  ${c.maxCreations} routine creations · ${c.maxSamImages} SAM images · expires ${c.expiresAt.slice(0, 10)}`);
    console.log(`  id: ${c.id}\n`);
    break;
  }
  case "list": {
    const { codes } = await api("GET", "/admin/codes");
    if (codes.length === 0) console.log("\n  No access codes yet.\n");
    for (const c of codes) {
      const state = c.revoked ? "revoked" : c.expiresAt < new Date().toISOString() ? "expired" : "active";
      console.log(
        `\n  ${c.label}  [${state}]  id ${c.id}\n    creations ${c.creations.used}/${c.creations.max} · SAM images ${c.samImages.used}/${c.samImages.max} · ${usd(c.estCostUsd)} · expires ${c.expiresAt.slice(0, 10)} · last used ${c.lastUsedAt ?? "never"}`,
      );
    }
    console.log("");
    break;
  }
  case "revoke": {
    const id = f._[0];
    if (!id) fail("Usage: npm run codes:revoke -- <id>   (ids are shown by npm run codes:list)");
    const r = await api("POST", `/admin/codes/${id}/revoke`);
    console.log(`\n  Revoked "${r.label}" (${r.id}).\n`);
    break;
  }
  case "spend": {
    const s = await api("GET", "/admin/spend");
    console.log(`\n  Estimated spend: today ${usd(s.today)} of ${usd(s.caps.daily)} · total ${usd(s.total)} of ${usd(s.caps.total)}`);
    console.log(`  Demo is ${s.demoEnabled ? "running" : "PAUSED"}`);
    for (const d of s.last7Days) console.log(`    ${d.day}  ${usd(d.estCostUsd)}`);
    console.log("");
    break;
  }
  case "pause":
  case "resume": {
    const r = await api("POST", `/admin/${command}`);
    console.log(`\n  Demo is now ${r.demoEnabled ? "running" : "PAUSED"}.\n`);
    break;
  }
  default:
    fail("Commands: create, list, revoke <id>, spend, pause, resume");
}

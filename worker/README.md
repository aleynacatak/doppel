# Doppl demo access Worker

Lets judges and testers create routines in the Doppl desktop app without their own Meta API key. Your key stays secret and your spend stays capped.

```
Doppl app ──access code──▶ api.doppl.work (this Worker) ──your Meta key──▶ Meta Model API
```

- Testers enter an **access code** in Doppl → Settings → AI access.
- The app sends AI requests here with that code. The Worker checks the code and its limits, forwards the request to Meta with **your key** (a Worker secret, never in the app), records usage and returns the answer.
- Reruns of saved routines never call the Worker. They work with no code and no network.

## Set it up (step by step)

You need: Node 22 (`nvm use 22`), your Cloudflare account (with `doppl.work` on it) and your Meta Model API key. Run everything from this `worker` folder.

### 1. Install and log in to Cloudflare

```bash
cd worker
npm install --legacy-peer-deps
npx wrangler login
```

`wrangler login` opens your browser to approve access to your Cloudflare account.

### 2. Create the database and set up its tables

```bash
npx wrangler d1 create doppl-demo
```

It prints a `database_id`. Paste it into `wrangler.toml`, replacing `00000000-0000-0000-0000-000000000000`, then commit that change; a Git-connected Worker builds from what's on GitHub. The ID isn't a secret. Then create the tables:

```bash
npm run db:migrate:remote
```

`npm run deploy` also applies any new migrations before every deploy, so later schema changes need no extra step.

### 3. Set the two secrets

Make a long random admin token and keep it somewhere safe (a password manager):

```bash
openssl rand -hex 32
```

Then set both secrets. Each command asks you to paste the value. If it asks to create the Worker first, answer yes.

```bash
npx wrangler secret put META_API_KEY
npx wrangler secret put ADMIN_TOKEN
```

Or in the dashboard: Workers & Pages → doppl → Settings → Variables and Secrets → Add, with type **Secret**. Secrets live only in Cloudflare. They're never in the repo or the app, and they stay in place across deploys.

### 4. Deploy and attach `api.doppl.work`

**With the GitHub repo connected to the Worker (Workers Builds).** Every push to the production branch deploys. In Workers & Pages → doppl → Settings → Build, check these settings:

| Setting | Value |
| --- | --- |
| Worker name | `doppl`. It must match `name` in `wrangler.toml`, or the build fails. |
| Production branch | `main` |
| Root directory | `worker` (the repo root is the desktop app) |
| Build command | leave empty |
| Deploy command | `npm run deploy` (applies migrations, then deploys) |
| Non-production branch deploy command | `npx wrangler versions upload` (the default) |
| Build watch paths | include `worker/*`, so desktop-app commits don't redeploy the Worker |

Node 22 comes from `worker/.node-version`, and `worker/.npmrc` makes `npm ci` behave like local installs.

If a build log says "Detected Project Settings … Framework: Next.js", Cloudflare is building from the repo root (the desktop app): set **Root directory** to `worker`. If the build log shows a permissions error at the migrations step, run `npm run db:migrate:remote` once from your Mac and set the deploy command to `npx wrangler deploy`.

**Or from your Mac:**

```bash
npm run deploy
```

`wrangler.toml` already declares `api.doppl.work` as a custom domain, so the deploy creates the DNS record and certificate. This can take a minute or two. If a Git build can't attach the domain, add it once in the dashboard: doppl → Settings → Domains & Routes → Add → Custom domain → `api.doppl.work`. Check it:

```bash
curl https://api.doppl.work/health
```

Expected answer: `{"ok":true,"demoEnabled":true}`.

### 5. Create a code for the judges

First, save your admin token on your Mac (once):

```bash
npm run admin:setup
```

It asks you to paste the admin token (what you paste isn't shown), checks it with the live Worker, and saves it in `worker/.env`. That file is git-ignored; `.env.example` shows its format. Then:

```bash
npm run codes:create -- --label judges --creations 20 --sam 500 --expires 2026-11-20
```

It prints a code like `DOPPL-7KQ2-…` **once**; copy it. Only its hash is stored. One "creation" is one routine being created or repaired in Doppl, however many model calls it needs (up to the demo's calls per creation, `maxCallsPerCreation` in `electron/ai/models.json`). `--sam` is the number of images the code may send to SAM 3.1 for object checks.

Other commands:

```bash
npm run codes:list
npm run codes:revoke -- <id>
npm run spend
```

`codes:list` shows usage and estimated cost per code (never the codes themselves). `codes:revoke` takes an id from `codes:list`. `spend` shows today, the last 7 days and the total.

### 6. Watch spend and pause the demo

- `npm run spend` shows estimated spend against the caps (`DAILY_SPEND_CAP`, `TOTAL_SPEND_CAP` in `wrangler.toml`). When a cap is reached, the Worker pauses itself: testers see a friendly "paused" message, and reruns keep working.
- **Pause right now:** `npm run demo:pause`. It takes effect immediately, with no redeploy. Undo it with `npm run demo:resume`.
- **Kill switch:** set `DEMO_ENABLED = "false"` in `wrangler.toml` and deploy (push to `main`, or `npm run deploy`). Every AI endpoint then answers `demo_paused` until you set it back to `"true"` and deploy again.
- To change a limit or price, edit the value in `wrangler.toml` and deploy the same way. Values in `wrangler.toml` replace any you set in the dashboard on every deploy; secrets are never touched.

### 7. Second safety net on Meta's side

Meta's Model API docs (dev.meta.ai) don't describe a spend limit or billing alert as of October 2026. Check the billing section of your Meta developer account for a budget or alert and set one if it exists. Either way:
- Use a **separate API key just for the demo**, so you can revoke it in Meta's console without touching anything else.
- Keep the Worker caps low. They're estimates from the token counts Meta returns, so treat them as close but not exact.

## What the Worker does

| Endpoint | Auth | |
| --- | --- | --- |
| `GET /health` | none | `{ ok, demoEnabled }` |
| `POST /v1/session` | access code | label, creations and SAM images used/max, expiry |
| `POST /v1/chat` | access code + `X-Doppl-Creation-Id` | → Meta `POST /v1/chat/completions` (OpenAI-compatible), streaming or not |
| `POST /v1/segment` | access code | → Meta `POST /v1/responses` with `sam-3.1`, images only |
| `POST /admin/codes`, `GET /admin/codes`, `POST /admin/codes/:id/revoke`, `GET /admin/spend`, `POST /admin/pause`, `POST /admin/resume` | admin token | code management |

Limits:
- **Codes:** each code has a number of creations, a number of SAM images and an expiry.
- **Per creation:** at most `maxCallsPerCreation` model calls (15), set for the `doppl-demo` provider in the app's model registry, `electron/ai/models.json`. Allowed models and their prices come from the same file, so the app and the Worker stay in sync.
- **Rate:** 30 requests a minute per code.
- **Size:** requests over `MAX_REQUEST_BYTES` (10 MB) are rejected before being read.
- **Concurrency:** every limit is a single conditional `UPDATE … RETURNING` in D1, so parallel requests can't spend the same unit twice. The tests check that exactly 3 of 10 parallel requests get through when 3 creations are left.

Safety and privacy:
- **Your key:** the tester's `Authorization` header is replaced with yours on the upstream request only.
- **Models:** only the allowlisted standard models (`muse-spark-1.3`, `muse-wonder-1.0`, `sam-3.1`) are accepted. Wonder is the backup the app switches to when a routine's trials keep failing. The `-contributor` variants are rejected, because Meta may train on their request data.
- **Retention:** `store: false` is always sent, so Meta keeps no copy of requests. The Responses API used for SAM stores requests by default.
- **Request fields:** only an allowlist is forwarded, so no tools and no background jobs. `max_completion_tokens` is clamped to the demo's `maxOutputTokens` (8000) from the same registry.
- **Logging:** request and response bodies are never stored or logged; `usage_events` holds counts only. No CORS headers: the app calls from Electron's main process. Workers Logs aren't turned on, because they'd record request headers, and those include access codes.
- **Errors:** always `{ "error": { "code", "message" } }`, with a message the app shows as is. Codes: `invalid_code`, `code_expired`, `code_revoked`, `quota_exhausted`, `creation_call_limit`, `rate_limited`, `demo_paused`, `model_not_allowed`, `request_too_large`, `upstream_error` (includes `upstreamStatus`), plus `bad_request`, `unauthorized`, `not_found`, `internal_error`.

## Develop and test locally

```bash
npm test
npm run typecheck
```

`npm test` runs Vitest inside the Workers runtime (Miniflare) with Meta's API mocked.

To run the Worker locally, create `worker/.dev.vars` (git-ignored) with `META_API_KEY`, `ADMIN_TOKEN` and optionally `META_API_BASE_URL` (for example a local fake). Then:

```bash
npm run db:migrate:local
npm run dev
```

Point the app at it with `DOPPL_API_BASE_URL=http://127.0.0.1:8787` (see the main README).

## Open questions about Meta's API

Everything above follows dev.meta.ai/docs as read in October 2026. These points weren't fully documented; check them on first real use:

1. **SAM model id** is `sam-3.1` per the model list (not `sam-3-1`).
2. **Output-token field.** The Chat Completions schema marks `max_tokens` as deprecated in favor of `max_completion_tokens`; the reasoning guide still says `max_tokens`. The Worker sends `max_completion_tokens`. If Meta rejects it, change the one place in `src/proxy.ts` (`sanitizeChat`).
3. **SAM non-streaming** responses aren't documented; the app always streams SAM requests.
4. **`store` default for Chat Completions** isn't documented; the Worker always sends `store: false`.
5. **Reasoning tokens** are billed as output. The Worker assumes they're included in `usage.completion_tokens` (the docs list them under `completion_tokens_details.reasoning_tokens`).
6. **SAM usage** has no documented usage block, so SAM cost is estimated per image ($2.50 per 1,000).
7. **Spend limits or alerts** in Meta's console aren't documented (see step 7).

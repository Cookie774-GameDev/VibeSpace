# MASTER PROMPT — Deploy and Integrate the Free Hourly VibeSpace AI News System

You are the sole implementation and setup agent for the free hourly AI news system in:

- Repository: `Cookie774-GameDev/VibeSpace`
- Existing branch: `agent/pr30-fixes-and-updates`
- Existing pull request: **PR #31**
- Worker package: `workers/ai-news/`

Do not create another branch or pull request. Do not merge PR #31. Commit every in-scope code or documentation change directly to `agent/pr30-fixes-and-updates`.

## Goal

Finish the entire system end to end:

1. Deploy the existing Cloudflare Worker and D1 database.
2. Confirm Cloudflare Cron refreshes the feeds once every hour.
3. Capture the permanent `workers.dev` origin.
4. Connect that JSON output to the real VibeSpace News UI.
5. Make the News page load, refresh, filter, and display live data reliably.
6. Keep the ingestion system completely free and keyless.
7. Leave exact verification evidence and setup documentation.

The user's computer must not need to remain on. Do not use Windows Task Scheduler for hourly ingestion. Cloudflare Cron is the only ingestion scheduler.

## Non-negotiable free-only boundaries

Use only the implementation already present under `workers/ai-news/`:

- Cloudflare Workers Free
- Cloudflare Cron Trigger
- Cloudflare D1 free allowance
- Public RSS and Atom feeds
- Official GitHub release feeds
- Public Google News RSS

Do not add or require:

- X API
- Reddit API
- YouTube Data API
- Workers AI
- OpenAI, Anthropic, Gemini, Grok, or another paid model
- A paid Cloudflare plan
- A credit card
- Source API keys
- A continuously running local process
- A Windows scheduled task

Do not put credentials, account tokens, `.dev.vars`, `.env.local`, Wrangler auth files, or Cloudflare account data into Git.

## Required starting procedure

1. Confirm the current repository and branch:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git status --short
```

2. The branch must be:

```text
agent/pr30-fixes-and-updates
```

3. Read the repository's `AGENTS.md` and obey all applicable instructions.
4. Inspect `workers/ai-news/README.md`, `wrangler.jsonc`, `src/free.ts`, `migrations/0001_init.sql`, `package.json`, and `scripts/setup-free.mjs`.
5. Inspect the actual VibeSpace News route, existing news components, stores, services, settings, environment handling, and tests before changing the app. Search the repository rather than guessing paths.

Preserve unrelated PR #31 work. Do not redesign the News page unless a small change is necessary to display real data.

## Phase 1 — Validate the Worker locally

From the repository root:

```powershell
cd workers/ai-news
npm install --no-audit --no-fund
npm run typecheck
```

Run any focused local Worker checks available in the package. Do not claim success from inspection alone.

Confirm these properties in `wrangler.jsonc`:

- Worker name is `vibespace-ai-news`.
- Entry point is `src/free.ts`.
- Cron is exactly `7 * * * *`.
- D1 binding is `DB`.
- No AI binding exists.
- No paid-source secrets are required.
- Maximum source and item limits remain bounded for the free plan.

## Phase 2 — Deploy Cloudflare

Use the existing setup command:

```powershell
npm run setup:free
```

Cloudflare may open a browser. Ask the user only to approve the Cloudflare authorization page when it appears. Do not ask the user to paste passwords, tokens, or cookies into the terminal or chat.

The setup must:

1. Authenticate Wrangler.
2. Deploy the Worker.
3. Automatically create or attach the D1 database.
4. Apply `migrations/0001_init.sql`.
5. Deploy the final Worker configuration.
6. Register the hourly Cron Trigger.

If automatic D1 provisioning is not supported by the installed Wrangler version, repair the setup script so it safely performs these commands itself:

```powershell
npx wrangler d1 create vibespace-news
npx wrangler d1 execute DB --remote --file migrations/0001_init.sql --yes --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

Update the local Wrangler configuration with the returned database ID without committing account-specific IDs unless the repository's deployment conventions explicitly permit it.

Do not upgrade the Cloudflare account or enable a paid feature.

## Phase 3 — Capture and verify the output

Capture the permanent Worker origin printed by Wrangler:

```text
https://vibespace-ai-news.<account-subdomain>.workers.dev
```

Use the origin only, without a trailing slash, as `NEWS_API_URL`.

Verify all endpoints with real requests:

```text
GET <NEWS_API_URL>/
GET <NEWS_API_URL>/health
GET <NEWS_API_URL>/api/sources
GET <NEWS_API_URL>/api/news?limit=50
GET <NEWS_API_URL>/api/news?verification=official&limit=50
```

The first `/api/news` request should perform the initial import if D1 is empty.

Require the following before continuing:

- HTTP 200 from the health and news endpoints.
- `freeOnly: true` from the service or health response.
- A valid JSON body.
- `items` is an array.
- Each displayed item has a title, original source URL, source name/platform, verification value, published timestamp, and category.
- The latest ingestion run is recorded.
- Duplicate requests do not duplicate stored stories.
- Failed individual feeds do not crash the complete ingestion run.

Record the final Worker origin, item count, ingestion status, and verification time. Do not record Cloudflare credentials.

## Phase 4 — Connect the real VibeSpace News UI

Find the existing News page and its existing architecture. Implement a small typed client/adapter rather than putting raw fetch logic throughout UI components.

Use the stable deployed origin through the repository's existing configuration convention. Prefer:

```text
VITE_NEWS_API_URL=<NEWS_API_URL>
```

For local use, write it to `app/.env.local` without committing that file. Add or update a safe `.env.example` only when consistent with repository conventions. The Worker origin is public, but do not hardcode a temporary preview URL.

The integration must:

- Fetch `GET /api/news?limit=50`.
- Map the returned schema into the existing News UI model.
- Preserve the original article URL.
- Open article links safely in the system browser using the app's existing external-link helper.
- Show source name, source platform, verification, company when present, category, publication time, and summary.
- Clearly distinguish `official` from `confirmed`; never label media aggregation as official.
- Show loading, empty, offline, timeout, malformed-response, and retry states.
- Keep the last successful payload visible when a refresh fails.
- Add a bounded request timeout with `AbortController`.
- Prevent overlapping duplicate requests.
- Fetch on News-page activation.
- Refresh only while the News page is active, at a restrained interval such as 10–15 minutes.
- Include a visible manual refresh action if the current UI has an appropriate location.
- Show the backend's last completed ingestion time when available.
- Avoid polling every minute; the backend itself changes hourly.
- Preserve current visual design, theme behavior, accessibility, and navigation.

Do not use mock stories when the deployed endpoint is available. A development fallback may exist only if it is clearly marked and does not ship as fabricated live news.

## Phase 5 — Configuration and production behavior

Make the production build receive `VITE_NEWS_API_URL` through the existing build/deployment environment. Do not commit `.env.local`.

If the app already has a settings or runtime-config system better suited than a Vite build variable, use that system instead, but keep one canonical source of truth.

The fully automatic architecture must be:

```text
Cloudflare Cron (hourly)
        ↓
Cloudflare Worker
        ↓
Official/public RSS and Atom feeds
        ↓
Cloudflare D1
        ↓
GET /api/news
        ↓
VibeSpace News page
```

Do not add a second ingestion scheduler inside Tauri, React, Rust, Windows, or GitHub Actions.

## Phase 6 — Verification

Run focused checks for every changed area.

At minimum:

```powershell
cd workers/ai-news
npm run typecheck
```

Then run the repository's applicable focused checks for the VibeSpace files you changed, followed by the relevant app TypeScript/build check required by `AGENTS.md`.

Exercise the real UI against the deployed Worker and verify:

1. News loads without restarting the app.
2. Stories render in newest-first order.
3. Official and confirmed labels are truthful.
4. Links open the original source.
5. Manual refresh works.
6. Reopening the News page fetches current data.
7. A simulated network failure shows a recoverable state without deleting the last good data.
8. No API key or secret is present in Git changes.
9. Cloudflare shows the Cron Trigger `7 * * * *`.
10. The system continues running when the development server and VibeSpace are closed.

Do not claim the hourly execution was observed unless you actually observe a scheduled Cloudflare run. When immediate observation is impractical, verify the deployed trigger configuration and state that the next natural scheduled execution remains pending.

## Required documentation

Update `workers/ai-news/README.md` with the final verified setup and integration paths if reality differs from the current documentation.

Add a concise handoff record containing:

- Permanent Worker origin
- Public news endpoint
- Health endpoint
- Cron expression
- D1 database name
- VibeSpace configuration location
- Exact files changed
- Exact commands run
- Tests and live requests passed
- Remaining limitations
- Explicit confirmation that no paid API or AI model is enabled

Do not include tokens, cookies, account IDs that should remain private, or local Wrangler authentication files.

## Completion standard

Do not stop after merely deploying the Worker or merely editing the UI. Completion requires:

- Worker deployed
- D1 schema applied
- Cron registered
- Real JSON returned
- Permanent endpoint captured
- VibeSpace connected to that endpoint
- Real stories displayed
- Focused validation passed
- No secrets committed
- No paid dependency introduced
- All commits remain on `agent/pr30-fixes-and-updates` / PR #31

At the end, report only verified facts, exact changed paths, the final public endpoints, validation results, and any honest limitation.

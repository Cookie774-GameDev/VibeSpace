# VibeSpace Free Hourly AI News

A completely free, keyless Cloudflare backend for the VibeSpace News page.

## What it uses

- Cloudflare Worker on the Workers Free plan
- Cloudflare Cron Trigger every hour at minute 7
- Cloudflare D1 on the free allowance
- Public RSS and Atom feeds only
- No X API
- No Reddit API
- No YouTube API key
- No paid AI model
- No source API keys

The Worker performs deterministic filtering, categories, company detection, model-name detection, scoring, and duplicate removal. It does not call an AI model. Each hourly occurrence has a D1-backed cross-isolate lease, run key, unique fencing token, and explicit completed-run identity. Overlapping deliveries cannot start duplicate ingestion, a completed occurrence remains deduplicated, and an incomplete occurrence can recover after its lease expires. Audit and release writes require the current fencing token, so an expired holder cannot finalize a recovered lease. Unexpected failures are best-effort recorded with a bounded failed-run reason so retained data is not presented as fresh. Source requests use a 12-second timeout and two bounded backoff retries.

## Included feeds

- OpenAI News
- Google AI Blog
- Google DeepMind
- Hugging Face Blog
- NVIDIA Generative AI
- Ollama GitHub releases
- Hugging Face Transformers GitHub releases
- Qwen's official project blog

Official company and project feeds are labeled `official`. Optional feeds configured through
`EXTRA_FEEDS` remain `confirmed`, never `official`.

## Deploy once

```bash
cd workers/ai-news
npm install
npm run setup:free
```

Cloudflare may open a browser so you can sign in. Current Wrangler automatically creates the D1 resource because `wrangler.jsonc` contains a draft `DB` binding without an account-specific ID.

The setup command validates the configured D1 binding, applies every ordered migration, and then
deploys the Worker once. It does not publish a route before its tables exist.

No billing upgrade or API keys are required.

Migration history is sequential: `0001_init.sql` is the deployed base schema,
`0002_ingestion_lease.sql` adds fenced ingestion leases, and
`0003_benchmark_snapshots.sql` adds retained structured Arena snapshots.

## Hourly schedule

```text
7 * * * *
```

The job runs seven minutes after every hour. Public news endpoints are read-only and never trigger upstream ingestion. After a fresh deployment, invoke the supported scheduled-handler test route once or wait for the next Cron run before expecting the first stories.

## Read the output

Cloudflare prints a URL after deployment similar to:

```text
https://vibespace-ai-news.YOUR-SUBDOMAIN.workers.dev
```

### JSON news feed

```text
GET https://vibespace-ai-news.YOUR-SUBDOMAIN.workers.dev/api/news
```

Optional filters:

```text
/api/news?limit=50
/api/news?verification=official
/api/news?company=OpenAI
/api/news?category=model-release
/api/news?platform=release
```

`/api/news.json` returns the same output.

Example response:

```json
{
  "generatedAt": "2026-08-05T15:40:00.000Z",
  "count": 2,
  "latestRun": {
    "completed_at": "2026-08-05T15:39:58.000Z",
    "status": "success",
    "fetched_count": 24,
    "stored_count": 4
  },
  "freshness": {
    "state": "fresh",
    "ageMs": 2000
  },
  "items": [
    {
      "id": 1,
      "title": "Example model announcement",
      "summary": "Short source-provided description.",
      "url": "https://source.example/article",
      "source": {
        "platform": "official",
        "name": "OpenAI News"
      },
      "company": "OpenAI",
      "modelNames": ["GPT-5.6"],
      "category": "model-release",
      "verification": "official",
      "importance": 95,
      "publishedAt": "2026-08-05T14:00:00.000Z",
      "collectedAt": "2026-08-05T15:39:58.000Z"
    }
  ]
}
```

The `freshness` object is derived from the persisted ingestion audit. It reports `fresh`, `stale`, `degraded`, `failed`, or `never`, and includes a bounded warning whenever retained data must not be presented as current.

## Connect VibeSpace

The desktop News page only needs to call the endpoint:

```ts
const response = await fetch(`${NEWS_API_URL}/api/news?limit=50`);
if (!response.ok) throw new Error(`News API failed: ${response.status}`);
const payload = await response.json();
const stories = payload.items;
```

Store the deployed Worker origin as a normal application setting such as:

```text
VITE_NEWS_API_URL=https://vibespace-ai-news.YOUR-SUBDOMAIN.workers.dev
```

Do not hardcode a temporary preview URL.

## Other endpoints

- `GET /` — service information
- `GET /health` — database count and last ingestion result
- `GET /api/sources` — configured source list
- `GET /api/news` — latest news data
- `GET /api/news.json` — same JSON data

## Add another free feed

Set `EXTRA_FEEDS` as a JSON string in Cloudflare Worker variables. Each item supports:

```json
{
  "name": "Example official blog",
  "url": "https://example.com/feed.xml",
  "company": "Example AI",
  "platform": "official",
  "verification": "official"
}
```

Only HTTPS RSS or Atom feeds should be added. A maximum of 12 feeds is processed per run to stay comfortably within Free-plan subrequest limits.

## Local test

```bash
npm run typecheck
npm run dev
```

Apply the local schema:

```bash
npm run db:migrate:local
```

Apply all pending migrations to an existing deployed database:

```bash
npm run db:migrate:remote
```

Trigger the scheduled handler:

```text
http://localhost:8787/__scheduled?cron=7+*+*+*+*
```

Then read:

```text
http://localhost:8787/api/news
```

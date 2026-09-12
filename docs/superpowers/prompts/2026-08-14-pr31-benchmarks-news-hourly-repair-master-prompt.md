# PR #31 MASTER PROMPT — Rebuild VibeSpace Benchmarks + Hourly AI News for Live Accuracy

**Repository:** `Cookie774-GameDev/VibeSpace`  
**Pull request:** `#31`  
**Target branch:** `agent/pr30-fixes-and-updates`  
**Priority:** P0 data accuracy / P0 freshness / P1 UX  
**Execution goal:** repair the existing benchmark + AI-news system end-to-end, verify the deployed Cloudflare backend, commit/push every in-scope change directly to PR #31, and leave evidence in the repository.

---

## 0. EXECUTION CONTRACT

You are the implementation agent. Do not only inspect, plan, or explain. Implement the repair in the real repository and real backend available to you.

Use this loop until the system is actually correct:

```text
REPRODUCE
→ IDENTIFY ROOT CAUSE
→ DESIGN THE FIX
→ IMPLEMENT
→ TEST
→ COMPARE AGAINST LIVE SOURCES
→ SELF-GRADE
→ FIX ANY FAILURE
→ RETEST
→ DOCUMENT
→ COMMIT/PUSH
```

Do not stop at the first failing test. A failing test, type error, deployment error, stale D1 row, bad parser, incorrect ranking, or broken source is a defect to fix, not a reason to stop.

Ask for owner interaction only when an external service genuinely requires an interactive login/consent that cannot be completed through the connected plugin/tool. Never ask for passwords, cookies, secret values, or API keys in chat. Use connected GitHub, Cloudflare, Supabase, and Stripe tooling when available.

Do not fabricate a PASS because an external source is unavailable. Use one of:

```text
VERIFIED
IMPLEMENTED — DEPLOYMENT VERIFICATION REQUIRED
BLOCKED — SOURCE CAPABILITY
BLOCKED — OWNER AUTHORIZATION
BLOCKED — ENVIRONMENT
NOT COMPLETE
```

Keep PR #31 open/draft. Do not merge it.

---

# 1. SCOPE

Fix only the systems directly required for:

1. VibeSpace Benchmarks;
2. hourly benchmark ingestion/freshness;
3. VibeSpace AI News;
4. hourly news ingestion/freshness;
5. benchmark/news Cloudflare Worker + D1 backend;
6. benchmark/news client adapters and UI;
7. source registries, data validation, media metadata, tests, deployment evidence, and documentation.

Do **not** redesign or behaviorally modify unrelated systems such as:

- normal VibeSpace Chat;
- RLM/context runtime;
- Jarvis voice;
- normal model routing;
- agents/subagents;
- terminals except for local verification commands;
- browser chat;
- Model Foundry;
- pets;
- billing;
- Stripe products/prices/subscriptions;
- unrelated Supabase schemas/functions;
- installer/release systems;
- themes beyond small benchmark/news-compatible styling changes.

If a shared file must change, make the smallest possible integration change and run the affected regression suite.

---

# 2. REQUIRED STARTING PROCEDURE

Before writes:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git log -5 --oneline
```

Confirm:

```text
repo   = Cookie774-GameDev/VibeSpace
PR     = 31
branch = agent/pr30-fixes-and-updates
```

Read the current versions of at least:

```text
app/src/features/benchmarks/BenchmarksPage.tsx
app/src/features/benchmarks/benchmarkData.ts
app/src/features/benchmarks/benchmarkRefresh.ts
app/src/features/benchmarks/BenchmarkRefreshHost.tsx
app/src/features/benchmarks/NewsAwareBenchmarksPage.tsx
app/src/features/benchmarks/NewsModelBenchmarkLane.tsx
app/src/features/benchmarks/leaderboardSnapshot20260711.ts
app/src/features/benchmarks/index.ts

app/src/features/news/NewsPanel.tsx
app/src/features/news/newsApi.ts
app/src/features/news/newsSections.ts
app/src/features/news/newsCatalog.ts

workers/ai-news/src/free.ts
workers/ai-news/wrangler.jsonc
workers/ai-news/migrations/0001_init.sql
workers/ai-news/migrations/0002_ingestion_lease.sql
workers/ai-news/src/free.test.ts
workers/ai-news/src/migrations.test.ts
workers/ai-news/README.md

docs/superpowers/plans/2026-08-09-hourly-news-benchmarks.md
docs/superpowers/free-hourly-ai-news-2026-08-05/MASTER_PROMPT.md
```

Also grep the entire branch for the exact or equivalent UI strings:

```text
New model comparison
Benchmark Scout
Official provider valuations
provider valuations
curated Top 50
Arena score
```

Record where every user-visible one comes from.

Create/update this mandatory ledger as work proceeds:

```text
docs/operations/PR31_BENCHMARKS_NEWS_REPAIR_LEDGER.md
```

---

# 3. VERIFIED CURRENT ROOT CAUSES TO RE-CHECK

Do not blindly trust this list, but explicitly verify each item against the current head.

## 3.1 Wrong benchmark scale / wrong leaderboard source

The existing `benchmarkData.ts` currently prefers a Wu Long/LMArena Arena feed for live refreshes. Arena/Elo-style values can be around 1500+, which is why the UI can show values such as ~1587 while labeling them as an intelligence score.

The user does **not** want Arena Elo to be the primary VibeSpace benchmark score.

The primary VibeSpace leaderboard must use the **Artificial Analysis Intelligence Index** scale and ranking.

## 3.2 Stale Artificial Analysis fallback

The embedded fallback file is dated `2026-07-11`. It predates newer model releases and methodology/data updates. It also folds reasoning-effort variants in ways that do not match the current Artificial Analysis leaderboard presentation.

Do not let an old embedded July snapshot silently become the authoritative current ranking.

## 3.3 “New model comparison” is intentionally injected above the leaderboard

`NewsAwareBenchmarksPage` currently renders `NewsModelBenchmarkLane` before `BenchmarksPage`, and that lane contains the “New model comparison” UI.

The owner explicitly wants this removed from the Benchmarks page.

## 3.4 Benchmark hourly refresh is currently client-owned

The benchmark refresh scheduler currently lives in the React/Tauri app and uses local storage/timers. That is not sufficient for a backend that must refresh once per hour when VibeSpace is closed.

The authoritative benchmark refresh must move to Cloudflare Cron + D1, like the news system.

The app may still refetch the backend when opened/focused, but it must not be the ingestion authority.

## 3.5 News source coverage is too small

The current worker has only a small default feed list and the ingestion code takes a small bounded subset. This does not match the requested top-50-to-100 AI-company/provider monitoring goal.

## 3.6 Live news thumbnails are currently discarded

The frontend live-news adapter currently sets `imageUrl`/image credit to empty values rather than consuming live media metadata.

The Worker schema/output also needs first-class media metadata.

## 3.7 Full timestamps are being degraded

The live-news adapter currently truncates `publishedAt` to a date string. This destroys hour/minute precision and can make Today / Last week bucketing inaccurate.

Keep full timezone-aware ISO timestamps end-to-end.

## 3.8 The Cloudflare cron exists in repo config but deployed reality must be proven

`wrangler.jsonc` currently declares an hourly cron at minute 7. Do not assume that means the production/deployed Worker is healthy. Inspect the actual Cloudflare Worker, actual Cron Trigger, actual D1 tables, and latest run timestamps.

---

# 4. PRODUCT CONTRACT — BENCHMARKS

The default Benchmarks page must answer:

> Which AI models are strongest right now according to the current Artificial Analysis Intelligence Index, and how do they compare on price, speed, latency, context, and price/performance?

It must **not** answer that question by substituting LMArena Elo.

---

# 5. ARTIFICIAL ANALYSIS IS THE PRIMARY BENCHMARK AUTHORITY

At execution time, re-fetch/re-verify the live official Artificial Analysis model leaderboard and Intelligence Index methodology.

Primary metric:

```text
Artificial Analysis Intelligence Index
```

Preserve the exact score scale used by the current source.

Do not multiply it, convert it to Elo, normalize it to 1000+, or merge it with Arena scores.

### Current sanity anchor — re-verify, do not hardcode forever

At the time this prompt was authored, the current Artificial Analysis leaderboard showed approximately:

```text
#1 Claude Opus 5 (Adaptive Reasoning, Max Effort) — Intelligence Index 61
#2 Claude Opus 5 (Adaptive Reasoning, Xhigh Effort) — 60
#3 Claude Fable 5 (Adaptive Reasoning, Max Effort, Opus 4.8 Fallback) — 60
#4 GPT-5.6 Sol (max) — 59
```

This is only a **live sanity check for the current repair**, not a permanent assertion in application code or tests. Rankings can change hourly/daily.

The completed system must compare itself against whatever Artificial Analysis reports **at verification time**.

---

# 6. DO NOT FOLD DISTINCT REASONING VARIANTS

If Artificial Analysis ranks separate variants/effort levels separately, VibeSpace must preserve them as separate rows.

Examples:

```text
Claude Opus 5 — max
Claude Opus 5 — xhigh
Claude Opus 5 — high
```

Do not collapse them into one base model and invent one score.

A stable row identity should include at least:

```text
provider + model family + variant + reasoning/effort configuration
```

---

# 7. BENCHMARK DATA MODEL

Replace ambiguous `arena_score` semantics for the primary leaderboard.

A target row can resemble:

```ts
type BenchmarkModelRow = {
  id: string;
  rank: number;

  provider: string;
  model: string;
  variantLabel?: string;
  effort?: string;

  intelligenceIndex: number;

  outputTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  endToEndSeconds?: number;

  inputPricePer1MTokensUsd?: number;
  outputPricePer1MTokensUsd?: number;
  cacheWritePricePer1MUsd?: number;
  cacheHitPricePer1MUsd?: number;

  costPerTaskUsd?: number;
  contextWindowTokens?: number;

  openWeights?: boolean;
  releaseDate?: string;

  sourceName: 'Artificial Analysis';
  sourceUrl: string;
  methodologyVersion?: string;
  sourceObservedAt: string;
  ingestedAt: string;
};
```

Names can match repository conventions, but the semantics must be explicit.

Do not reuse a field called `arena_score` for Artificial Analysis Intelligence Index values.

---

# 8. BENCHMARK DERIVED METRICS

Support useful filters/sorts while clearly separating source-reported and derived values.

Required sorts/filters:

```text
Intelligence — highest first
Cost per task — lowest first (when source provides it)
Input price / 1M — lowest first
Output price / 1M — lowest first
Blended token price — lowest first
Intelligence per dollar — highest first
Output speed — highest first
Time to first token — lowest first
Context window — highest first
Provider
Open weights / proprietary
Reasoning effort / variant
```

### Derived metric rules

A derived metric may be calculated only from compatible fields for the exact same row/variant.

Example:

```text
intelligencePerDollar = intelligenceIndex / costPerTaskUsd
```

Only calculate when both are present and valid.

Label derived metrics as derived.

Do not invent missing cost-per-task values from token price without a documented task-token model.

For “blended token price”, define and document the exact formula (for example a simple 50/50 input/output blend) and label it as a VibeSpace-derived convenience metric rather than an Artificial Analysis metric.

---

# 9. PRICE PROVENANCE

Prefer pricing from the same current Artificial Analysis model dataset when available.

If a value is absent, second priority is a current official provider pricing source.

Do not silently rely on a large static regex price catalog as the source of truth for current ranking/filter behavior.

Every non-null price should have provenance/freshness metadata internally.

If a price cannot be verified, show `—` or `Unavailable`, not a guess.

---

# 10. ARENA / OTHER BENCHMARK SOURCES

LMArena can remain only as a **separate optional dataset** if it adds product value.

If retained:

```text
Artificial Analysis Intelligence Index
```

and

```text
LMArena / Arena Elo
```

must be completely distinct modes/tabs/datasets with their own labels and scales.

Never numerically merge them.

Never show an Arena Elo value in the default Intelligence Index column.

The simplest acceptable owner-aligned implementation is to make Artificial Analysis the only default leaderboard and remove Arena from the main UI.

---

# 11. REMOVE UNWANTED BENCHMARK UI

The owner explicitly wants the following removed from the Benchmarks page:

### Remove completely

```text
New model comparison
Benchmark Scout comparison lane above the leaderboard
Official provider valuations
```

Do not merely collapse or hide these with CSS if code is still mounting them.

Fix the export/routing path so the benchmark route renders the real leaderboard directly.

If the now-unused news-comparison code has no other consumers, remove or deprecate it cleanly with tests updated accordingly.

Search runtime screenshots/DOM and source until “Official provider valuations” is truly absent from the page the user sees.

---

# 12. BENCHMARK CLOUD BACKEND

The benchmark ingestion authority must run in Cloudflare so it works with the user's PC off.

Prefer extending the existing Cloudflare/D1 intelligence backend rather than adding unnecessary infrastructure.

Acceptable architecture:

```text
Cloudflare Cron — hourly
        ↓
VibeSpace AI intelligence Worker
        ├── ingestNews()
        └── ingestBenchmarks()
                ↓
               D1
        ├── news tables
        └── benchmark tables
                ↓
GET /api/news
GET /api/benchmarks
GET /health
```

You may retain the current worker name if changing it would create avoidable deployment risk.

Do not add a Windows Task Scheduler job or require VibeSpace to remain open.

---

# 13. BENCHMARK D1 SCHEMA

Add an ordered migration after the existing news migrations.

Suggested logical tables:

```text
benchmark_datasets
benchmark_rows
benchmark_ingestion_runs
```

A dataset should store:

```text
source
metric
methodology/version
source_observed_at
ingested_at
row_count
status
checksum/hash where useful
```

Rows should be tied to a specific dataset/run.

Use a transaction/batch so a failed parse does not replace the current good dataset with a half-populated one.

### Last-known-good rule

Only promote a new benchmark dataset to current after all validation gates pass.

If the new fetch fails:

```text
retain previous current dataset
mark freshness stale/degraded
record failure audit
```

Never replace good data with empty rows.

---

# 14. BENCHMARK VALIDATION GATES

Before promoting a new dataset:

- parse produced a reasonable non-zero model count;
- every row has a model/provider/score;
- scores are on a plausible Intelligence Index scale rather than Arena Elo;
- ranks are deterministic;
- duplicate IDs are rejected/deduped explicitly;
- top N values are monotonic according to rank;
- timestamps are valid;
- source/methodology metadata exists;
- current leaderboard differs from previous data only in explainable ways;
- no accidental HTML error page was parsed as data.

Add a “source anomaly” fail-closed mode.

Example:

```text
if median Intelligence Index suddenly becomes 1500,
reject the dataset.
```

Do not hardcode a single model as #1 forever.

---

# 15. BENCHMARK API

Expose a typed endpoint such as:

```text
GET /api/benchmarks
```

Response should include:

```json
{
  "generatedAt": "...",
  "freshness": { "state": "fresh", "ageMs": 0 },
  "dataset": {
    "source": "Artificial Analysis",
    "metric": "Artificial Analysis Intelligence Index",
    "methodologyVersion": "...",
    "sourceObservedAt": "...",
    "ingestedAt": "..."
  },
  "rows": []
}
```

The frontend must consume this typed API instead of independently scraping live leaderboards.

Provide a manual refresh only as a backend refetch/UI refresh, not as the primary ingestion mechanism.

---

# 16. BENCHMARK FRONTEND

Default page requirements:

- source badge: Artificial Analysis;
- full freshness time;
- current methodology/index label;
- top chart that matches the table;
- table default sorted by Intelligence descending;
- score values such as `61`, not Arena values such as `1587`;
- filters listed above;
- no old provider-valuation section;
- no new-model-comparison lane;
- clear stale state while retaining the last-known-good dataset;
- source link in details;
- price/speed/context shown only when supported by the exact row.

Do not claim `Live` merely because the page fetched localStorage.

`Live` means the backend dataset is within the configured freshness SLA.

---

# 17. BENCHMARK CACHING

Frontend cache may improve startup, but it is not authoritative.

Use:

```text
backend D1 current dataset = authority
frontend cache            = temporary last-known rendering optimization
```

On app startup/focus:

1. render cached last-known data if useful;
2. fetch backend immediately/bounded;
3. replace with backend result;
4. show stale/error truthfully.

Expire/migrate the existing `jarvis-benchmark-cache-v5` semantics so old Arena rows cannot remain mislabeled as Intelligence Index rows after upgrade.

---

# 18. PRODUCT CONTRACT — NEWS

The news system must automatically gather significant current AI/model/tool/company news each hour, especially official announcements, and present rich cards with accurate timestamps and available media.

The backend must continue operating with VibeSpace closed.

---

# 19. HOURLY NEWS CRON

The canonical schedule should remain once per hour, for example:

```text
7 * * * *
```

The exact minute is not important; one run per clock hour is.

Use Cloudflare Cron as the ingestion scheduler.

During implementation:

1. inspect actual deployed Worker configuration;
2. inspect actual Cron Trigger;
3. inspect actual D1 latest run;
4. deploy changed Worker/migrations through the authorized Cloudflare tooling;
5. verify a real ingestion run;
6. verify `/health` freshness;
7. verify the next natural scheduled execution or record the pending observation honestly.

No second competing ingestion scheduler in React/Tauri/Windows/GitHub Actions.

---

# 20. NEWS SOURCE REGISTRY — 50 TO 100 HIGH-VALUE SOURCES

Create a structured registry of roughly **50–100 high-value AI sources**.

Do not create 100 random low-quality feeds merely to hit a number.

Prioritize:

### AI labs/providers

Examples include current official sources for:

```text
OpenAI
Anthropic
Google AI / Google DeepMind
xAI
Meta AI
Microsoft AI
NVIDIA
Mistral AI
DeepSeek
Alibaba/Qwen
Moonshot/Kimi
Zhipu/GLM
MiniMax
Cohere
AI21
Hugging Face
Stability AI where relevant
major open-model labs
```

### Inference/cloud/model platforms

Examples:

```text
OpenRouter
Groq
Cerebras
Together AI
Fireworks AI
Replicate
Modal
Baseten
Cloudflare AI
AWS AI/Bedrock
Azure AI
Google Vertex AI
```

### AI developer tools / agent ecosystem

Examples where current relevance is verified:

```text
OpenCode
Codex/OpenAI developer announcements
Claude Code/Anthropic developer announcements
Cursor
Windsurf
Cognition/Devin
Replit
Vercel AI SDK
LangChain
LlamaIndex
Ollama
Aider
Continue
MCP ecosystem updates
```

For every entry store the actual supported official endpoints/identities rather than guessing.

Suggested registry fields:

```ts
type NewsSource = {
  id: string;
  company: string;
  priority: number;
  enabled: boolean;

  officialSite?: string;
  rss?: string;
  atom?: string;
  githubReleases?: string[];
  xHandle?: string;
  youtubeChannelId?: string;

  verification: 'official';
};
```

Keep source registry changes reviewable and tested.

---

# 21. X / TWITTER PRIORITY

The owner wants official X posts to be a major discovery/source channel.

Use X only through a supported authenticated API/connector available to the implementation environment.

If a Cloudflare secret such as an authorized X API bearer token is available, store it only as a Cloudflare secret — never in Git/D1/plain logs.

If an X API/connector is not available, do **not** build a fragile authenticated HTML scraper or steal browser cookies.

In that case:

- mark X ingestion unavailable in source-health telemetry;
- continue ingesting official blogs/RSS/GitHub/YouTube;
- do not block the whole news run;
- do not fabricate X posts.

When the same announcement is published on official X + official blog + official YouTube, cluster it as one story with multiple source references rather than showing 3–5 duplicates.

Prefer the original official announcement URL as the primary link.

---

# 22. NEWS SOURCE HEALTH

Track per-source health, at minimum:

```text
last_attempt_at
last_success_at
last_item_at
status
failure_count
last_error_code
```

The `/health` endpoint should answer:

- did hourly news ingestion run?;
- did hourly benchmark ingestion run?;
- how old is each current dataset?;
- how many sources succeeded?;
- how many sources failed?;
- how many items were fetched/stored?;
- are X/YouTube optional integrations active?;
- is data fresh/degraded/stale/failed?;

Do not expose secrets or full sensitive errors.

---

# 23. NEWS TIMESTAMPS

Store and return **full ISO 8601 timestamps with timezone information**.

Do not truncate this:

```text
2026-08-14T18:42:11Z
```

to:

```text
2026-08-14
```

Frontend Today/Last week/More bucketing must use the full timestamp and the user's local clock correctly.

Suggested rules:

```text
Today     = item occurred on the user's current local calendar date
Last week = older than Today but within previous 7 days
More      = older than 7 days
```

Or use rolling 24h for Today if that is the established product contract, but document and test it consistently.

No item should jump categories simply because time-of-day was deleted.

---

# 24. NEWS DEDUPLICATION / EVENT CLUSTERING

Deduplicate using more than exact URL.

Use a combination of:

- canonical URL;
- source/platform external ID;
- normalized title;
- company + model names;
- content hash;
- time window;
- known cross-post relationships.

Create one canonical story/event with optional source references.

An OpenAI release blog + official X post + YouTube video for the same model launch should normally be one rich card/event, not three unrelated cards.

Never merge unrelated stories simply because they mention the same model.

---

# 25. NEWS MEDIA / THUMBNAILS / VIDEO

Every live news item should carry the best available media metadata.

Add schema fields through an ordered migration, for example:

```text
image_url
image_credit
video_url
media_type
media_source
```

Potential media sources, in trust order:

1. media URL returned by the official X API for an official post;
2. RSS/Atom `media:content`, `media:thumbnail`, or enclosure;
3. official YouTube thumbnail for an official video;
4. Open Graph image from the original official article page;
5. source/provider brand fallback generated by the UI.

Rules:

- HTTPS only;
- validate URL/host;
- do not execute page scripts;
- bounded source-page fetch;
- bounded HTML size;
- bounded redirects;
- do not proxy unlimited remote files through the Worker;
- never embed untrusted arbitrary HTML.

For video stories:

- keep the original official video URL;
- show a video/play badge/thumbnail;
- clicking opens the official source or uses an existing safe preview pattern;
- do not download/archive copyrighted videos into D1.

The frontend live adapter must stop hardcoding `imageUrl: ''`.

---

# 26. NEWS CARD CONTRACT

Each live card should show when available:

```text
cover thumbnail
headline
short factual summary/excerpt
company/source
verification badge
publication date + time
model/tool tags
media/video indicator
original source link
```

A missing remote thumbnail may use a consistent VibeSpace/source-brand fallback, but the fallback must not look like a real article image.

---

# 27. NEWS SUMMARY ACCURACY

The core feed must not depend on a paid LLM to function.

Prefer:

- original source title;
- sanitized feed description/excerpt;
- deterministic cleanup/truncation;
- source metadata.

If an optional model is used for summaries, it must be additive, bounded, failure-tolerant, source-grounded, and never allowed to invent model releases/features.

Source truth beats generated prose.

---

# 28. NEWS IMPORTANCE / SORTING

Newest significant official items should be surfaced first.

A ranking formula can include:

```text
official source
major model launch
API/tool launch
pricing/context change
benchmark result
company announcement
recency
cross-source confirmation
```

Do not allow importance score to reorder a week-old story above today's major release without a clear reason.

Default ordering should be recency-first with importance as a secondary signal, unless product tests justify otherwise.

---

# 29. DO NOT FORCE FAKE “TODAY” COUNTS

A healthy system may legitimately have zero significant official stories on a quiet day.

The fix is not to manufacture content so the Today badge becomes non-zero.

Instead, prove:

- hourly run is fresh;
- source registry was checked;
- source health is visible;
- full timestamps are correct;
- qualifying items are bucketed correctly.

If there are real current stories, they must appear in Today.

---

# 30. CLOUDFARE RUN ORCHESTRATION

One scheduled invocation can run news + benchmarks, but keep separate result/audit records.

Suggested structure:

```ts
async scheduled(...) {
  await Promise.allSettled([
    runNewsIngestion(...),
    runBenchmarkIngestion(...),
  ]);
}
```

Or serialize them if Worker CPU/network budgets require it.

One pipeline failing must not erase the successful result of the other.

Use existing lease/fencing protections or create distinct lease keys such as:

```text
news-hourly
benchmarks-hourly
```

Preserve idempotency on duplicate cron delivery.

---

# 31. RETRIES / TIMEOUTS

Every remote source fetch must be bounded.

Use:

- per-request timeout;
- small bounded retry count for transient failures;
- 408/429/5xx retry handling;
- Retry-After when reasonable;
- maximum decoded response bytes;
- source concurrency cap;
- overall run budget.

Do not create an infinite retry loop that burns Worker quotas.

---

# 32. CLOUDFLARE DEPLOYMENT

Use the connected Cloudflare environment to inspect the **actual** deployment before changing it.

Verify:

```text
Worker name
active deployment/version
cron trigger
D1 binding/database
current migrations
latest Worker logs
latest news ingestion run
latest benchmark ingestion run after this implementation
```

Apply new D1 migrations in order.

Deploy the changed Worker.

Verify public endpoints with real requests.

Do not commit Cloudflare credentials, Wrangler OAuth files, `.dev.vars`, account tokens, or secrets.

---

# 33. SUPABASE / STRIPE BOUNDARY

The current benchmark/news data path is Cloudflare/D1-oriented.

Use Supabase only if an existing benchmark/news code path genuinely depends on VibeSpace identity/configuration. Do not move the feed database to Supabase without a clear architectural reason.

Use the connected Supabase plugin primarily to verify you are not accidentally breaking unrelated app/backend dependencies.

For Stripe:

```text
NO benchmark/news billing changes are required.
```

Do not modify:

- products;
- prices;
- subscriptions;
- checkout;
- webhooks;
- credits;
- customer state.

Stripe access is not a reason to touch billing.

---

# 34. FRONTEND NEWS FETCH POLICY

Backend changes hourly; the UI does not need per-minute ingestion.

Recommended behavior:

- fetch when News opens;
- refetch after a bounded stale interval (for example 5–15 minutes while visible);
- refetch on online/focus if stale;
- manual refresh button;
- keep last-known-good data on network failure;
- display backend freshness state;
- never run a second local ingestion engine.

Prevent overlapping requests.

---

# 35. DATA MIGRATION / LEGACY CLEANUP

After the new backend is live:

- invalidate or migrate old Arena-centric benchmark cache entries;
- prevent stale embedded July rows from being shown as `Live`;
- preserve a clearly labeled emergency snapshot only if needed for offline UX;
- ensure snapshot score semantics exactly match its label;
- remove dead benchmark-news comparison cache/state if no longer used;
- preserve old D1 news rows through additive migrations.

Do not destructively wipe production D1 news history merely to simplify migration.

---

# 36. BENCHMARK AUTOMATED TESTS

Add/update tests for at least:

### Source/parser

```text
valid Artificial Analysis payload/page data
malformed source
HTML error page
missing fields
duplicate variants
separate reasoning efforts
rank ordering
methodology/version extraction
```

### Scale protection

A regression test must fail if Arena-style ~1500 scores are accidentally mapped into the Artificial Analysis Intelligence Index field.

### Cache

```text
legacy Arena cache rejected/migrated
fresh backend accepted
stale backend retained with stale state
failed refresh keeps prior data
```

### UI

```text
Artificial Analysis displayed as default source
correct score field shown
sort by Intelligence
sort by cost
sort by input price
sort by output price
sort by speed
sort by price/performance
New model comparison absent
Official provider valuations absent
```

---

# 37. NEWS AUTOMATED TESTS

Cover at least:

```text
hourly cron handler
lease/fencing
idempotent redelivery
partial-source failure
all-source failure
source health
full timestamp preservation
local-day bucketing
Today / Last week / More boundaries
cross-post dedupe
media RSS parsing
Open Graph image parsing
YouTube thumbnail parsing
X media parsing when adapter enabled
invalid image URL
oversized source page
redirect bound
malformed feed
source timeout
retention
last-known-good behavior
```

Frontend tests:

```text
live image renders
image failure uses fallback
video badge renders
full publication time preserved
Today count uses live data
freshness warning appears
last good data remains after refresh failure
```

---

# 38. LIVE BENCHMARK ACCURACY TEST

This is mandatory.

At final verification time:

1. fetch current Artificial Analysis leaderboard using an official/public supported source;
2. record its top 10 rows and timestamp in the repair ledger;
3. request VibeSpace `/api/benchmarks`;
4. compare top 10 model identities/variants/ranks/scores;
5. open the real VibeSpace Benchmarks page;
6. verify the same top ordering visually;
7. verify the top score uses the Artificial Analysis scale;
8. verify price/speed values are mapped to the exact corresponding variant.

Target:

```text
Top-10 rank accuracy: 100%
Top-10 score accuracy: 100%
Variant identity accuracy: 100%
```

A one-hour ingestion delay is acceptable only if the backend freshness timestamp truthfully shows it and the source changed after the latest scheduled ingestion. Trigger/perform a bounded refresh during verification when authorized.

---

# 39. LIVE NEWS ACCURACY TEST

At final verification time:

1. inspect the latest Worker news run;
2. confirm it completed within the freshness SLA;
3. inspect a sample of the newest 20 cards;
4. open original sources;
5. verify title/company/date/time/link/category;
6. verify official vs confirmed classification;
7. verify thumbnail comes from a legitimate source/fallback;
8. verify duplicate cross-posts are clustered/deduped;
9. verify a video story has the correct video/thumbnail behavior;
10. verify Today items are truly today in the user/local-time interpretation.

Do not claim 100% accuracy from unit tests alone.

---

# 40. PERFORMANCE / FREE-TIER DISCIPLINE

Measure and bound:

```text
Worker run duration
source fetch concurrency
D1 statements per run
news item writes
benchmark dataset writes
API response size
frontend initial load time
frontend rerenders
```

Do not fetch 100 sources serially if bounded concurrency is safe.

Do not fetch every source page just for Open Graph media if RSS/X/YouTube already provided a thumbnail.

Use media page enrichment only when needed and within a per-run cap.

No unbounded arrays, logs, request bodies, or retries.

---

# 41. SOURCE REGISTRY MAINTENANCE

Because sources change over time, keep source definitions data-driven rather than scattering URLs through parsing code.

Add tests that validate:

- unique IDs;
- HTTPS URLs where required;
- official company names;
- supported source types;
- no duplicate endpoint;
- reasonable source count (target 50–100);
- disabled/deprecated source is explicitly marked rather than silently deleted when useful for history.

---

# 42. NO-FAKE-SUCCESS RULES

Never:

- create a benchmark score from news text;
- assign a model a rank before the benchmark source has ranked it;
- convert Arena Elo into Artificial Analysis Intelligence Index;
- infer current prices from model names when a live verified source exists;
- label cached July data `Live`;
- generate fake Today news;
- invent thumbnails;
- label media aggregation `official`;
- say X is monitored if the X adapter is disabled/unavailable;
- say hourly cron is working only because `wrangler.jsonc` contains a cron string.

Every important status must have evidence.

---

# 43. REQUIRED DOCUMENTATION

Create/update Markdown documentation only.

At minimum:

```text
docs/superpowers/prompts/2026-08-14-pr31-benchmarks-news-hourly-repair-master-prompt.md
docs/superpowers/specs/2026-08-14-pr31-benchmarks-news-hourly-repair-design.md
docs/superpowers/skills/2026-08-14-pr31-benchmarks-news-hourly-repair-skill.md
docs/operations/PR31_BENCHMARKS_NEWS_REPAIR_LEDGER.md
```

Update `workers/ai-news/README.md` if deployment/runtime reality changes.

---

# 44. REPAIR LEDGER FORMAT

For every coherent slice:

```md
## Slice N — <name>

Start HEAD:
End HEAD:

Observed failure:
Root cause:

Files changed:

Implementation:

Tests:

Live source verification:

Cloudflare/D1 verification:

Score:

Remaining issues:

Rollback:

Commit:
```

Update the ledger as you work, not from memory at the end.

---

# 45. COMMIT / PUSH RULE

Commit coherent verified slices directly to:

```text
agent/pr30-fixes-and-updates
```

Do not create another PR.

Do not merge PR #31.

Before every commit:

```text
focused tests pass
no unrelated files included
ledger updated for the slice
secret scan clean
```

Push the commits so PR #31 updates.

---

# 46. SELF-GRADING — 100 POINTS

Grade yourself impartially after each major phase.

## Benchmark correctness — 30

- 10: Artificial Analysis is authoritative/default
- 8: top ranks/scores/variants exactly match live source
- 5: price/speed/context mapping is exact and sourced
- 4: filters/derived metrics correct
- 3: stale/failure behavior truthful

## News freshness + accuracy — 25

- 8: real Cloudflare hourly execution
- 5: 50–100 high-quality source registry
- 4: timestamps/bucketing correct
- 4: dedupe/event clustering correct
- 4: source verification accurate

## News media — 10

- 5: real thumbnails/media metadata
- 3: video behavior
- 2: safe fallback/error behavior

## Backend resilience — 15

- 5: D1 migrations + last-known-good benchmark promotion
- 4: lease/idempotency
- 3: timeout/retry/bounds
- 3: health/telemetry

## UI/UX cleanup — 8

- 3: New model comparison gone
- 2: Official provider valuations gone
- 3: benchmark/news UI matches desired metrics and freshness

## Regression/security — 5

- no unrelated systems broken;
- no secrets committed;
- no billing mutations.

## Documentation/evidence — 7

- design;
- skill;
- ledger;
- deployment/live evidence;
- commits.

### Completion threshold

For all testable in-scope requirements:

```text
100 / 100 target
0 unresolved P0
0 unresolved P1
```

Do not inflate the grade. An external X API limitation may be labeled `BLOCKED — SOURCE CAPABILITY`, but the rest of the source pipeline must still be fully verified.

If score < 100:

1. identify the lowest-scoring category;
2. fix the concrete deficiency;
3. rerun affected tests;
4. re-verify live data if necessary;
5. grade again.

---

# 47. FINAL TEST GATES

Run the repository's actual applicable commands. At minimum, where configured:

```bash
npm run typecheck
npm --prefix app run test
npm run build
```

Worker:

```bash
cd workers/ai-news
npm run typecheck
npm test
```

Also run focused benchmark/news suites and migration tests.

Run `git diff --check` and an added-line secret scan.

Do not delete/disable tests to get green.

---

# 48. REAL APP ACCEPTANCE

Launch the actual VibeSpace app.

## Benchmarks

Verify:

- page loads;
- source is Artificial Analysis;
- current #1 matches live Artificial Analysis at that time;
- score is on the Intelligence Index scale;
- top chart and table agree;
- price input/output filters work;
- cost-per-task works where available;
- price/performance works;
- speed works;
- context works;
- provider filtering works;
- effort variants remain distinct;
- no “New model comparison”;
- no “Official provider valuations”.

## News

Verify:

- backend freshness is < SLA after a successful hourly run;
- Today/Last week/More categories are correct;
- current official stories appear;
- thumbnails display where source media exists;
- fallback appears only when media is absent/broken;
- video story shows a play/video treatment;
- links open original source;
- refresh keeps last-good data on failure.

---

# 49. FINAL DEFINITION OF DONE

Do not report completion unless every applicable checkbox is proven:

```text
[ ] Artificial Analysis Intelligence Index is the default benchmark authority
[ ] Arena/Elo is not displayed as Intelligence Index
[ ] current live AA top-10 rank matches VibeSpace top-10
[ ] current live AA scores match VibeSpace scores
[ ] reasoning effort variants remain distinct
[ ] price data is current/sourced
[ ] input-price sort works
[ ] output-price sort works
[ ] cost-per-task sort works where data exists
[ ] price/performance sort works and is labeled derived
[ ] speed sort works
[ ] context sort works
[ ] old July snapshot cannot silently present as live
[ ] legacy Arena cache cannot silently present as AA
[ ] New model comparison is removed
[ ] Official provider valuations is removed

[ ] benchmark ingestion runs in Cloudflare hourly
[ ] benchmark data persists in D1
[ ] failed benchmark refresh retains last-known-good dataset
[ ] benchmark health/freshness is visible

[ ] news ingestion runs in Cloudflare hourly
[ ] deployed cron verified
[ ] latest news ingestion run verified
[ ] source registry covers roughly 50–100 high-value sources
[ ] source health is tracked
[ ] official X ingestion works when supported credentials/API exist, otherwise limitation is truthful
[ ] official blog/RSS/GitHub/YouTube fallbacks work
[ ] full publication timestamps survive end-to-end
[ ] Today/Last week/More buckets are correct
[ ] cross-post duplicates are clustered/deduped
[ ] image thumbnail metadata works
[ ] video metadata/thumbnail works
[ ] live adapter no longer hardcodes blank images
[ ] no fabricated news

[ ] Cloudflare/D1 migrations applied and verified
[ ] no production data destructively wiped
[ ] no secrets committed
[ ] Stripe untouched
[ ] unrelated Supabase untouched
[ ] normal VibeSpace Chat/RLM/agents unaffected

[ ] focused tests pass
[ ] Worker tests pass
[ ] app TypeScript passes
[ ] production build passes
[ ] real app acceptance performed
[ ] live source comparison recorded in ledger
[ ] self-grade = 100/100 for testable in-scope items
[ ] zero unresolved P0/P1
[ ] docs updated
[ ] commits pushed to PR #31
```

---

# 50. FINAL REPORT FORMAT

Return:

```md
# PR31 Benchmarks + Hourly AI News Repair

## Overall
Status:
Score:
Start HEAD:
End HEAD:
Final commit(s):

## Benchmarks
Primary source:
Current source observed at:
Top-10 parity:
Score parity:
Price parity:
Speed parity:
Refresh state:

Removed UI:
- New model comparison:
- Official provider valuations:

## News
Cron:
Last successful run:
Source count:
Sources healthy:
Sources degraded:
X status:
Today count:
Last week count:
More count:
Media coverage:
Video coverage:

## Backend
Worker deployment:
D1 migrations:
News freshness:
Benchmark freshness:

## Tests
<command> → <result>

## Live verification
Artificial Analysis → <result>
Cloudflare Worker → <result>
D1 → <result>
VibeSpace app → <result>

## Protected systems
Normal Chat:
RLM/context:
Agents:
Supabase:
Stripe:

## Blockers
None
or exact blocker with evidence.

## Documentation
- master prompt
- design
- skill
- repair ledger
```

Do not say “fully fixed” until the live backend and real VibeSpace UI agree with the current source-of-truth data.
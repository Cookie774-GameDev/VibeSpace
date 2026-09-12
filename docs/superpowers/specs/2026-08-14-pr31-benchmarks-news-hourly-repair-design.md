# PR #31 DESIGN — Live Benchmarks + Hourly AI News Architecture

## Purpose

This document defines the target architecture for repairing VibeSpace Benchmarks and AI News while keeping the work isolated from normal VibeSpace Chat, RLM/context, agents, voice, billing, and unrelated backend systems.

---

# 1. Core principle

There are two different data products:

```text
Benchmark truth
= current comparable model-evaluation data

News truth
= current source-grounded AI announcements/events
```

Never create benchmark scores from news, and never use news popularity as a benchmark ranking.

---

# 2. Benchmark authority

Default VibeSpace benchmark source:

```text
Artificial Analysis Intelligence Index
```

The app must preserve the source's scale and exact model/effort variants.

Do not substitute Arena Elo.

LMArena may exist only as a separately labeled optional dataset.

---

# 3. Backend architecture

```text
Cloudflare Cron — hourly
        ↓
Cloudflare Worker
        ├── News ingestion pipeline
        │      ↓
        │     D1
        │
        └── Benchmark ingestion pipeline
               ↓
              D1
        ↓
Public typed endpoints
        ├── /api/news
        ├── /api/benchmarks
        └── /health
        ↓
VibeSpace typed clients
        ↓
News + Benchmarks UI
```

The user's PC is not part of ingestion scheduling.

---

# 4. Benchmark dataset lifecycle

```text
fetch source
→ parse
→ normalize exact variants
→ validate
→ write candidate dataset
→ compare/anomaly-check
→ promote atomically
→ record ingestion audit
```

On failure:

```text
retain last-known-good current dataset
→ record failed/degraded ingestion
→ expose stale freshness
```

Never publish an empty or partially parsed dataset as current.

---

# 5. Benchmark row identity

Stable identity should represent the evaluated configuration, not merely the model family.

Example conceptual key:

```text
anthropic|claude-opus-5|max|adaptive-reasoning
```

Separate rows should remain separate when Artificial Analysis separates:

```text
Claude Opus 5 max
Claude Opus 5 xhigh
Claude Opus 5 high
```

---

# 6. Benchmark schema

Suggested fields:

```ts
type BenchmarkRow = {
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

  inputPricePer1MUsd?: number;
  outputPricePer1MUsd?: number;
  cacheWritePricePer1MUsd?: number;
  cacheHitPricePer1MUsd?: number;
  costPerTaskUsd?: number;

  contextWindowTokens?: number;
  openWeights?: boolean;
  releaseDate?: string;

  sourceUrl: string;
  sourceObservedAt: string;
  ingestedAt: string;
};
```

Avoid ambiguous fields such as `arena_score` for non-Arena data.

---

# 7. Benchmark filters

Required UI sorting/filtering contract:

```text
Intelligence
Cost per task
Input price
Output price
Blended price
Intelligence per dollar
Output speed
Time to first token
Context
Provider
Open/proprietary
Reasoning effort
```

Source metrics and VibeSpace-derived metrics must be visually distinguishable.

---

# 8. Derived metrics

Derived fields must use exact-row-compatible source values.

Example:

```text
intelligencePerDollar = intelligenceIndex / costPerTaskUsd
```

Only calculate when `costPerTaskUsd > 0`.

A blended input/output token price must document its formula.

Never infer cost per task from token prices without a defensible task-token model.

---

# 9. Benchmark UI cleanup

Benchmark route should directly render the leaderboard.

Remove from the route:

```text
NewsModelBenchmarkLane
New model comparison
Benchmark Scout comparison
Official provider valuations
```

Do not leave a hidden mounted comparison surface.

---

# 10. Frontend benchmark data flow

```text
last cached render (optional)
→ GET /api/benchmarks
→ schema validation
→ update live page
```

Frontend localStorage is not the benchmark authority.

Any legacy Arena cache must be versioned out so it cannot render as Artificial Analysis Intelligence Index.

---

# 11. News source architecture

Use a structured registry containing roughly 50–100 high-value official AI sources.

Sources may include:

```text
official RSS/Atom
official company news pages
official GitHub releases
official X accounts through supported API/connector
official YouTube channels
high-quality confirmed media discovery sources
```

Official sources receive higher verification priority than media aggregation.

---

# 12. Source health model

Each source should expose health independently:

```ts
type SourceHealth = {
  sourceId: string;
  status: 'healthy' | 'degraded' | 'offline' | 'disabled';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastItemAt?: string;
  consecutiveFailures: number;
  lastErrorCode?: string;
};
```

A failed X source must not fail the official blog/GitHub feed pipeline.

---

# 13. News item/event model

A canonical news event can contain multiple source references.

```ts
type NewsEvent = {
  id: string;
  title: string;
  summary: string;
  company?: string;
  modelNames: string[];
  category: string;
  publishedAt: string;
  importance: number;
  verification: 'official' | 'confirmed';

  primaryUrl: string;
  sourceRefs: NewsSourceRef[];

  media?: {
    type: 'image' | 'video';
    imageUrl?: string;
    videoUrl?: string;
    credit?: string;
    source?: string;
  };
};
```

---

# 14. Full timestamps

Keep full ISO timestamps through:

```text
source
→ worker
→ D1
→ API
→ frontend
→ bucketing/UI
```

Do not truncate to `YYYY-MM-DD`.

---

# 15. News time buckets

Recommended local-calendar contract:

```text
Today
= same local calendar date as user

Last week
= earlier than Today and within previous 7 days

More
= older than 7 days
```

Use one tested utility for all counts and feed selection.

---

# 16. Event deduplication

Cross-post event clustering should consider:

```text
canonical URL
external source ID
company
model/tool names
normalized headline
publication window
content hash
```

The same release across X/blog/YouTube should normally become one rich event with source references.

---

# 17. Media extraction priority

```text
1. official X media metadata
2. RSS/Atom media fields/enclosures
3. official YouTube thumbnail
4. Open Graph image from official source page
5. explicit VibeSpace/provider fallback
```

Only use bounded HTTPS fetches.

No arbitrary HTML execution.

No video archival into D1.

---

# 18. News frontend media flow

The live adapter must map real backend values:

```text
imageUrl
imageCredit
videoUrl
mediaType
```

The UI may fall back when the remote image fails, but must not hardcode every live image to blank.

---

# 19. Cron orchestration

One Cloudflare cron can start both independent pipelines.

```text
scheduled()
  ├── news lease/run
  └── benchmark lease/run
```

Each pipeline needs independent:

```text
lease/fencing
status
audit
freshness
failure containment
```

Cron redelivery must be idempotent.

---

# 20. Health endpoint

`/health` should expose bounded operational truth:

```json
{
  "ok": true,
  "news": {
    "freshness": "fresh",
    "lastCompletedAt": "...",
    "sourcesHealthy": 72,
    "sourcesDegraded": 5
  },
  "benchmarks": {
    "freshness": "fresh",
    "lastCompletedAt": "...",
    "source": "Artificial Analysis",
    "rowCount": 189
  }
}
```

Exact schema may follow project conventions.

No secrets/error dumps.

---

# 21. Cloudflare D1 migrations

Keep existing migrations immutable.

Add ordered migrations for:

```text
news media/source-health additions
benchmark dataset/rows/runs
```

Migration tests must execute the full sequence:

```text
0001 → 0002 → new migrations
```

Do not edit old production migration meaning after deployment.

---

# 22. Pricing authority

Use live/current source values wherever possible.

Priority:

```text
Artificial Analysis current model data
→ official provider pricing
→ unavailable
```

Do not make static regex price inference authoritative.

---

# 23. Security boundaries

Never commit:

```text
Cloudflare API token
X bearer token
Supabase secrets
Stripe secrets
cookies
Wrangler auth files
.dev.vars
.env.local
```

X credentials must be Cloudflare secrets if used.

Stripe is out of scope and must not be mutated.

---

# 24. Accuracy invariant

For the same source observation time:

```text
VibeSpace top-10 benchmark rank
== Artificial Analysis top-10 rank

VibeSpace top-10 benchmark scores
== Artificial Analysis top-10 scores
```

No approximation is allowed for primary scores.

---

# 25. Freshness invariant

A green/fresh benchmark or news state requires:

```text
successful backend ingestion within SLA
```

A successful frontend fetch of stale D1 data is not itself freshness.

---

# 26. Resilience invariant

A failed hourly run must never delete the most recent valid dataset.

```text
new run fails
→ current good data remains
→ UI shows stale/degraded
```

---

# 27. Performance principles

- bounded source concurrency;
- bounded response size;
- timeout every remote request;
- retry only transient errors;
- do not OpenGraph-fetch pages that already provided media;
- D1 batch writes;
- avoid large client-side polling loops;
- UI refetches current backend rather than re-ingesting.

---

# 28. Protected systems

No changes to:

```text
normal Chat semantics
RLM/context semantics
Jarvis voice
agents
Browser Chat
billing
Stripe
unrelated Supabase
```

Shared-code changes require focused regression evidence.

---

# 29. Completion architecture

The repaired system should ultimately behave as:

```text
Artificial Analysis + official AI sources
                ↓
        Cloudflare hourly ingestion
                ↓
             D1 truth
                ↓
        typed public API
                ↓
         VibeSpace UI
```

with separate source provenance, exact benchmark metrics, rich news media, and truthful stale/degraded behavior.
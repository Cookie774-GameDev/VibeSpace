# SKILL — PR #31 Benchmarks + Hourly AI News Repair

## Purpose

Use this skill when implementing or verifying the PR #31 benchmark/news repair. It provides the execution loop, evidence requirements, source-truth checks, and regression protections needed to avoid another stale or mislabeled leaderboard/news system.

---

# 1. Start from reality

Before edits:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
```

Confirm the PR #31 branch.

Inspect the actual Cloudflare deployment, Cron Trigger, D1 migrations/data, and Worker health. Repository configuration alone is not proof of deployment health.

---

# 2. Protected scope

Primary write scope:

```text
app/src/features/benchmarks/**
app/src/features/news/**
workers/ai-news/**
benchmark/news-specific integration files
docs for this repair
```

Shared files require explicit justification and regression testing.

Do not alter normal VibeSpace Chat, RLM/context semantics, voice, agents, Browser Chat, billing, Stripe, or unrelated Supabase systems.

---

# 3. Reproduce first

Every defect needs an observed baseline.

For Benchmarks record:

```text
visible #1 model
visible #1 score
source label
freshness label
New model comparison present?
Official provider valuations present?
```

For News record:

```text
Today count
Last week count
More count
latest displayed timestamp
latest backend run
source count
thumbnail coverage
```

Do not fix from memory.

---

# 4. Benchmark source-truth routine

At the beginning and final verification:

1. retrieve the current Artificial Analysis Intelligence Index leaderboard from a supported public/official surface;
2. record top 10 model identities, effort variants, ranks, and scores;
3. record observation timestamp/source;
4. compare VibeSpace backend rows;
5. compare rendered VibeSpace rows.

Primary benchmark PASS requires exact parity for the same observed source version.

Do not hardcode a permanent #1 model assertion because rankings change.

---

# 5. Scale guard

The default benchmark score must be on the Artificial Analysis Intelligence Index scale.

If default values suddenly resemble Arena/Elo (for example ~1000–2000), fail closed.

Automated test should protect this semantic boundary.

Never fix this by cosmetically dividing an Arena score. Fetch the correct metric.

---

# 6. Variant identity guard

Do not fold distinct source rows.

Verify exact identity includes model variant/effort where source distinguishes it.

Example failure:

```text
Claude Opus 5 max + xhigh + high
→ one generic Claude Opus 5 row
```

That is not acceptable for an exact leaderboard.

---

# 7. Benchmark promotion routine

New backend dataset:

```text
fetch
→ parse
→ validate
→ anomaly-check
→ persist candidate
→ atomically promote
```

If any critical check fails:

```text
retain last-known-good
record failed run
expose stale/degraded
```

Never publish partially parsed rows.

---

# 8. Price and performance routine

For each displayed value determine:

```text
source-reported
or
VibeSpace-derived
```

Source-reported values retain source provenance.

Derived values must document formula and use compatible exact-row inputs.

If price is not verifiable:

```text
show unavailable
```

rather than infer from model-family regex as authoritative truth.

---

# 9. UI-removal verification

After removing unwanted benchmark UI:

Search source and inspect real DOM/screenshot for:

```text
New model comparison
Benchmark Scout
Official provider valuations
```

Passing a component unit test is not enough if the real route still mounts old content through another wrapper/export.

---

# 10. Hourly backend invariant

The backend must keep running with VibeSpace closed.

Proof path:

```text
Cloudflare active deployment
+ Cron Trigger present
+ D1 ingestion audit
+ recent successful scheduled run
```

A React `setTimeout` is not proof of hourly backend ingestion.

---

# 11. News-source registry routine

Maintain a data-driven registry of roughly 50–100 high-value sources.

For each source validate:

```text
unique ID
official company identity
supported URL/type
HTTPS where applicable
no duplicate endpoint
priority
health state
```

Source count should reflect quality, not padding.

---

# 12. X-source routine

Use official X posts only through a supported authenticated API/connector.

Never solve X ingestion with:

```text
browser cookie extraction
password access
authenticated page scraping
fragile consumer HTML automation
```

When X is unavailable:

```text
X status = unavailable/degraded
other official sources continue
```

Do not claim X monitoring when the adapter is not active.

---

# 13. Timestamp routine

Preserve full ISO timestamp through every layer.

Check:

```text
source timestamp
D1 value
API value
parsed frontend value
bucket result
```

No `.slice(0, 10)` or equivalent date-only truncation for live publication timestamps.

---

# 14. Today / Last week / More routine

Use one shared tested bucket function.

Test boundaries around:

```text
local midnight
23:59 → 00:00
DST transitions where relevant
exactly 7 days
future/bad timestamps
```

Do not manually compute counts separately from the function that renders feed items.

---

# 15. Event dedupe routine

For likely duplicate official announcements compare:

```text
canonical URL
external post/video ID
company
model/tool entities
headline similarity
content hash
time window
```

Combine source references only when evidence indicates the same event.

Manually inspect a sample of dedupe decisions during final verification.

---

# 16. Media extraction routine

Preferred order:

```text
X official media
RSS/Atom media/enclosure
YouTube thumbnail
Open Graph image
explicit UI fallback
```

When Open Graph fetch is needed:

- HTTPS only;
- bounded redirects;
- bounded decoded bytes;
- timeout;
- no script execution;
- parse metadata only.

Do not fetch a source page if feed/API already supplied valid media.

---

# 17. Video routine

Do not download/clone remote videos into D1.

Store only safe metadata such as:

```text
video source URL
thumbnail URL
provider/source
```

UI shows a play/video treatment and opens the official source through the established safe external-link mechanism.

---

# 18. Source failure isolation

One bad source must not fail the whole hourly run unless there are zero usable results and the pipeline truly cannot produce a valid update.

Record per-source failure and aggregate run status:

```text
success
partial/degraded
failed
```

Retain existing data on failure.

---

# 19. Retry discipline

Remote fetch retry only for transient failures.

Use bounded:

```text
attempt count
timeout
response bytes
concurrency
overall run time
```

No infinite loops.

Respect 429/Retry-After where practical.

---

# 20. D1 migration discipline

Never rewrite deployed migration history to make tests simpler.

Add new ordered migrations.

Migration tests must run the full real sequence.

Verify schema after migration.

Use additive, non-destructive migration when preserving existing news data.

---

# 21. Cloudflare deployment routine

After local tests pass:

1. inspect current Worker/deployment;
2. apply pending migration(s);
3. deploy Worker;
4. inspect Cron Trigger;
5. verify `/health`;
6. verify `/api/news`;
7. verify `/api/benchmarks`;
8. inspect latest D1 runs;
9. confirm stale/failure fallback behavior.

Do not commit Cloudflare secrets/config-auth files.

---

# 22. Frontend benchmark verification

Real app checks:

```text
page loads
source says Artificial Analysis
score scale is correct
chart == table ordering
reasoning variants distinct
input-price sort
output-price sort
cost-per-task sort when available
price/performance sort
speed sort
context sort
provider filter
stale state
manual refresh
```

And verify unwanted sections are absent.

---

# 23. Frontend news verification

Real app checks:

```text
fresh backend state
correct Today bucket
correct Last week bucket
correct More bucket
real image renders
broken image fallback
video card/play treatment
source badge
publication time
original-source link
manual refresh
last-good feed survives network failure
```

---

# 24. Live accuracy sample

Manually inspect newest 20 news items and current top 10 benchmark rows.

For each benchmark row verify exact source parity.

For a representative news sample verify:

```text
title
company
source
verification
published time
URL
media
category
```

Document findings in the repair ledger.

---

# 25. Efficient test levels

## Level 1 — immediate

Run tests for changed parser/component.

## Level 2 — slice

Run benchmark or news integration suite.

## Level 3 — worker/backend

Run Worker + migration tests.

## Level 4 — checkpoint

Run app typecheck/build.

## Level 5 — deployment/native

Use live Cloudflare + actual VibeSpace app.

## Level 6 — final

Run all required gates once branch is coherent.

Do not rerun the entire repository after every tiny visual edit.

---

# 26. Self-grade without inflation

Examples of invalid evidence:

```text
TypeScript passed
→ therefore current leaderboard is accurate
```

No. TypeScript says nothing about data parity.

```text
wrangler.jsonc has cron
→ therefore hourly Worker is running
```

No. Verify deployed Cron and D1 run.

```text
image unit test passed
→ therefore live thumbnails exist
```

No. Inspect live items.

Score only evidence relevant to each requirement.

---

# 27. Severity

## P0

- wrong benchmark source/metric;
- false ranks/scores;
- stale data labeled live;
- destructive D1 update;
- secret leak;
- hourly backend not running.

## P1

- Today bucketing broken;
- media metadata always blank;
- important official sources systematically absent;
- source health hidden;
- price/performance mathematically wrong;
- failure replaces good data.

## P2

- cosmetic alignment;
- secondary copy;
- minor non-blocking performance issue.

Fix all P0/P1 before completion unless externally blocked.

---

# 28. Ledger discipline

After every coherent slice update:

```text
docs/operations/PR31_BENCHMARKS_NEWS_REPAIR_LEDGER.md
```

Record:

```text
start/end HEAD
root cause
changed files
tests
live source verification
Cloudflare/D1 evidence
remaining issues
score
commit
```

---

# 29. Commit discipline

Commit only coherent verified changes.

Do not include unrelated dirty files.

Push to:

```text
agent/pr30-fixes-and-updates
```

Never create a replacement PR.

Never merge PR #31.

---

# 30. Final stop condition

Do not stop because the implementation looks plausible.

Stop only when:

```text
primary benchmark top-10 parity is exact
hourly Cloudflare backend is verified
news freshness/bucketing is verified
media works
unwanted benchmark UI is gone
P0 = 0
P1 = 0
self-grade = 100/100 for testable in-scope requirements
changes pushed to PR #31
ledger complete
```

External source/API limitations must be isolated and truthfully labeled rather than used as an excuse to leave unrelated defects unfinished.
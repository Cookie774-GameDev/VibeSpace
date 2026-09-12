# Daily Dynamic Data Maintenance

**Status:** Authoritative
**Track:** LAUNCH-CRITICAL
**Last process revision:** 2026-08-02
**Machine-readable registry:** [`dynamic-data-registry.json`](./dynamic-data-registry.json)
**In-app helpers:** `app/src/lib/dynamic-data/`
**Daily check script:** `scripts/daily-dynamic-data-check.mjs`

This document is the repository’s maintenance specification for product data that becomes stale quickly: pricing, model catalogs, availability, usage limits, benchmarks, and related “current” facts.

---

## 1. Goals

1. Keep user-facing estimates honest (never present a failed refresh as “current”).
2. Prefer official APIs and vendor documentation over scraped or invented numbers.
3. Make refresh ownership, cadence, cache policy, and tests explicit per surface.
4. Automate **safe** checks daily; require human review before shipping breaking catalog changes.
5. Never fabricate daily “updates” when no verified source is available.

---

## 2. Non-negotiable rules

| Rule | Detail |
|------|--------|
| No silent current | After a refresh failure, status is `refresh_failed` / not `current`. Old prices may still display as **estimates** with an explicit warning — never as live billing. |
| No fabricated updates | Do not bump `lastUpdated` without verifying the source. |
| Official sources first | Vendor pricing pages, model list APIs, Stripe Price objects, published Arena/leaderboard APIs. |
| Breaking changes need review | Renaming/removing model ids, changing plan prices, or changing Deepgram rate constants requires PR review. |
| Estimates ≠ invoices | UI copy must say estimates; provider bills remain authoritative. |
| Snapshot ≠ live | Benchmark snapshot rows must keep `source: 'snapshot'` and must not be written into the live 1h cache. |

---

## 3. Daily process (operator checklist)

Run **once per calendar day** (or first agent session of the day on the maintenance branch):

```bash
# From repo root (worktree OK)
node scripts/daily-dynamic-data-check.mjs
cd app && npx vitest run src/lib/dynamic-data/freshness.test.ts src/lib/deepgram/catalog.test.ts
```

### Steps

1. **Run the check script** — fails if the maintenance doc/registry are missing or inconsistent, or if embedded `lastUpdated` dates are unparseable.
2. **Review stale surfaces** — script prints surfaces past their `staleAfterDays` threshold. For each:
   - Open `sourceOfTruth` URL.
   - Compare rates/ids against code.
   - If unchanged: leave data as-is; do **not** fake a new `lastUpdated` unless you re-verified the source today (optional re-verify bump is allowed only after opening the official source).
   - If changed: update module + `lastUpdated` + tests in one PR.
3. **Live refresh (safe, automatic paths only)**
   - Benchmarks page: click Refresh (live Arena/Wulong fetch). On failure, UI must show snapshot fallback, not “live current”.
   - Connected providers: open model pickers (dynamic list cache, 5 minutes).
   - Ollama: confirm installed tags via Local Models.
4. **Do not auto-commit price tables** from unattended scrapers. Scraped candidates go into a PR notes section for human review.
5. **Record outcome** in the PR or daily log:
   - Date (ISO)
   - Surfaces checked
   - Sources opened
   - Changes shipped / none
   - Any `refresh_failed` incidents

### Cadence legend

| Cadence | Meaning |
|---------|---------|
| `realtime` | Derived from live auth/connectivity; no daily table edit |
| `on_demand` | Fetch when UI opens; short TTL |
| `daily_check` | Look for vendor announcements; edit only if needed |
| `daily_live_fetch` | Prefer live API; snapshot fallback labeled |
| `daily_check_weekly_refresh` | Daily glance; full rate re-verify at least weekly |
| `weekly_*` | Weekly is enough unless a launch depends on it |
| `on_price_change_only` | Only when Stripe/site prices change |

---

## 4. Surface inventory

Each row is also in `dynamic-data-registry.json` and `app/src/lib/dynamic-data/registry.ts`.

### 4.1 Deepgram STT pricing + $10 calculator

| Field | Value |
|-------|--------|
| **UI** | Settings → Composer STT (model cards, mini cost calculator, `$10 ≈ hours`) |
| **Module** | `app/src/lib/deepgram/catalog.ts` |
| **Source of truth** | https://deepgram.com/pricing |
| **Secondary** | https://developers.deepgram.com/docs/models-languages-overview/ |
| **Owner** | STT / Composer settings |
| **Refresh cadence** | daily_check_weekly_refresh |
| **Caching** | Embedded snapshot only |
| **Stale threshold** | 90 days (`DEEPGRAM_PRICING_META`) |
| **Last-updated field** | `DEEPGRAM_PRICE_LAST_UPDATED` + UI `data-price-last-updated` |
| **Failure behavior** | `isDeepgramPriceStale` / `getDeepgramPriceFreshness({ refreshFailed: true })` → not current |
| **Test** | `app/src/lib/deepgram/catalog.test.ts` |

### 4.2 LLM token cost rates

| Field | Value |
|-------|--------|
| **UI** | Usage meters, Inspector estimated cost, provider usage |
| **Module** | `app/src/lib/ai/types.ts` (`COST_RATES`) |
| **Source of truth** | Vendor public pricing pages |
| **Owner** | AI router / usage |
| **Refresh cadence** | daily_check_on_model_change |
| **Caching** | Embedded |
| **Stale threshold** | 30 days (`COST_RATES_META`) |
| **Last-updated field** | `COST_RATES_META.lastUpdated` |
| **Failure behavior** | `estimateCostWithFreshness` sets `isCurrent: false` on stale/refresh_failed |
| **Test** | `app/src/lib/dynamic-data/freshness.test.ts` |

### 4.3 Chat model catalog (names + availability)

| Field | Value |
|-------|--------|
| **UI** | Composer picker, Agents, Schedule, Hive steps |
| **Module** | `app/src/lib/ai/models.ts`, `providerModelCatalog.ts`, `frontierModels.ts` |
| **Source of truth** | Provider model list APIs + vendor model docs |
| **Owner** | AI model selection |
| **Refresh cadence** | daily_check + on_demand dynamic listing |
| **Caching** | Static options + 5m dynamic cache |
| **Stale threshold** | 14 days for static catalog metadata |
| **Failure behavior** | Empty dynamic list; do not invent model ids |
| **Breaking review** | Required for id rename/removal |
| **Test** | `models.test.ts`, `providerModelCatalog.test.ts` |

### 4.4 Local / Ollama catalog

| Field | Value |
|-------|--------|
| **UI** | Settings → Local Models |
| **Module** | `app/src/lib/ai/localModelCatalog.ts` |
| **Source of truth** | https://ollama.com/library + local Ollama tags API |
| **Refresh cadence** | weekly_check + live installed refresh |
| **Failure behavior** | Show installed only; never claim downloadable without catalog entry |
| **Test** | `localModelCatalog.test.ts` |

### 4.5 Benchmarks / leaderboard + list prices

| Field | Value |
|-------|--------|
| **UI** | Benchmarks page |
| **Module** | `benchmarkData.ts`, `leaderboardSnapshot20260711.ts` |
| **Source of truth** | Wulong Arena API; LMArena endpoints; curated snapshot fallback |
| **Refresh cadence** | daily_live_fetch |
| **Caching** | Live 1h; snapshot never written as live |
| **Stale threshold** | 14 days row age; pricing catalog 30 days |
| **Failure behavior** | Snapshot with `source: 'snapshot'`; estimated costs marked `cost_estimated` |
| **Test** | `benchmarkData.test.ts` |

### 4.6 AI news / model-drop catalog

| Field | Value |
|-------|--------|
| **UI** | News mini-panel |
| **Module** | `app/src/features/news/newsCatalog.ts` |
| **Source of truth** | Curated items with real URLs only (offline static) |
| **Refresh cadence** | weekly_or_on_major_drop |
| **Failure behavior** | Do not invent headlines |
| **Test** | freshness registry coverage |

### 4.7 Subscription / Access pricing

| Field | Value |
|-------|--------|
| **UI** | Settings → Plans, account upgrade CTAs |
| **Module** | `app/src/features/billing/planLimits.ts` |
| **Source of truth** | Stripe Price objects + owner-approved site ledger |
| **Refresh cadence** | on_price_change_only |
| **Failure behavior** | Never auto-change user-facing plan prices |
| **Breaking review** | Always |
| **Test** | `planLimits.test.ts` |

### 4.8 Provider connectivity + usage limits

| Field | Value |
|-------|--------|
| **UI** | Providers settings, model pickers, taskbar usage |
| **Modules** | `providerRegistry.ts`, `usageService.ts`, taskbar-usage feature |
| **Source of truth** | API keys, plan entitlements, provider usage APIs |
| **Refresh cadence** | realtime / on_demand |
| **Failure behavior** | Show unavailable / missing key — never fake connected or $0 as “current usage” when fetch failed |
| **Tests** | `providerRegistry.test.ts`, `usageService.test.ts` |

### 4.9 Composer STT catalog (non-Deepgram)

| Field | Value |
|-------|--------|
| **UI** | Settings → Composer STT local providers |
| **Module** | `app/src/features/composer-stt/catalog.ts` |
| **Source of truth** | Product capability matrix |
| **Failure behavior** | Do not advertise unverified runtimes |
| **Test** | `composer-stt/catalog.test.ts` |

---

## 5. Last-updated metadata (user-facing)

| Surface | How users see it |
|---------|------------------|
| Deepgram | Footer with `deepgramPriceFreshnessFooter()` + `data-price-last-updated` |
| LLM cost rates | `COST_RATES_META` / `estimateCostWithFreshness(...).isCurrent` |
| Benchmarks | Row `fetched_at`, snapshot `SNAPSHOT_TS`, `cost_estimated` tilde prices |
| Registry | `evaluateFreshness` + `formatFreshnessFooter` for any surface |

Statuses: `current` · `stale` · `unverified` · `refresh_failed` · `snapshot_fallback`.

---

## 6. Automation vs review gate

### Safe to automate (no PR required for read-only)

- Daily check script (parse dates, inventory consistency, stale report).
- Live benchmark fetch in the running app.
- Dynamic provider model listing for connected keys.
- Ollama installed-tag discovery.

### Requires human review before ship

- Editing `COST_RATES`, Deepgram `priceUsdPerMinute`, plan prices.
- Renaming/removing model ids in `CHAT_MODEL_OPTIONS` / `HIVE_FRONTIER_MODELS`.
- Replacing the benchmark snapshot file.
- Changing Stripe-linked plan amounts.

### Explicitly forbidden automation

- Unattended scrape that rewrites prices and auto-commits.
- Bumping `lastUpdated` without opening the official source.
- Caching snapshot leaderboard rows as live.

---

## 7. Monitoring & tests

| Concern | Where |
|---------|--------|
| Parsing / unit conversion | `freshness.test.ts` (hours for $10, $/M tokens), `deepgram/catalog.test.ts` |
| Stale data | `evaluateFreshness`, `listStaleOrUnverifiedSurfaces`, Deepgram stale window |
| Failed refresh ≠ current | `getDeepgramPriceFreshness({ refreshFailed: true })`, `estimateCostWithFreshness` |
| Source / inventory drift | `scripts/daily-dynamic-data-check.mjs` + registry id list tests |
| Benchmark live vs snapshot | `benchmarkData.test.ts` |

Suggested CI hook (optional):

```yaml
- run: node scripts/daily-dynamic-data-check.mjs
- run: npx vitest run src/lib/dynamic-data/freshness.test.ts src/lib/deepgram/catalog.test.ts
```

---

## 8. Adding a new dynamic surface

1. Add entry to `docs/operations/dynamic-data-registry.json`.
2. Add matching `DynamicDataMeta` + surface in `app/src/lib/dynamic-data/registry.ts`.
3. Document the row in §4 of this file.
4. Export `lastUpdated` metadata next to the data module.
5. Wire UI footer or estimate path through `evaluateFreshness`.
6. Add/extend a focused test for conversion + stale/failure behavior.
7. Run `node scripts/daily-dynamic-data-check.mjs`.

---

## 9. Ownership

| Role | Responsibility |
|------|----------------|
| Daily operator / on-call agent | Run check script; open official sources for stale rows; open PRs for real changes |
| Feature owners | Keep module paths and tests accurate when moving code |
| Reviewer | Approve breaking catalog/price PRs |

Coordination: respect `.agent-coordination.lock/owner.txt` and `AGENT_COORDINATION.md` when editing owned modules.

---

## 10. Change log (process)

| Date | Change |
|------|--------|
| 2026-08-02 | Initial authoritative document, JSON registry, in-app freshness helpers, daily check script |

/**
 * In-app registry of dynamic data surfaces. Mirrors
 * docs/operations/dynamic-data-registry.json — keep both in sync when adding surfaces.
 */
import type { DynamicDataMeta, DynamicDataSourceKind } from './freshness';
import { evaluateFreshness, type FreshnessEvaluation } from './freshness';

export interface DynamicDataSurface extends DynamicDataMeta {
  title: string;
  uiSurfaces: readonly string[];
  module: string;
  refreshCadence: string;
  cachePolicy: string;
  failureBehavior: string;
  autoRefresh: boolean;
  breakingChangeReviewRequired: boolean;
  test: string;
  secondarySources?: readonly string[];
}

/** Embedded last-updated metadata for static catalogs (ISO dates). */
export const COST_RATES_META: DynamicDataMeta = {
  id: 'llm-cost-rates',
  lastUpdated: '2026-08-02',
  sourceUrl: 'https://openai.com/api/pricing/',
  sourceKind: 'official_docs',
  staleAfterDays: 30,
  label: 'LLM token cost rates',
};

export const CHAT_MODEL_CATALOG_META: DynamicDataMeta = {
  id: 'chat-model-catalog',
  lastUpdated: '2026-08-02',
  sourceUrl: 'https://ai.google.dev/gemini-api/docs/models',
  sourceKind: 'official_docs',
  staleAfterDays: 14,
  label: 'Chat model catalog',
};

export const LOCAL_MODEL_CATALOG_META: DynamicDataMeta = {
  id: 'local-model-catalog',
  lastUpdated: '2026-08-02',
  sourceUrl: 'https://ollama.com/library',
  sourceKind: 'official_docs',
  staleAfterDays: 30,
  label: 'Local model catalog',
};

export const BENCHMARK_PRICING_CATALOG_META: DynamicDataMeta = {
  id: 'benchmark-list-price-catalog',
  lastUpdated: '2026-07-11',
  sourceUrl: 'https://lmarena.ai/',
  sourceKind: 'embedded_snapshot',
  staleAfterDays: 30,
  label: 'Benchmark list-price catalog',
};

export const HIVE_FRONTIER_META: DynamicDataMeta = {
  id: 'hive-frontier-model-ids',
  lastUpdated: '2026-08-02',
  sourceUrl: 'docs/HIVE.md',
  sourceKind: 'embedded_snapshot',
  staleAfterDays: 30,
  label: 'Hive frontier model ids',
};

export const NEWS_CATALOG_META: DynamicDataMeta = {
  id: 'ai-news-catalog',
  lastUpdated: '2026-07-11',
  sourceUrl: 'app/src/features/news/newsCatalog.ts',
  sourceKind: 'embedded_snapshot',
  staleAfterDays: 21,
  label: 'AI news catalog',
};

export const PLAN_PRICING_META: DynamicDataMeta = {
  id: 'subscription-plan-pricing',
  lastUpdated: '2026-08-02',
  sourceUrl: 'docs/SUBSCRIPTION_PLANS_REFERENCE.md',
  sourceKind: 'official_docs',
  staleAfterDays: 365,
  label: 'Subscription plan pricing',
};

export const COMPOSER_STT_CATALOG_META: DynamicDataMeta = {
  id: 'composer-stt-catalog',
  lastUpdated: '2026-08-02',
  sourceUrl: 'app/src/features/composer-stt/catalog.ts',
  sourceKind: 'embedded_snapshot',
  staleAfterDays: 60,
  label: 'Composer STT catalog',
};

export const DEEPGRAM_PRICING_META: DynamicDataMeta = {
  id: 'deepgram-stt-pricing',
  lastUpdated: '2026-08-02',
  sourceUrl: 'https://deepgram.com/pricing',
  sourceKind: 'official_docs',
  staleAfterDays: 90,
  label: 'Deepgram STT pricing',
};

export const BENCHMARK_LEADERBOARD_META: DynamicDataMeta = {
  id: 'benchmark-leaderboard',
  lastUpdated: '2026-07-11',
  sourceUrl: 'https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text',
  sourceKind: 'live_fetch',
  staleAfterDays: 14,
  label: 'Benchmark leaderboard snapshot',
};

const SURFACE_KIND: DynamicDataSourceKind = 'embedded_snapshot';

/** Full inventory used by maintenance checks and documentation generators. */
export const DYNAMIC_DATA_SURFACES: readonly DynamicDataSurface[] = Object.freeze([
  {
    ...DEEPGRAM_PRICING_META,
    title: 'Deepgram STT pricing + $10 duration calculator',
    uiSurfaces: ['Settings → Composer STT'],
    module: 'app/src/lib/deepgram/catalog.ts',
    refreshCadence: 'daily_check_weekly_refresh',
    cachePolicy: 'embedded_snapshot_only',
    failureBehavior: 'mark_stale_do_not_label_current',
    autoRefresh: false,
    breakingChangeReviewRequired: true,
    test: 'app/src/lib/deepgram/catalog.test.ts',
    secondarySources: [
      'https://developers.deepgram.com/docs/models-languages-overview/',
    ],
  },
  {
    ...COST_RATES_META,
    title: 'LLM token cost rates',
    uiSurfaces: ['Chat usage meters', 'Inspector analytics', 'Provider usage'],
    module: 'app/src/lib/ai/types.ts',
    refreshCadence: 'daily_check_on_model_change',
    cachePolicy: 'embedded_snapshot_only',
    failureBehavior: 'mark_stale_estimates_only_never_billing',
    autoRefresh: false,
    breakingChangeReviewRequired: true,
    test: 'app/src/lib/dynamic-data/freshness.test.ts',
  },
  {
    ...CHAT_MODEL_CATALOG_META,
    title: 'Chat model catalog',
    uiSurfaces: ['Composer model picker', 'Agent manager', 'Schedule'],
    module: 'app/src/lib/ai/models.ts',
    refreshCadence: 'daily_check',
    cachePolicy: 'static_plus_dynamic_provider_cache_5m',
    failureBehavior: 'keep_last_verified_catalog_mark_stale_hide_unverified_ids',
    autoRefresh: true,
    breakingChangeReviewRequired: true,
    test: 'app/src/lib/ai/models.test.ts',
  },
  {
    id: 'provider-model-dynamic-listing',
    lastUpdated: '2026-08-02',
    sourceUrl: 'app/src/lib/ai/providerModelCatalog.ts',
    sourceKind: 'official_api' as const,
    staleAfterDays: 0,
    label: 'Live provider model listing',
    title: 'Live provider model listing cache',
    uiSurfaces: ['Provider/model selects when API key connected'],
    module: 'app/src/lib/ai/providerModelCatalog.ts',
    refreshCadence: 'on_demand',
    cachePolicy: 'memory_ttl_5m',
    failureBehavior: 'return_empty_or_static_fallback_never_invent_ids',
    autoRefresh: true,
    breakingChangeReviewRequired: false,
    test: 'app/src/lib/ai/providerModelCatalog.test.ts',
  },
  {
    ...LOCAL_MODEL_CATALOG_META,
    title: 'Local model catalog',
    uiSurfaces: ['Settings → Local Models'],
    module: 'app/src/lib/ai/localModelCatalog.ts',
    refreshCadence: 'weekly_check',
    cachePolicy: 'curated_static_plus_live_installed',
    failureBehavior: 'show_installed_only_do_not_claim_downloadable_if_unverified',
    autoRefresh: true,
    breakingChangeReviewRequired: true,
    test: 'app/src/lib/ai/localModelCatalog.test.ts',
  },
  {
    ...BENCHMARK_LEADERBOARD_META,
    sourceKind: 'live_fetch',
    title: 'Benchmark leaderboard',
    uiSurfaces: ['Benchmarks page'],
    module: 'app/src/features/benchmarks/benchmarkData.ts',
    refreshCadence: 'daily_live_fetch',
    cachePolicy: 'live_cache_1h_snapshot_fallback_never_cache_snapshot_as_live',
    failureBehavior: 'serve_snapshot_with_source_snapshot_label_not_live',
    autoRefresh: true,
    breakingChangeReviewRequired: true,
    test: 'app/src/features/benchmarks/benchmarkData.test.ts',
  },
  {
    ...BENCHMARK_PRICING_CATALOG_META,
    title: 'Benchmark list-price enrichment',
    uiSurfaces: ['Benchmarks cost columns'],
    module: 'app/src/features/benchmarks/benchmarkData.ts',
    refreshCadence: 'on_leaderboard_refresh',
    cachePolicy: 'embedded_only',
    failureBehavior: 'omit_price_rather_than_show_unverified_as_current',
    autoRefresh: false,
    breakingChangeReviewRequired: true,
    test: 'app/src/features/benchmarks/benchmarkData.test.ts',
  },
  {
    ...HIVE_FRONTIER_META,
    title: 'Hive frontier model ids',
    uiSurfaces: ['Hive stacks'],
    module: 'app/src/lib/ai/stacks/frontierModels.ts',
    refreshCadence: 'on_provider_announce',
    cachePolicy: 'embedded_only',
    failureBehavior: 'do_not_auto_rename_ids_without_review',
    autoRefresh: false,
    breakingChangeReviewRequired: true,
    test: 'app/src/lib/ai/stacks/presets.test.ts',
  },
  {
    ...NEWS_CATALOG_META,
    title: 'AI news catalog',
    uiSurfaces: ['News mini-panel'],
    module: 'app/src/features/news/newsCatalog.ts',
    refreshCadence: 'weekly_or_on_major_drop',
    cachePolicy: 'static_offline',
    failureBehavior: 'do_not_fabricate_headlines_without_source_url',
    autoRefresh: false,
    breakingChangeReviewRequired: false,
    test: 'app/src/lib/dynamic-data/freshness.test.ts',
  },
  {
    ...PLAN_PRICING_META,
    title: 'Subscription plan pricing',
    uiSurfaces: ['Settings → Plans'],
    module: 'app/src/features/billing/planLimits.ts',
    refreshCadence: 'on_price_change_only',
    cachePolicy: 'code_constants_mirror_stripe',
    failureBehavior: 'never_auto_change_user_facing_prices_without_review',
    autoRefresh: false,
    breakingChangeReviewRequired: true,
    test: 'app/src/features/billing/planLimits.test.ts',
  },
  {
    id: 'provider-connectivity-metadata',
    lastUpdated: '2026-08-02',
    sourceUrl: 'app/src/lib/ai/providerRegistry.ts',
    sourceKind: 'runtime' as const,
    staleAfterDays: 0,
    label: 'Provider connectivity',
    title: 'Provider connectivity metadata',
    uiSurfaces: ['Settings → Providers', 'Model picker'],
    module: 'app/src/lib/ai/providerRegistry.ts',
    refreshCadence: 'realtime',
    cachePolicy: 'derived_from_auth_store',
    failureBehavior: 'show_missing_key_or_offline_never_fake_connected',
    autoRefresh: true,
    breakingChangeReviewRequired: false,
    test: 'app/src/lib/ai/providerRegistry.test.ts',
  },
  {
    id: 'provider-usage-limits',
    lastUpdated: '2026-08-02',
    sourceUrl: 'app/src/lib/usage/usageService.ts',
    sourceKind: 'official_api' as const,
    staleAfterDays: 0,
    label: 'Provider usage limits',
    title: 'Provider usage / limit summaries',
    uiSurfaces: ['Taskbar usage', 'Settings usage counters'],
    module: 'app/src/lib/usage/usageService.ts',
    refreshCadence: 'on_demand',
    cachePolicy: 'short_lived_fetch',
    failureBehavior: 'show_unavailable_not_zero_as_current',
    autoRefresh: true,
    breakingChangeReviewRequired: false,
    test: 'app/src/lib/usage/usageService.test.ts',
  },
  {
    ...COMPOSER_STT_CATALOG_META,
    sourceKind: SURFACE_KIND,
    title: 'Composer STT catalog',
    uiSurfaces: ['Settings → Composer STT'],
    module: 'app/src/features/composer-stt/catalog.ts',
    refreshCadence: 'on_capability_change',
    cachePolicy: 'embedded_only',
    failureBehavior: 'do_not_advertise_unverified_runtime',
    autoRefresh: false,
    breakingChangeReviewRequired: true,
    test: 'app/src/features/composer-stt/catalog.test.ts',
  },
]);

export function getDynamicDataSurface(id: string): DynamicDataSurface | undefined {
  return DYNAMIC_DATA_SURFACES.find((surface) => surface.id === id);
}

export function evaluateAllSurfaces(
  now: Date = new Date(),
): ReadonlyArray<{ surface: DynamicDataSurface; freshness: FreshnessEvaluation }> {
  return DYNAMIC_DATA_SURFACES.map((surface) => ({
    surface,
    freshness: evaluateFreshness(surface, now),
  }));
}

/** Surfaces that must not be labeled current (stale or unverified). */
export function listStaleOrUnverifiedSurfaces(now: Date = new Date()): DynamicDataSurface[] {
  return evaluateAllSurfaces(now)
    .filter(({ freshness, surface }) => {
      if (surface.staleAfterDays === 0) return false; // realtime / on-demand
      return !freshness.isCurrent;
    })
    .map(({ surface }) => surface);
}

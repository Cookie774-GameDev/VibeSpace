/**
 * Shared freshness helpers for data that goes stale quickly (prices, catalogs,
 * benchmarks). Used by UI last-updated labels and by the daily maintenance check.
 *
 * Contract:
 *  - Never label a snapshot "current" after its stale threshold.
 *  - Never treat a failed refresh as confirming old prices.
 *  - Do not invent updates without a verified source timestamp.
 */

export type DynamicDataSourceKind =
  | 'official_docs'
  | 'official_api'
  | 'embedded_snapshot'
  | 'live_fetch'
  | 'runtime';

/** User-facing freshness status — never promote failed refresh to current. */
export type DataFreshnessStatus =
  | 'current'
  | 'stale'
  | 'unverified'
  | 'refresh_failed'
  | 'snapshot_fallback';

export interface DynamicDataMeta {
  /** Stable surface id (matches registry). */
  id: string;
  /** ISO calendar date (YYYY-MM-DD) of last human-verified update. */
  lastUpdated: string;
  /** Primary official source URL or short description. */
  sourceUrl: string;
  sourceKind: DynamicDataSourceKind;
  /** Days after lastUpdated before status becomes stale. */
  staleAfterDays: number;
  /** Optional human label for UI. */
  label?: string;
}

export interface FreshnessEvaluation {
  status: DataFreshnessStatus;
  lastUpdated: string;
  sourceUrl: string;
  staleAfterDays: number;
  /** True only when status === 'current'. */
  isCurrent: boolean;
  /** Short UI string. */
  message: string;
  /** Age in whole days (null if lastUpdated invalid). */
  ageDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse YYYY-MM-DD (or full ISO) as UTC midnight for stable age math. */
export function parseIsoDateUtc(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Prefer date-only so timezone does not shift "days since update".
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const m = Number(dateOnly[2]);
    const d = Number(dateOnly[3]);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    const ms = Date.UTC(y, m - 1, d);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export function daysBetweenUtc(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

/**
 * Evaluate whether embedded/static data may be labeled current.
 * `refreshFailed` forces refresh_failed even if the calendar age is still inside the window.
 */
export function evaluateFreshness(
  meta: DynamicDataMeta,
  now: Date = new Date(),
  options: { refreshFailed?: boolean; usingSnapshotFallback?: boolean } = {},
): FreshnessEvaluation {
  if (options.refreshFailed) {
    return {
      status: 'refresh_failed',
      lastUpdated: meta.lastUpdated,
      sourceUrl: meta.sourceUrl,
      staleAfterDays: meta.staleAfterDays,
      isCurrent: false,
      ageDays: null,
      message:
        'Refresh failed — previous values are not confirmed current. Re-verify from the official source before shipping or relying on estimates.',
    };
  }

  if (options.usingSnapshotFallback) {
    const age = ageDaysFor(meta.lastUpdated, now);
    return {
      status: 'snapshot_fallback',
      lastUpdated: meta.lastUpdated,
      sourceUrl: meta.sourceUrl,
      staleAfterDays: meta.staleAfterDays,
      isCurrent: false,
      ageDays: age,
      message: `Showing verified snapshot from ${meta.lastUpdated} (live source unavailable). Not labeled current.`,
    };
  }

  const updatedMs = parseIsoDateUtc(meta.lastUpdated);
  if (updatedMs === null) {
    return {
      status: 'unverified',
      lastUpdated: meta.lastUpdated,
      sourceUrl: meta.sourceUrl,
      staleAfterDays: meta.staleAfterDays,
      isCurrent: false,
      ageDays: null,
      message: 'Last-updated metadata is missing or invalid — do not treat values as current.',
    };
  }

  const ageDays = daysBetweenUtc(updatedMs, now.getTime());
  if (ageDays < 0) {
    return {
      status: 'unverified',
      lastUpdated: meta.lastUpdated,
      sourceUrl: meta.sourceUrl,
      staleAfterDays: meta.staleAfterDays,
      isCurrent: false,
      ageDays,
      message: 'Last-updated date is in the future — fix metadata before labeling current.',
    };
  }

  if (ageDays > meta.staleAfterDays) {
    return {
      status: 'stale',
      lastUpdated: meta.lastUpdated,
      sourceUrl: meta.sourceUrl,
      staleAfterDays: meta.staleAfterDays,
      isCurrent: false,
      ageDays,
      message: `Stale (${ageDays}d old; threshold ${meta.staleAfterDays}d). Confirm ${meta.sourceUrl} before relying on estimates.`,
    };
  }

  return {
    status: 'current',
    lastUpdated: meta.lastUpdated,
    sourceUrl: meta.sourceUrl,
    staleAfterDays: meta.staleAfterDays,
    isCurrent: true,
    ageDays,
    message: `Verified ${meta.lastUpdated} (within ${meta.staleAfterDays}-day freshness window).`,
  };
}

function ageDaysFor(lastUpdated: string, now: Date): number | null {
  const ms = parseIsoDateUtc(lastUpdated);
  if (ms === null) return null;
  return daysBetweenUtc(ms, now.getTime());
}

/** Unit conversion helpers used by cost calculators and tests. */
export function usdPerHourFromPerMinute(priceUsdPerMinute: number): number {
  if (!Number.isFinite(priceUsdPerMinute) || priceUsdPerMinute < 0) return 0;
  return priceUsdPerMinute * 60;
}

export function hoursForBudgetUsd(priceUsdPerMinute: number, budgetUsd: number): number {
  if (!Number.isFinite(priceUsdPerMinute) || priceUsdPerMinute <= 0) return 0;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return 0;
  return budgetUsd / priceUsdPerMinute / 60;
}

export function tokensPerMillionCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPerM: number,
  outputPerM: number,
): number {
  const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const inRate = Number.isFinite(inputPerM) && inputPerM >= 0 ? inputPerM : 0;
  const outRate = Number.isFinite(outputPerM) && outputPerM >= 0 ? outputPerM : 0;
  return (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
}

/** Format a short last-updated line for UI footers. */
export function formatFreshnessFooter(evaluation: FreshnessEvaluation): string {
  switch (evaluation.status) {
    case 'current':
      return `Prices/data verified ${evaluation.lastUpdated}.`;
    case 'stale':
      return `Snapshot from ${evaluation.lastUpdated} is stale — confirm official source before relying on estimates.`;
    case 'refresh_failed':
      return `Refresh failed — values from ${evaluation.lastUpdated} are not confirmed current.`;
    case 'snapshot_fallback':
      return `Live source unavailable; showing verified snapshot from ${evaluation.lastUpdated}.`;
    case 'unverified':
    default:
      return 'Data not verified current.';
  }
}

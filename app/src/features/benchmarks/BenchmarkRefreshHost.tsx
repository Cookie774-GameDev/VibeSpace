import type { BenchmarkRefreshOutcome } from './benchmarkRefresh';

export const BENCHMARK_REFRESH_COMPLETE_EVENT = 'vibespace:benchmark-refresh-complete';
export type BenchmarkRefreshCompleteEvent = CustomEvent<BenchmarkRefreshOutcome>;

/**
 * Compatibility host retained so existing app composition does not change.
 * Benchmark ingestion is now owned by the hourly Cloudflare Cron + D1 pipeline;
 * the desktop app must never run a competing local ingestion scheduler.
 */
export function BenchmarkRefreshHost() {
  return null;
}

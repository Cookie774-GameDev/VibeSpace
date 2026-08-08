import * as React from 'react';

import { startBenchmarkRefreshScheduler, type BenchmarkRefreshOutcome } from './benchmarkRefresh';

export const BENCHMARK_REFRESH_COMPLETE_EVENT = 'vibespace:benchmark-refresh-complete';

/**
 * App-wide, zero-UI scheduler host. It owns one timeout only and performs no
 * polling while waiting for the configured local wall-clock time.
 */
export function BenchmarkRefreshHost() {
  React.useEffect(() => {
    if (import.meta.env.MODE === 'test') return;
    return startBenchmarkRefreshScheduler((outcome) => {
      window.dispatchEvent(
        new CustomEvent<BenchmarkRefreshOutcome>(BENCHMARK_REFRESH_COMPLETE_EVENT, {
          detail: outcome,
        }),
      );
    });
  }, []);
  return null;
}

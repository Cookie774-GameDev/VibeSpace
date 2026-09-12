import * as React from 'react';
import { BenchmarkIntelligencePage } from './BenchmarkIntelligencePage';

/**
 * Compatibility alias retained for old imports. The news-comparison lane is
 * intentionally not mounted: the Benchmarks route now renders the authoritative
 * Artificial Analysis leaderboard directly.
 */
export function NewsAwareBenchmarksPage() {
  return <BenchmarkIntelligencePage />;
}

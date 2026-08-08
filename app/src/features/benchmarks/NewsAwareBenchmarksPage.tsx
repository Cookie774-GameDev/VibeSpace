import * as React from 'react';
import { BenchmarksPage } from './BenchmarksPage';
import { NewsModelBenchmarkLane } from './NewsModelBenchmarkLane';

/** Adds the automatic news-to-benchmark comparison lane without changing the leaderboard itself. */
export function NewsAwareBenchmarksPage() {
  return (
    <div className="min-h-full w-full">
      <NewsModelBenchmarkLane />
      <BenchmarksPage />
    </div>
  );
}

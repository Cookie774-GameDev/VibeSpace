import { describe, expect, it } from 'vitest';

import {
  OFFICIAL_BENCHMARK_EVIDENCE,
  comparableOfficialBenchmarkGroups,
} from './officialBenchmarkData';

describe('official benchmark evidence', () => {
  it('keeps every score attached to a named metric, evaluation setup, date, and provider source', () => {
    expect(OFFICIAL_BENCHMARK_EVIDENCE.length).toBeGreaterThanOrEqual(6);

    for (const evidence of OFFICIAL_BENCHMARK_EVIDENCE) {
      expect(evidence.benchmark.trim()).not.toBe('');
      expect(evidence.metric.trim()).not.toBe('');
      expect(evidence.evaluationSetup.trim()).not.toBe('');
      expect(Date.parse(evidence.publishedAt)).not.toBeNaN();
      expect(new URL(evidence.sourceUrl).protocol).toBe('https:');
      expect(evidence.reportedBy).toBe(evidence.provider);
    }
  });

  it('compares scores only when benchmark, metric, and evaluation setup are identical', () => {
    const groups = comparableOfficialBenchmarkGroups(OFFICIAL_BENCHMARK_EVIDENCE);

    expect(
      groups.every(
        (group) =>
          new Set(group.entries.map((entry) => entry.benchmark)).size === 1 &&
          new Set(group.entries.map((entry) => entry.metric)).size === 1 &&
          new Set(group.entries.map((entry) => entry.evaluationSetup)).size === 1,
      ),
    ).toBe(true);
    expect(groups.some((group) => group.entries.length >= 2)).toBe(true);
  });

  it('does not expose a synthetic universal intelligence score', () => {
    expect(
      OFFICIAL_BENCHMARK_EVIDENCE.some((entry) =>
        /universal|intelligence index|overall intelligence/iu.test(entry.benchmark),
      ),
    ).toBe(false);
  });
});

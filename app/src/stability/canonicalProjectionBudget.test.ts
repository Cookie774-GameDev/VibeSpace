import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PROJECTION_READ_CONCURRENCY,
  canonicalProjectionLimits,
} from './canonicalProjectionBudget';

describe('canonical projection budgets', () => {
  it('keeps full recent evidence for active and recoverable runs', () => {
    for (const status of [
      'queued',
      'compiling',
      'running',
      'awaiting_approval',
      'partial',
    ] as const) {
      expect(canonicalProjectionLimits(status)).toEqual({ events: 500, artifacts: 500 });
    }
  });

  it('uses a smaller recent projection for settled history without deleting records', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(canonicalProjectionLimits(status)).toEqual({ events: 100, artifacts: 100 });
    }
  });

  it('uses a bounded read fan-out suitable for large run histories', () => {
    expect(CANONICAL_PROJECTION_READ_CONCURRENCY).toBe(8);
  });
});

import type { JarvisRunStatus } from '@/lib/jarvis/contracts/execution';

export const CANONICAL_PROJECTION_READ_CONCURRENCY = 8;

const SETTLED_STATUSES = new Set<JarvisRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
const ACTIVE_LIMITS = Object.freeze({ events: 500, artifacts: 500 });
const SETTLED_LIMITS = Object.freeze({ events: 100, artifacts: 100 });

export function canonicalProjectionLimits(
  status: JarvisRunStatus,
): Readonly<{ events: number; artifacts: number }> {
  if (SETTLED_STATUSES.has(status)) {
    return SETTLED_LIMITS;
  }
  return ACTIVE_LIMITS;
}

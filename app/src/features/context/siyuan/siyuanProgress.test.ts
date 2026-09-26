import { describe, expect, it } from 'vitest';
import { createSiyuanIndexJob } from './siyuanIndexJobStore';
import {
  classifySiyuanCheckpointLiveness,
  estimateSiyuanDiscoveryProgress,
  formatSiyuanEta,
  formatSiyuanJobEta,
  SIYUAN_STALLED_CHECKPOINT_MS,
  siyuanOverallProgressPercent,
} from './siyuanProgress';

describe('SiYuan honest progress estimator', () => {
  it('distinguishes active progress from a stale running checkpoint without changing job state', () => {
    const base = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy',
    });
    const running = { ...base, status: 'running' as const, updatedAt: 10_000 };

    expect(classifySiyuanCheckpointLiveness(running, 10_000 + SIYUAN_STALLED_CHECKPOINT_MS - 1)).toBe(
      'running',
    );
    expect(classifySiyuanCheckpointLiveness(running, 10_000 + SIYUAN_STALLED_CHECKPOINT_MS)).toBe(
      'stalled',
    );
    expect(classifySiyuanCheckpointLiveness({ ...running, status: 'paused' }, 999_999)).toBe(
      'not-running',
    );
    expect(classifySiyuanCheckpointLiveness({ ...running, phase: 'completed' }, 999_999)).toBe(
      'not-running',
    );
    expect(classifySiyuanCheckpointLiveness(running, 1)).toBe('running');
    expect(classifySiyuanCheckpointLiveness({ ...running, updatedAt: Number.NaN }, 999_999)).toBe(
      'running',
    );
    expect(running.status).toBe('running');
  });

  it('stays indeterminate until it has three samples and five seconds of evidence', () => {
    let estimate = estimateSiyuanDiscoveryProgress({
      sample: { at: 0, processed: 0, discovered: 0, frontierRemaining: 1 },
    });
    estimate = estimateSiyuanDiscoveryProgress({
      previous: estimate,
      sample: { at: 2_000, processed: 10, discovered: 30, frontierRemaining: 20 },
    });
    estimate = estimateSiyuanDiscoveryProgress({
      previous: estimate,
      sample: { at: 4_999, processed: 30, discovered: 80, frontierRemaining: 30 },
    });
    expect(estimate).toMatchObject({
      determinate: false,
      approximatePercent: null,
      etaSeconds: null,
    });
  });

  it('is finite, monotonic, and capped below 100 until reconciliation completes', () => {
    let estimate = estimateSiyuanDiscoveryProgress({
      sample: { at: 1, processed: 1, discovered: 10, frontierRemaining: 9 },
    });
    for (const sample of [
      { at: 3_001, processed: 30, discovered: 100, frontierRemaining: 30 },
      { at: 6_001, processed: 70, discovered: 190, frontierRemaining: 20 },
      { at: 9_001, processed: 110, discovered: 230, frontierRemaining: 2 },
    ]) {
      const previous = estimate.approximatePercent ?? 0;
      estimate = estimateSiyuanDiscoveryProgress({ previous: estimate, sample });
      if (estimate.approximatePercent !== null) {
        expect(Number.isFinite(estimate.approximatePercent)).toBe(true);
        expect(estimate.approximatePercent).toBeGreaterThanOrEqual(previous);
        expect(estimate.approximatePercent).toBeLessThan(100);
      }
    }
    const completed = estimateSiyuanDiscoveryProgress({
      previous: estimate,
      sample: { at: 10_001, processed: 112, discovered: 230, frontierRemaining: 0 },
      completed: true,
    });
    expect(completed.approximatePercent).toBe(100);
    expect(completed.etaSeconds).toBe(0);
  });

  it('uses friendly uncertain, short, minute, and hour labels', () => {
    expect(formatSiyuanEta(null)).toBe('Estimating time…');
    expect(formatSiyuanEta(40)).toBe('Less than a minute');
    expect(formatSiyuanEta(125)).toBe('About 2 min');
    expect(formatSiyuanEta(7_200)).toBe('About 2 hr');
  });

  it('keeps persisted overall progress monotonic across phase transitions and caps stale counts', () => {
    const base = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy',
    });
    const discovering = { ...base, estimatedPercent: 18 };
    const creating = {
      ...discovering,
      phase: 'creating_nodes' as const,
      indexed: 100,
      createdNodes: 0,
      estimatedPercent: 25,
    };
    const staleBindings = { ...creating, createdNodes: 150 };
    const summarizing = {
      ...creating,
      phase: 'summarizing' as const,
      createdNodes: 100,
      summaryEligible: 10,
      summarized: 5,
      estimatedPercent: 90,
    };

    expect(siyuanOverallProgressPercent(discovering)).toBe(18);
    expect(siyuanOverallProgressPercent(creating)).toBe(25);
    expect(siyuanOverallProgressPercent(staleBindings)).toBe(90);
    expect(siyuanOverallProgressPercent(summarizing)).toBe(94);
    expect(
      siyuanOverallProgressPercent({
        ...summarizing,
        phase: 'reconciling',
        estimatedPercent: 120,
      }),
    ).toBe(99);
  });

  it('distinguishes early estimation from a later unstable recalculation', () => {
    const base = createSiyuanIndexJob({
      projectId: 'project-1',
      mapId: 'map-1',
      canonicalRoot: 'C:/root',
      policyFingerprint: 'policy',
    });
    expect(formatSiyuanJobEta(base)).toBe('Estimating time…');
    expect(
      formatSiyuanJobEta({
        ...base,
        phase: 'creating_nodes',
        indexed: 10,
        rateSamples: [
          { at: 1, processed: 1 },
          { at: 2, processed: 1 },
          { at: 3, processed: 1 },
        ],
      }),
    ).toBe('Recalculating…');
  });
});

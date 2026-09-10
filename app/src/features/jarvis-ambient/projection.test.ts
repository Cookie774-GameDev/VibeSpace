import { describe, expect, it } from 'vitest';

import type { JarvisTaskRunProjection } from '@/lib/jarvis/executionJournal/legacyTaskRunAdapter';
import { projectJarvisAmbientSnapshot } from './projection';

function run(
  status: JarvisTaskRunProjection['status'],
  updatedAt = '2026-08-30T20:00:00.000Z',
): JarvisTaskRunProjection {
  return {
    canonical: true,
    runId: `run-${status}`,
    status,
    goal: 'Test Jarvis aura',
    userVisibleSummary: status,
    progress: status === 'completed' ? 100 : 40,
    activeAgents: [],
    activeTerminals: [],
    updatedAt,
    cancellable: status === 'running',
    transportRetryAvailable: false,
  };
}

describe('projectJarvisAmbientSnapshot', () => {
  it('keeps idle asleep even while the voice control is open', () => {
    expect(
      projectJarvisAmbientSnapshot({
        revision: 7,
        observedAt: 1_000,
        voiceOpen: true,
        voiceState: 'idle',
        runs: [],
        energy: 0,
      }),
    ).toMatchObject({ state: 'idle', source: 'voice', energy: 0, active: false });
  });

  it('cannot reopen a closed Aura from late voice or task events', () => {
    for (const voiceState of ['listening', 'speaking', 'thinking', 'error'] as const) {
      expect(
        projectJarvisAmbientSnapshot({
          revision: 8,
          observedAt: 1_000,
          voiceOpen: false,
          voiceState,
          runs: [run('running')],
          energy: 0.9,
        }),
      ).toMatchObject({ active: false, energy: 0 });
    }
  });

  it('applies needs, error, speaking, listening, working, done, idle priority', () => {
    const base = { revision: 7, observedAt: 1_000, energy: 0.4 };
    expect(
      projectJarvisAmbientSnapshot({
        ...base,
        voiceState: 'speaking',
        runs: [run('failed'), run('waiting-for-approval')],
      }).state,
    ).toBe('needs');
    expect(
      projectJarvisAmbientSnapshot({ ...base, voiceState: 'speaking', runs: [run('failed')] })
        .state,
    ).toBe('error');
    expect(
      projectJarvisAmbientSnapshot({ ...base, voiceState: 'speaking', runs: [run('running')] })
        .state,
    ).toBe('speaking');
    expect(
      projectJarvisAmbientSnapshot({ ...base, voiceState: 'listening', runs: [run('running')] })
        .state,
    ).toBe('listening');
    expect(
      projectJarvisAmbientSnapshot({ ...base, voiceState: 'thinking', runs: [run('running')] })
        .state,
    ).toBe('working');
    expect(
      projectJarvisAmbientSnapshot({ ...base, voiceState: 'idle', runs: [run('completed')] }).state,
    ).toBe('done');
    expect(projectJarvisAmbientSnapshot({ ...base, voiceState: 'idle', runs: [] }).state).toBe(
      'idle',
    );
  });

  it('clamps and quantizes energy only for listening and speaking', () => {
    expect(
      projectJarvisAmbientSnapshot({
        revision: 1,
        observedAt: 10,
        voiceState: 'listening',
        runs: [],
        energy: 1.8,
      }).energy,
    ).toBe(1);
    expect(
      projectJarvisAmbientSnapshot({
        revision: 2,
        observedAt: 11,
        voiceState: 'speaking',
        runs: [],
        energy: 0.456,
      }).energy,
    ).toBe(0.46);
    expect(
      projectJarvisAmbientSnapshot({
        revision: 3,
        observedAt: 12,
        voiceState: 'thinking',
        runs: [],
        energy: 0.9,
      }).energy,
    ).toBe(0);
  });

  it('expires completed state after the fixed 1.7 second window', () => {
    const completed = run('completed', '2026-08-30T20:00:00.000Z');
    expect(
      projectJarvisAmbientSnapshot({
        revision: 1,
        observedAt: Date.parse('2026-08-30T20:00:01.699Z'),
        voiceState: 'idle',
        runs: [completed],
        energy: 0,
      }).state,
    ).toBe('done');
    expect(
      projectJarvisAmbientSnapshot({
        revision: 2,
        observedAt: Date.parse('2026-08-30T20:00:01.701Z'),
        voiceState: 'idle',
        runs: [completed],
        energy: 0,
      }).state,
    ).toBe('idle');
  });
});

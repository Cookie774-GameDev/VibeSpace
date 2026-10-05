import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SECOND_BRAIN_CONFIG,
  NightlySecondBrainRunner,
  buildNightlySecondBrainWeek,
  isNightlySecondBrainRunDue,
  manualSecondBrainScheduledFor,
  nextNightlySecondBrainRun,
  mostRecentNightlySecondBrainRun,
  successfulSecondBrainCoverage,
  secondBrainSourceBatch,
  type SecondBrainChange,
  type SecondBrainSource,
} from './nightlySecondBrain';

const model = {
  id: 'ollama:qwen',
  label: 'Qwen local',
  local: true,
  provider: 'ollama',
  modelId: 'qwen',
};
const sources: SecondBrainSource[] = [
  { id: 'chat:1', kind: 'chat', content: 'Use Rust.', observedAt: 1, privateLocal: false },
  { id: 'terminal:1', kind: 'terminal', content: 'secret', observedAt: 2, privateLocal: true },
];
const change: SecondBrainChange = {
  id: 'change:1',
  target: 'context_map',
  path: 'Architecture.md',
  before: '',
  after: 'The project uses Rust.',
  provenance: ['chat:1'],
  confidence: 0.95,
};

describe('nightly second-brain maintenance', () => {
  it('processes a bounded chronological prefix without skipping the remaining history', () => {
    const history = [
      { ...sources[0]!, observedAt: 11, content: 'a'.repeat(50) },
      { ...sources[0]!, id: 'chat:2', observedAt: 12, content: 'b'.repeat(50) },
      { ...sources[0]!, id: 'chat:3', observedAt: 13, content: 'c'.repeat(20) },
    ];
    const first = secondBrainSourceBatch(history, { start: 10, end: 20 }, 100);
    expect(first).toEqual({ sources: history.slice(0, 2), coverageEnd: 12, remaining: 1 });
    expect(secondBrainSourceBatch(history, { start: first.coverageEnd, end: 20 }, 100)).toEqual({
      sources: [history[2]],
      coverageEnd: 20,
      remaining: 0,
    });
    expect(() =>
      secondBrainSourceBatch(
        history.map((source) => ({ ...source, observedAt: 11 })),
        { start: 10, end: 20 },
        100,
      ),
    ).toThrow('Coverage was preserved');
  });

  it('commits the processed prefix while leaving the current cutoff due for catch-up', async () => {
    const collectSources = async () => ({ sources: [sources[0]!], coverageEnd: 10, remaining: 1 });
    const runner = new NightlySecondBrainRunner({
      collectSources,
      propose: async () => [change],
      apply: vi.fn(),
      rollback: vi.fn(),
      saveRun: vi.fn(),
    });
    const run = await runner.run({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, mode: 'auto', model },
      scheduledFor: 20,
      now: 20,
    });
    expect(run.status).toBe('applied');
    expect(run.coverageEnd).toBe(10);
    expect(successfulSecondBrainCoverage([run])).toBe(10);
    expect(run.summary).toContain('More saved activity remains');
  });
  it('uses the selected local time and weekdays when recovering a missed run', () => {
    const schedule = { scheduleHour: 3, scheduleMinute: 15, scheduleDays: [1, 5] };
    const thursday = new Date(2026, 9, 8, 12);
    expect(mostRecentNightlySecondBrainRun(thursday, schedule)).toEqual(
      new Date(2026, 9, 5, 3, 15),
    );
    expect(nextNightlySecondBrainRun(thursday, schedule)).toEqual(new Date(2026, 9, 9, 3, 15));
    expect(nextNightlySecondBrainRun(new Date(2026, 9, 9, 3, 15), schedule)).toEqual(
      new Date(2026, 9, 12, 3, 15),
    );
  });

  it('advances coverage only for durably applied runs and preserves the collection cutoff', () => {
    const base = {
      id: 'covered',
      scheduledFor: 100,
      startedAt: 110,
      completedAt: 150,
      mode: 'auto' as const,
      model,
      changes: [],
      summary: 'Saved',
      coverageStart: 0,
      coverageEnd: 110,
    };
    expect(successfulSecondBrainCoverage([{ ...base, status: 'pending_approval' }])).toBe(0);
    expect(successfulSecondBrainCoverage([{ ...base, status: 'failed' }])).toBe(0);
    expect(successfulSecondBrainCoverage([{ ...base, status: 'applied' }])).toBe(110);
    expect(successfulSecondBrainCoverage([{ ...base, status: 'rolled_back' }])).toBe(0);
  });

  it('collects the fixed coverage interval and records it only after an actual apply', async () => {
    const collectSources = vi
      .fn()
      .mockResolvedValue(
        sources.map((source) => ({ ...source, observedAt: source.observedAt + 10 })),
      );
    const saveRun = vi.fn();
    const runner = new NightlySecondBrainRunner({
      collectSources,
      propose: async () => [change],
      apply: vi.fn().mockRejectedValue(new Error('disk full')),
      rollback: vi.fn(),
      saveRun,
    });
    const run = await runner.run({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, mode: 'auto', model },
      scheduledFor: 100,
      now: 120,
      coverageStart: 10,
    });
    expect(collectSources).toHaveBeenCalledWith({ start: 10, end: 120 });
    expect(run.status).toBe('failed');
    expect(successfulSecondBrainCoverage([run])).toBe(0);
  });

  it('preserves private history when a cloud model has no data permission', async () => {
    const propose = vi.fn();
    const runner = new NightlySecondBrainRunner({
      collectSources: async () => sources.filter((source) => source.privateLocal),
      propose,
      apply: vi.fn(),
      rollback: vi.fn(),
      saveRun: vi.fn(),
    });
    const run = await runner.run({
      config: {
        ...DEFAULT_SECOND_BRAIN_CONFIG,
        enabled: true,
        mode: 'auto',
        model: { ...model, local: false },
      },
      scheduledFor: 100,
    });
    expect(run.status).toBe('failed');
    expect(propose).not.toHaveBeenCalled();
    expect(successfulSecondBrainCoverage([run])).toBe(0);
  });
  it('buckets repeated manual requests into one canonical minute', () => {
    expect(manualSecondBrainScheduledFor(Date.parse('2026-08-09T12:34:59.999Z'))).toBe(
      Date.parse('2026-08-09T12:34:00.000Z'),
    );
  });

  it('always schedules 2 a.m. and detects a missed run after app restart', () => {
    expect(nextNightlySecondBrainRun(new Date(2026, 7, 2, 1, 30)).getHours()).toBe(2);
    expect(nextNightlySecondBrainRun(new Date(2026, 7, 2, 3)).getDate()).toBe(3);
    expect(
      isNightlySecondBrainRunDue({
        now: new Date(2026, 7, 2, 8),
        lastScheduledFor: new Date(2026, 7, 1, 2).getTime(),
      }),
    ).toBe(true);
  });

  it('builds a rolling seven-day schedule with recorded and future runs', () => {
    const now = new Date(2026, 7, 4, 10).getTime();
    const yesterday = new Date(2026, 7, 3, 2).getTime();
    const week = buildNightlySecondBrainWeek(
      now,
      [
        {
          id: 'run-1',
          scheduledFor: yesterday,
          startedAt: yesterday,
          completedAt: yesterday + 1_000,
          status: 'applied',
          mode: 'auto',
          model,
          changes: [],
          summary: 'Checked project activity.',
        },
      ],
      true,
    );

    expect(week).toHaveLength(7);
    expect(week.flatMap((day) => day.runs).find((run) => run.id === 'run-1')?.status).toBe(
      'applied',
    );
    expect(week.some((day) => day.runs.some((run) => run.status === 'scheduled'))).toBe(true);
  });

  it('keeps private local sources away from cloud models without explicit permission', async () => {
    const propose = vi.fn().mockResolvedValue([change]);
    const runner = new NightlySecondBrainRunner({
      collectSources: async () => sources,
      propose,
      apply: vi.fn(),
      rollback: vi.fn(),
      saveRun: vi.fn(),
    });
    await runner.run({
      config: {
        ...DEFAULT_SECOND_BRAIN_CONFIG,
        enabled: true,
        model: { ...model, local: false },
      },
      scheduledFor: 100,
      now: 100,
    });
    expect(
      propose.mock.calls[0]?.[0].sources.map((source: SecondBrainSource) => source.id),
    ).toEqual(['chat:1']);
  });

  it('deduplicates low-value changes, supports approval, rollback, and auto mode', async () => {
    const apply = vi.fn();
    const rollback = vi.fn();
    const saveRun = vi.fn();
    const runner = new NightlySecondBrainRunner({
      collectSources: async () => sources,
      propose: async () => [
        change,
        { ...change, id: 'duplicate' },
        { ...change, id: 'low', after: 'Uncertain.', confidence: 0.2 },
      ],
      apply,
      rollback,
      saveRun,
    });
    const pending = await runner.run({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model },
      scheduledFor: 100,
      now: 100,
    });
    expect(pending.status).toBe('pending_approval');
    expect(pending.changes).toHaveLength(1);
    const applied = await runner.approve(pending);
    expect(apply).toHaveBeenCalledWith([change]);
    expect((await runner.rollback(applied)).status).toBe('rolled_back');
    expect(rollback).toHaveBeenCalled();

    await runner.run({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model, mode: 'auto' },
      scheduledFor: 200,
      now: 200,
    });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('performs zero approval-mode writes until approval and records the managed snapshot receipt', async () => {
    const appliedChange = { ...change, backend: 'siyuan' as const, targetBlockId: 'block-1' };
    const apply = vi.fn().mockResolvedValue({
      changes: [appliedChange],
      snapshotCreated: true,
    });
    const runner = new NightlySecondBrainRunner({
      collectSources: async () => sources,
      propose: async () => [change],
      apply,
      rollback: vi.fn(),
      saveRun: vi.fn(),
    });

    const pending = await runner.run({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model },
      scheduledFor: 300,
      now: 300,
    });
    expect(pending.status).toBe('pending_approval');
    expect(pending.snapshotCreated).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();

    const applied = await runner.approve(pending);
    expect(applied.snapshotCreated).toBe(true);
    expect(applied.changes[0].targetBlockId).toBe('block-1');
    expect(applied.summary).toContain('repository snapshot was created first');
  });

  it('records failure for morning recovery without applying partial changes', async () => {
    const apply = vi.fn();
    const saveRun = vi.fn();
    const runner = new NightlySecondBrainRunner({
      collectSources: async () => {
        throw new Error('index unavailable');
      },
      propose: vi.fn(),
      apply,
      rollback: vi.fn(),
      saveRun,
    });
    const run = await runner.run({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model },
      scheduledFor: 100,
    });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('index unavailable');
    expect(apply).not.toHaveBeenCalled();
    expect(saveRun).toHaveBeenCalledWith(run);
  });
});

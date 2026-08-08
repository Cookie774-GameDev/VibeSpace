import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SECOND_BRAIN_CONFIG,
  NightlySecondBrainRunner,
  buildNightlySecondBrainWeek,
  isNightlySecondBrainRunDue,
  nextNightlySecondBrainRun,
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

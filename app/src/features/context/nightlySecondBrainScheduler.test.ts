import { describe, expect, it, vi } from 'vitest';
import { NightlySecondBrainScheduler } from './nightlySecondBrainScheduler';

describe('NightlySecondBrainScheduler', () => {
  it('recovers one missed 2 a.m. run and uses one long-lived timer', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const setTimer = vi.fn().mockReturnValue(7);
    const scheduler = new NightlySecondBrainScheduler({
      now: () => new Date(2026, 7, 2, 8),
      lastScheduledFor: () => new Date(2026, 7, 1, 2).getTime(),
      run,
      setTimer,
      clearTimer: vi.fn(),
    });
    scheduler.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(new Date(2026, 7, 2, 2).getTime()));
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBeGreaterThan(60_000);
    scheduler.stop();
  });

  it('does not run twice while already caught up', async () => {
    const run = vi.fn();
    const scheduler = new NightlySecondBrainScheduler({
      now: () => new Date(2026, 7, 2, 8),
      lastScheduledFor: () => new Date(2026, 7, 2, 2).getTime(),
      run,
      setTimer: vi.fn().mockReturnValue(9),
      clearTimer: vi.fn(),
    });
    scheduler.start();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    scheduler.stop();
  });
});

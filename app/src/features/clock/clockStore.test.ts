import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireDueClockEntries } from './clockEngine';
import { clampTimerDurationMs, parseAlarmTime, useClockStore } from './clockStore';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/tauri', () => ({
  notify: vi.fn(async () => undefined),
}));

vi.mock('./clockSound', () => ({
  playClockSound: vi.fn(),
}));

describe('clock store', () => {
  beforeEach(() => {
    useClockStore.setState({ entries: [] });
    vi.clearAllMocks();
  });

  it('clamps timer duration to safe bounds', () => {
    expect(clampTimerDurationMs(-1)).toBe(1000);
    expect(clampTimerDurationMs(1500.4)).toBe(1500);
    expect(clampTimerDurationMs(9 * 24 * 60 * 60 * 1000)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses local alarm times and rolls past times to tomorrow', () => {
    const now = new Date('2026-06-04T10:30:00').getTime();
    expect(new Date(parseAlarmTime('11:15', now)!).getHours()).toBe(11);
    const tomorrow = new Date(parseAlarmTime('9:00', now)!);
    expect(tomorrow.getDate()).toBe(new Date(now).getDate() + 1);
    expect(parseAlarmTime('not a time', now)).toBeNull();
  });

  it('fires due scheduled entries once', async () => {
    const now = 100_000;
    const entry = useClockStore.getState().createTimer({ durationMs: 1000, label: 'Test timer', now });
    const fired = await fireDueClockEntries(now + 1000);
    const secondPass = await fireDueClockEntries(now + 2000);
    expect(fired).toBe(1);
    expect(secondPass).toBe(0);
    expect(useClockStore.getState().entries.find((item) => item.id === entry.id)?.status).toBe('fired');
  });
});

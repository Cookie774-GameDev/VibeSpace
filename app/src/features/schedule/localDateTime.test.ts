import { describe, expect, it } from 'vitest';
import {
  defaultEventEndMs,
  defaultEventStartMs,
  formatLocalDayHeading,
  fromLocalDateTimeInput,
  localDayKey,
  toLocalDateTimeInput,
} from './localDateTime';

describe('localDateTime', () => {
  it('round-trips datetime-local in local wall clock', () => {
    const ms = new Date(2026, 5, 18, 14, 30, 0, 0).getTime();
    const input = toLocalDateTimeInput(ms);
    expect(input).toBe('2026-06-18T14:30');
    expect(fromLocalDateTimeInput(input)).toBe(ms);
  });

  it('parses local components without UTC shift', () => {
    const ms = fromLocalDateTimeInput('2026-01-15T09:00');
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it.each([
    '2026-02-30T09:00',
    '2026-13-01T09:00',
    '2026-06-18T24:00',
    '2026-06-18T10:60',
  ])('rejects an invalid local date or time: %s', (input) => {
    expect(fromLocalDateTimeInput(input)).toBeNaN();
  });

  it('rejects a local time skipped by daylight saving time', () => {
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = 'America/Chicago';
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Chicago');
      expect(fromLocalDateTimeInput('2026-03-08T02:30')).toBeNaN();
      expect(Number.isFinite(fromLocalDateTimeInput('2026-03-08T03:30'))).toBe(true);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it('labels today and tomorrow from local midnight', () => {
    const now = new Date(2026, 5, 18, 10, 0, 0, 0).getTime();
    expect(formatLocalDayHeading(now, now)).toBe('Today');
    const tomorrow = new Date(2026, 5, 19, 8, 0, 0, 0).getTime();
    expect(formatLocalDayHeading(tomorrow, now)).toBe('Tomorrow');
  });

  it('default start is next local hour', () => {
    const now = new Date(2026, 5, 18, 10, 45, 0, 0).getTime();
    const start = defaultEventStartMs(now);
    expect(new Date(start).getHours()).toBe(11);
    expect(new Date(start).getMinutes()).toBe(0);
    expect(defaultEventEndMs(start)).toBe(start + 60 * 60 * 1000);
  });

  it('localDayKey uses local calendar date', () => {
    const ms = new Date(2026, 0, 2, 23, 30, 0, 0).getTime();
    expect(localDayKey(ms)).toBe('2026-01-02');
  });
});

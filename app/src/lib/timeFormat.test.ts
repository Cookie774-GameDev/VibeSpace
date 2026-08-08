import { afterEach, describe, expect, it } from 'vitest';
import {
  AMBIENT_IDLE_PRESETS_MIN,
  bindClockFormatReader,
  formatAmbientClockParts,
  formatUserDateTime,
  formatUserTime,
  hour12ForFormat,
  isClockFormat,
  normalizeClockFormat,
  resolveClockFormat,
  timeFormatOptions,
} from './timeFormat';

const AFTERNOON = new Date(2026, 5, 18, 14, 30, 45, 0); // 2:30:45 PM local
const DST_SPRING = new Date(2026, 2, 8, 3, 15, 0, 0); // around US spring-forward window (local)
const DST_FALL = new Date(2026, 10, 1, 1, 30, 0, 0); // around US fall-back window (local)

describe('timeFormat', () => {
  afterEach(() => {
    bindClockFormatReader(() => 'local');
  });

  it('exposes 30/60/90 minute idle presets among the ambient choices', () => {
    const values = AMBIENT_IDLE_PRESETS_MIN.map((p) => p.value);
    expect(values).toContain(30);
    expect(values).toContain(60);
    expect(values).toContain(90);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('normalizes clock format values', () => {
    expect(isClockFormat('local')).toBe(true);
    expect(isClockFormat('military')).toBe(true);
    expect(isClockFormat('24h')).toBe(false);
    expect(normalizeClockFormat('military')).toBe('military');
    expect(normalizeClockFormat('nope')).toBe('local');
    expect(normalizeClockFormat(undefined)).toBe('local');
  });

  it('forces hour12 false for military and leaves local to the locale', () => {
    expect(hour12ForFormat('military')).toBe(false);
    expect(hour12ForFormat('local')).toBeUndefined();
    expect(timeFormatOptions('military').hour12).toBe(false);
    expect(timeFormatOptions('local').hour12).toBeUndefined();
  });

  it('formats military time as 24-hour regardless of locale', () => {
    const time = formatUserTime(AFTERNOON, { format: 'military', locale: 'en-US' });
    expect(time).toMatch(/14:30/);
    expect(time).not.toMatch(/PM|AM/i);

    const withSeconds = formatUserTime(AFTERNOON, {
      format: 'military',
      locale: 'en-US',
      seconds: true,
    });
    expect(withSeconds).toMatch(/14:30:45/);
  });

  it('formats local time with locale-default hour cycle (12h for en-US)', () => {
    const time = formatUserTime(AFTERNOON, { format: 'local', locale: 'en-US' });
    expect(time).toMatch(/2:30/);
    expect(time).toMatch(/PM/i);
    expect(time).not.toMatch(/^14:/);
  });

  it('formats date-times without mutating the source timestamp', () => {
    const ms = AFTERNOON.getTime();
    const before = ms;
    const label = formatUserDateTime(ms, {
      format: 'military',
      locale: 'en-US',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    expect(label).toMatch(/Jun/);
    expect(label).toMatch(/14:30/);
    expect(ms).toBe(before);
    expect(new Date(ms).getTime()).toBe(before);
  });

  it('reads the bound store preference for presentation helpers', () => {
    bindClockFormatReader(() => 'military');
    expect(resolveClockFormat()).toBe('military');
    expect(formatUserTime(AFTERNOON, { locale: 'en-US' })).toMatch(/14:30/);

    bindClockFormatReader(() => 'local');
    expect(resolveClockFormat()).toBe('local');
    expect(formatUserTime(AFTERNOON, { locale: 'en-US' })).toMatch(/PM/i);
  });

  it('builds ambient clock parts for both formats', () => {
    const military = formatAmbientClockParts(AFTERNOON, 'military');
    expect(military.h).toBe('14');
    expect(military.m).toBe('30');
    expect(military.period).toBeNull();
    expect(military.date.length).toBeGreaterThan(0);

    const local = formatAmbientClockParts(AFTERNOON, 'local');
    expect(local.m).toBe('30');
    // en-* locales typically yield 2 (or 02) + PM for 14:30
    expect(Number(local.h)).toBe(2);
  });

  it('formats across daylight-saving transition wall times without shifting stored ms', () => {
    for (const d of [DST_SPRING, DST_FALL]) {
      const ms = d.getTime();
      const military = formatUserTime(ms, { format: 'military', locale: 'en-US' });
      const local = formatUserTime(ms, { format: 'local', locale: 'en-US' });
      // Presentation only — epoch value stays identical
      expect(new Date(ms).getTime()).toBe(ms);
      expect(military.length).toBeGreaterThan(0);
      expect(local.length).toBeGreaterThan(0);
      // Hours come from the Date's local getters (system TZ), not UTC rewrite
      const expectedHour = d.getHours().toString().padStart(2, '0');
      const expectedMin = d.getMinutes().toString().padStart(2, '0');
      expect(military).toContain(`${expectedHour}:${expectedMin}`);
    }
  });
});

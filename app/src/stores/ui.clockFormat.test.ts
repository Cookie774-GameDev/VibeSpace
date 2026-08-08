import { beforeEach, describe, expect, it } from 'vitest';
import { mergePersistedUiState, useUIStore } from './ui';
import { AMBIENT_IDLE_PRESETS_MIN, formatUserTime, resolveClockFormat } from '@/lib/timeFormat';

describe('UI store clock format + ambient idle thresholds', () => {
  beforeEach(() => {
    useUIStore.getState().resetUI();
  });

  it('defaults to local clock format and persists military when set', () => {
    expect(useUIStore.getState().clockFormat).toBe('local');
    expect(resolveClockFormat()).toBe('local');

    useUIStore.getState().setClockFormat('military');
    expect(useUIStore.getState().clockFormat).toBe('military');
    expect(resolveClockFormat()).toBe('military');

    const afternoon = new Date(2026, 5, 18, 14, 30, 0, 0).getTime();
    expect(formatUserTime(afternoon, { locale: 'en-US' })).toMatch(/14:30/);
  });

  it('rejects invalid clock formats via setter and merge', () => {
    useUIStore.getState().setClockFormat('military');
    // @ts-expect-error intentional bad value
    useUIStore.getState().setClockFormat('banana');
    expect(useUIStore.getState().clockFormat).toBe('local');

    const current = useUIStore.getState();
    const merged = mergePersistedUiState({ theme: 'default', clockFormat: 'nope' }, current);
    expect(merged.clockFormat).toBe('local');

    const mergedMilitary = mergePersistedUiState(
      { theme: 'default', clockFormat: 'military' },
      current,
    );
    expect(mergedMilitary.clockFormat).toBe('military');
  });

  it('accepts 30/60/90 minute ambient idle thresholds used by idle detection', () => {
    for (const preset of AMBIENT_IDLE_PRESETS_MIN) {
      if (![30, 60, 90].includes(preset.value)) continue;
      const ms = preset.value * 60_000;
      useUIStore.getState().setAmbientThresholdMs(ms);
      expect(useUIStore.getState().ambientThresholdMs).toBe(ms);
    }
  });

  it('keeps ambient threshold floor and does not rewrite timestamps when format flips', () => {
    const stored = 1_700_000_000_000;
    useUIStore.getState().setClockFormat('local');
    const localLabel = formatUserTime(stored, { locale: 'en-US' });
    useUIStore.getState().setClockFormat('military');
    const militaryLabel = formatUserTime(stored, { locale: 'en-US' });
    expect(localLabel).not.toBe(militaryLabel);
    expect(stored).toBe(1_700_000_000_000);

    useUIStore.getState().setAmbientThresholdMs(1_000);
    expect(useUIStore.getState().ambientThresholdMs).toBe(15_000);
  });
});

import { describe, it, expect } from 'vitest';
import { stepsForPreset, VIBE_HIVE_LABELS, pickProviderFallback } from './presets';
import { FRONTIER } from './frontierModels';

describe('stepsForPreset', () => {
  it('returns empty for off', () => {
    expect(stepsForPreset('off', 'general')).toEqual([]);
  });

  it('returns one step for fast', () => {
    expect(stepsForPreset('fast', 'general')).toHaveLength(1);
  });

  it('returns two steps for balanced', () => {
    expect(stepsForPreset('balanced', 'general')).toHaveLength(2);
  });

  it('returns three steps for quality', () => {
    expect(stepsForPreset('quality', 'general')).toHaveLength(3);
  });

  it('quality uses frontier opus and gpt-5.5', () => {
    const steps = stepsForPreset('quality', 'general');
    expect(steps[0]?.model).toBe(FRONTIER.anthropic_opus);
    expect(steps[1]?.model).toBe(FRONTIER.openai_flagship);
    expect(steps[2]?.model).toBe(FRONTIER.google_flash);
  });

  it('uses code override for balanced code tasks', () => {
    const steps = stepsForPreset('balanced', 'code');
    expect(steps[0]?.label).toBe('Plan');
    expect(steps[1]?.label).toBe('Review');
  });
});

describe('VIBE_HIVE_LABELS', () => {
  it('has Vibe Hive branded labels', () => {
    expect(VIBE_HIVE_LABELS.fast).toBe('Vibe Hive Fast');
    expect(VIBE_HIVE_LABELS.quality).toBe('Vibe Hive Quality');
    expect(VIBE_HIVE_LABELS.off).toBe('Single model');
  });
});

describe('pickProviderFallback', () => {
  it('keeps step when provider available', () => {
    const step = stepsForPreset('fast', 'general')[0]!;
    expect(pickProviderFallback(step, ['google', 'groq']).provider).toBe('google');
  });

  it('falls back to first available cloud provider', () => {
    const step = stepsForPreset('quality', 'general')[0]!;
    const picked = pickProviderFallback(step, ['groq', 'google']);
    expect(picked.provider).toBe('google');
  });
});

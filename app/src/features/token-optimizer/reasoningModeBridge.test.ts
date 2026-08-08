import { describe, expect, it } from 'vitest';
import { reasoningPreferenceForOptimization } from './reasoningModeBridge';

describe('reasoningPreferenceForOptimization', () => {
  it.each([
    ['saver', 'token-saver'],
    ['normal', 'normal'],
    ['final_boss', 'token-final-boss'],
  ] as const)('maps %s to the matching provider-neutral reasoning mode', (mode, expected) => {
    expect(
      reasoningPreferenceForOptimization(mode, {
        mode: 'normal',
        effortOverride: null,
      }),
    ).toEqual({ mode: expected, effortOverride: null });
  });

  it('preserves explicit effort and leaves the off-state unchanged', () => {
    const preference = { mode: 'token-final-boss' as const, effortOverride: 'high' as const };
    expect(reasoningPreferenceForOptimization('off', preference)).toBe(preference);
    expect(reasoningPreferenceForOptimization('saver', preference)).toEqual({
      mode: 'token-saver',
      effortOverride: 'high',
    });
  });
});

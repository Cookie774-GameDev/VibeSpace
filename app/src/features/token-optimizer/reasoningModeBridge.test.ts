import { describe, expect, it } from 'vitest';
import { reasoningPreferenceForOptimization } from './reasoningModeBridge';
import { resolveReasoningPolicy } from '@/lib/ai/reasoningControls';

describe('reasoningPreferenceForOptimization', () => {
  it('clears stale Saver policy when optimization is switched off without changing effort', () => {
    expect(reasoningPreferenceForOptimization('off', {
      mode: 'token-saver', effortOverride: 'high',
    })).toEqual({ mode: 'normal', effortOverride: 'high' });
    const policy = resolveReasoningPolicy({
      selection: { providerId: 'openai', modelId: 'gpt-5.6-luna', connectionId: 'openai-codex' },
      preference: reasoningPreferenceForOptimization('off', {
        mode: 'token-saver', effortOverride: 'high',
      }),
    });
    expect(policy.maxOutputTokens).toBeUndefined();
    expect(policy.resolvedEffort).toBe('high');
    expect(policy.executionInstructions).not.toContain('answer concisely');
  });
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

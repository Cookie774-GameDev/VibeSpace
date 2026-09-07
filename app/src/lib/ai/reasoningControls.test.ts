import { describe, expect, it } from 'vitest';
import {
  getReasoningCapabilities,
  normalizeReasoningPreference,
  resolveReasoningPolicy,
  sanitizeReasoningProviderOptions,
  type ReasoningSelection,
} from './reasoningControls';

function selection(providerId: string, modelId: string, connectionId?: string): ReasoningSelection {
  return { providerId, modelId, ...(connectionId ? { connectionId } : {}) };
}

describe('reasoning controls', () => {
  it('Final Boss overrides a stale lower effort with the highest live supported level', () => {
    const selected = selection('openai', 'gpt-5.6-sol', 'openai-codex');
    const policy = resolveReasoningPolicy({
      selection: selected,
      preference: { mode: 'token-final-boss', effortOverride: 'low' },
      liveVariants: ['low', 'medium', 'high', 'xhigh'],
    });
    expect(policy.resolvedEffort).toBe('ultra');
    expect(policy.providerOptions).toEqual({ reasoning_effort: 'xhigh' });
    expect(policy.selection).toEqual(selected);
    expect(policy.executionInstructions).toContain('SKILL.md');
    expect(policy.executionInstructions).toContain('above 95/100');
    expect(policy.executionInstructions).toMatch(/original prompt\s+and all references/);
    expect(policy.executionInstructions).toContain('highest supported effort');
    expect(policy.executionInstructions).toContain('stalls');
  });
  it('uses authoritative OpenCode Go variants for automatic modes without static provider guesses', () => {
    const selected = selection('opencode', 'opencode-go/deepseek-v4-flash-vision-exp', 'opencode-cli');
    for (const [mode, effort] of [['token-saver', 'low'], ['token-final-boss', 'max']] as const) {
      expect(resolveReasoningPolicy({selection: selected, preference: {mode, effortOverride: null}, liveVariants: ['low', 'high', 'max']})).toMatchObject({resolvedEffort: effort, providerOptions: {}});
    }
    expect(getReasoningCapabilities(selection('openai', 'gpt-5.6-sol', 'opencode-cli'), [], true).supportedEfforts).toEqual([]);
  });
  it.each([
    [
      selection('openai', 'gpt-5.6-sol', 'openai-codex'),
      ['low', 'medium', 'high', 'ultra', 'max'],
      'max',
    ],
    [selection('openai', 'gpt-5.5'), ['minimal', 'low', 'medium', 'high', 'ultra'], 'xhigh'],
    [selection('anthropic', 'claude-opus-4-8'), ['low', 'medium', 'high', 'ultra'], 'max'],
    [selection('google', 'gemini-3.5-flash'), ['minimal', 'low', 'medium', 'high'], 'high'],
    [selection('xai', 'grok-4.20-multi-agent'), ['low', 'medium', 'high', 'ultra'], 'xhigh'],
    [selection('deepseek', 'deepseek-v4-pro'), ['low', 'medium', 'high', 'ultra'], 'max'],
  ] as const)(
    'exposes only verified effort levels for %o',
    (selected, expectedEfforts, expectedUltraWire) => {
      const capabilities = getReasoningCapabilities(selected);
      expect(capabilities.supportedEfforts).toEqual(expectedEfforts);
      const highest = expectedEfforts[expectedEfforts.length - 1]!;
      const resolved = resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'normal', effortOverride: highest },
      });
      expect(Object.values(resolved.providerOptions)).toContain(expectedUltraWire);
    },
  );

  it.each([
    selection('openai', 'gpt-4o'),
    selection('qwen', 'qwen3.6-27b'),
    selection('groq', 'qwen/qwen3.6-27b'),
    selection('ollama', 'qwen3.5:4b'),
    selection('ollama', 'gpt-oss:20b'),
    selection('deepseek', 'deepseek-chat'),
    // legacy DeepSeek IDs stay without fabricated effort
  ])('does not fabricate adjustable effort for %o', (selected) => {
    expect(getReasoningCapabilities(selected).supportedEfforts).toEqual([]);
    expect(
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'token-final-boss', effortOverride: null },
      }),
    ).toMatchObject({ resolvedEffort: null, providerOptions: {} });
  });

  it('keeps OpenCode ultra/xhigh distinct from max and exposes Spark medium only', () => {
    const sol = selection('openai', 'gpt-5.6-sol', 'openai-codex');
    expect(
      resolveReasoningPolicy({
        selection: sol,
        preference: { mode: 'normal', effortOverride: 'ultra' },
      }).providerOptions,
    ).toEqual({ reasoning_effort: 'xhigh' });
    expect(
      resolveReasoningPolicy({
        selection: sol,
        preference: { mode: 'normal', effortOverride: 'max' },
      }).providerOptions,
    ).toEqual({ reasoning_effort: 'max' });

    const spark = selection('openai', 'gpt-5.3-codex-spark', 'openai-codex');
    expect(getReasoningCapabilities(spark).supportedEfforts).toEqual(['medium']);
    expect(
      resolveReasoningPolicy({
        selection: spark,
        preference: { mode: 'normal', effortOverride: 'medium' },
      }).providerOptions,
    ).toEqual({ reasoning_effort: 'medium' });

    for (const qualifiedSpark of [
      selection('openai', 'openai/gpt-5.3-codex-spark', 'opencode-cli'),
      selection('opencode', 'openai/gpt-5.3-codex-spark', 'opencode-cli'),
    ]) {
      expect(getReasoningCapabilities(qualifiedSpark).supportedEfforts).toEqual(['medium']);
      expect(
        resolveReasoningPolicy({
          selection: qualifiedSpark,
          preference: { mode: 'normal', effortOverride: 'medium' },
        }).providerOptions,
      ).toEqual({ reasoning_effort: 'medium' });
    }

    expect(
      getReasoningCapabilities(
        selection('openrouter', 'openai/gpt-5.3-codex-spark', 'opencode-cli'),
      ).supportedEfforts,
    ).toEqual([]);
  });

  it('preserves Luna Max for the exact OpenRouter OpenAI route on OpenCode', () => {
    const luna = selection('opencode', 'openrouter/openai/gpt-5.6-luna', 'opencode-cli');
    for (const liveVariants of [undefined, []] as const) {
      expect(getReasoningCapabilities(luna, liveVariants).supportedEfforts).toEqual([
        'minimal',
        'low',
        'medium',
        'high',
        'max',
      ]);
      expect(
        resolveReasoningPolicy({
          selection: luna,
          preference: { mode: 'normal', effortOverride: 'max' },
          liveVariants,
        }).providerOptions,
      ).toEqual({ reasoning_effort: 'max' });
      expect(() =>
        resolveReasoningPolicy({
          selection: luna,
          preference: { mode: 'normal', effortOverride: 'ultra' },
          liveVariants,
        }),
      ).toThrowError(/unsupported/);
    }

    for (const unrelated of [
      selection('opencode', 'unknown/openai/gpt-5.6-luna', 'opencode-cli'),
      selection('opencode', 'openrouter/anthropic/gpt-5.6-luna', 'opencode-cli'),
      selection('openrouter', 'openrouter/openai/gpt-5.6-luna', 'openrouter-api'),
    ]) {
      expect(getReasoningCapabilities(unrelated).supportedEfforts).toEqual([]);
    }
  });

  it('blocks unsupported effort instead of snapping it to a nearby level', () => {
    const selected = selection('google', 'gemini-2.5-pro');
    expect(getReasoningCapabilities(selected).supportedEfforts).toEqual(['low', 'medium', 'high']);
    expect(() =>
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'normal', effortOverride: 'minimal' },
      }),
    ).toThrowError(/unsupported/);
    expect(() =>
      resolveReasoningPolicy({
        selection: selection('groq', 'openai/gpt-oss-20b'),
        preference: { mode: 'normal', effortOverride: 'ultra' },
      }),
    ).toThrowError(/unsupported/);
  });

  it('uses live OpenCode variants as the only supported efforts when provided', () => {
    const selected = selection('openai', 'gpt-5.6-sol', 'openai-codex');
    expect(getReasoningCapabilities(selected, ['low', 'medium']).supportedEfforts).toEqual([
      'low',
      'medium',
    ]);
    expect(() =>
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'normal', effortOverride: 'high' },
        liveVariants: ['low', 'medium'],
      }),
    ).toThrowError(/unsupported/);
    expect(
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'normal', effortOverride: 'medium' },
        liveVariants: ['low', 'medium'],
      }).providerOptions,
    ).toEqual({ reasoning_effort: 'medium' });
  });

  it('maps modes to lowest, provider-default, and highest effort while preserving the model', () => {
    const selected = selection('openai', 'gpt-5.6-sol', 'openai-codex');
    expect(
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'token-saver', effortOverride: null },
      }),
    ).toMatchObject({
      selection: selected,
      resolvedEffort: 'low',
      providerOptions: { reasoning_effort: 'low' },
      maxOutputTokens: 2048,
    });
    expect(
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'normal', effortOverride: null },
      }),
    ).toMatchObject({
      selection: selected,
      resolvedEffort: null,
      providerOptions: {},
      maxOutputTokens: undefined,
    });
    expect(
      resolveReasoningPolicy({
        selection: selected,
        preference: { mode: 'token-final-boss', effortOverride: null },
      }),
    ).toMatchObject({
      selection: selected,
      resolvedEffort: 'max',
      providerOptions: { reasoning_effort: 'max' },
      maxOutputTokens: undefined,
    });
  });

  it('binds each mode to a real execution contract and gives Final Boss a bounded verification loop', () => {
    const selected = selection('openai', 'gpt-5.6-sol', 'openai-codex');
    const saver = resolveReasoningPolicy({
      selection: selected,
      preference: { mode: 'token-saver', effortOverride: null },
    });
    const normal = resolveReasoningPolicy({
      selection: selected,
      preference: { mode: 'normal', effortOverride: null },
    });
    const finalBoss = resolveReasoningPolicy({
      selection: selected,
      preference: { mode: 'token-final-boss', effortOverride: null },
    });

    expect(saver.executionInstructions).toContain('Token Saver');
    expect(saver.executionInstructions).toContain('mandatory security');
    expect(normal.executionInstructions).toContain('Normal');
    expect(normal.executionInstructions).toContain('focused verification');
    expect(finalBoss.executionInstructions).toContain('Token Final Boss');
    expect(finalBoss.executionInstructions).toContain('Reread the original user request');
    expect(finalBoss.executionInstructions).toContain('critique');
    expect(finalBoss.executionInstructions).toContain('Re-run the affected verification');
    expect(finalBoss.executionInstructions).toContain('Do not expose private chain-of-thought');
    expect(finalBoss.selection).toEqual(selected);
  });

  it('normalizes malformed persisted preferences to Normal without an override', () => {
    expect(normalizeReasoningPreference({ mode: 'wild', effortOverride: 'infinite' })).toEqual({
      mode: 'normal',
      effortOverride: null,
    });
  });

  it('allows only the exact option and wire values verified for the selected model', () => {
    const selected = selection('openai', 'gpt-5.6-sol', 'openai-codex');
    expect(sanitizeReasoningProviderOptions(selected, { reasoning_effort: 'xhigh' })).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(sanitizeReasoningProviderOptions(selected, { reasoning_effort: 'max' })).toEqual({
      reasoning_effort: 'max',
    });
    expect(
      sanitizeReasoningProviderOptions(selected, {
        reasoning_effort: 'arbitrary',
        unsafe_extra: 'ignored',
      }),
    ).toEqual({});
    expect(
      sanitizeReasoningProviderOptions(selection('qwen', 'qwen3.6-27b'), {
        reasoning_effort: 'high',
      }),
    ).toEqual({});
  });
});

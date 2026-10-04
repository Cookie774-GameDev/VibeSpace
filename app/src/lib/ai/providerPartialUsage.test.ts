import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from './adapters/types';
import { providerPartialUsage } from './providerPartialUsage';

const reported = (value: number) => ({ value, provenance: 'provider-reported' as const });

function snapshot(
  values: Partial<{
    input: number;
    output: number;
    total: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cost: number;
  }>,
): UsageSnapshot {
  return {
    capturedAt: 1,
    ...(values.input === undefined ? {} : { inputTokens: reported(values.input) }),
    ...(values.output === undefined ? {} : { outputTokens: reported(values.output) }),
    ...(values.total === undefined ? {} : { totalTokens: reported(values.total) }),
    ...(values.cacheRead === undefined ? {} : { cacheReadTokens: reported(values.cacheRead) }),
    ...(values.cacheWrite === undefined ? {} : { cacheWriteTokens: reported(values.cacheWrite) }),
    ...(values.reasoning === undefined ? {} : { reasoningTokens: reported(values.reasoning) }),
    ...(values.cost === undefined ? {} : { costUsd: reported(values.cost) }),
  };
}

describe('providerPartialUsage', () => {
  it('copies every actual provider metric without deriving totals', () => {
    const usage = providerPartialUsage(
      snapshot({
        input: 17_999,
        output: 227,
        total: 99,
        cacheRead: 0,
        cacheWrite: 8,
        reasoning: 17,
        cost: 0.00289665,
      }),
      'openai',
      'gpt-5.6-luna',
    );

    expect(usage).toEqual({
      input_tokens: 17_999,
      output_tokens: 227,
      total_tokens: 99,
      cache_read_tokens: 0,
      cache_write_tokens: 8,
      reasoning_tokens: 17,
      cost_usd: 0.00289665,
      provider: 'openai',
      model: 'gpt-5.6-luna',
    });
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it('retains a provider-reported reasoning-only snapshot, including zero, without deriving counts', () => {
    expect(
      providerPartialUsage(
        { capturedAt: 1, reasoningTokens: reported(0) },
        'openai',
        'gpt-6-luna',
      ),
    ).toEqual({
      reasoning_tokens: 0,
      provider: 'openai',
      model: 'gpt-6-luna',
    });
  });

  it('ignores estimated or unsafe reasoning counts while retaining actual input usage', () => {
    const estimated = providerPartialUsage(
      {
        capturedAt: 1,
        inputTokens: reported(12),
        reasoningTokens: { value: 7, provenance: 'estimated' },
      },
      'openai',
      'gpt-6-luna',
    );
    const unsafe = providerPartialUsage(
      {
        capturedAt: 1,
        inputTokens: reported(12),
        reasoningTokens: reported(Number.MAX_SAFE_INTEGER + 1),
      },
      'openai',
      'gpt-6-luna',
    );

    expect(estimated).toEqual({
      input_tokens: 12,
      provider: 'openai',
      model: 'gpt-6-luna',
    });
    expect(unsafe).toEqual(estimated);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'ignores invalid provider reasoning count %s',
    (reasoningTokens) => {
      expect(
        providerPartialUsage(
          {
            capturedAt: 1,
            inputTokens: reported(12),
            reasoningTokens: reported(reasoningTokens),
          },
          'openai',
          'gpt-6-luna',
        ),
      ).toEqual({
        input_tokens: 12,
        provider: 'openai',
        model: 'gpt-6-luna',
      });
    },
  );

  it('keeps only finite nonnegative provider-reported values', () => {
    const usage = providerPartialUsage(
      {
        capturedAt: 1,
        inputTokens: reported(-1),
        outputTokens: reported(Number.NaN),
        totalTokens: reported(Number.POSITIVE_INFINITY),
        cacheReadTokens: reported(1.5),
        cacheWriteTokens: reported(Number.MAX_SAFE_INTEGER + 1),
        costUsd: { value: 0.5, provenance: 'unavailable' },
      },
      'deepseek',
      'deepseek-v4-flash-vision-exp',
    );

    expect(usage).toBeUndefined();
  });

  it('returns undefined for missing, estimated, or unavailable metrics', () => {
    expect(providerPartialUsage(undefined, 'openai', 'gpt-5.6-luna')).toBeUndefined();
    expect(
      providerPartialUsage(
        {
          capturedAt: 1,
          inputTokens: { value: 10, provenance: 'estimated' },
          outputTokens: { value: 2, provenance: 'unavailable' },
        },
        'openai',
        'gpt-5.6-luna',
      ),
    ).toBeUndefined();
  });

  it('preserves a partial snapshot without inventing absent fields', () => {
    expect(
      providerPartialUsage(snapshot({ input: 10, cacheRead: 0 }), 'openai', 'gpt-5.6-luna'),
    ).toEqual({
      input_tokens: 10,
      cache_read_tokens: 0,
      provider: 'openai',
      model: 'gpt-5.6-luna',
    });
  });

  it('returns a detached frozen copy', () => {
    const source = snapshot({ input: 4, output: 2 });
    const usage = providerPartialUsage(source, 'openai', 'gpt-5.6-luna');
    expect(usage).not.toBe(source);
    expect(Object.isFrozen(usage)).toBe(true);
    expect(() => {
      (usage as { input_tokens?: number }).input_tokens = 99;
    }).toThrow();
    expect(usage).toEqual({
      input_tokens: 4,
      output_tokens: 2,
      provider: 'openai',
      model: 'gpt-5.6-luna',
    });
  });
});

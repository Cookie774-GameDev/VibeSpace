import type { ProviderId } from '@/types';
import { summarizeAllLocalProviderUsage, summarizeLocalProviderUsage } from './usageSummary';

describe('summarizeLocalProviderUsage', () => {
  it('aggregates only the requested provider inside the selected period', () => {
    const start = 1_000;
    const messages = [
      {
        created_at: 1_100,
        usage: {
          provider: 'openai' as ProviderId,
          input_tokens: 100,
          output_tokens: 25,
          cache_read_tokens: 10,
          cache_write_tokens: 5,
          cost_usd: 0.012,
        },
      },
      {
        created_at: 1_200,
        usage: {
          provider: 'google' as ProviderId,
          input_tokens: 999,
          output_tokens: 999,
          cost_usd: 1,
        },
      },
      {
        created_at: 900,
        usage: {
          provider: 'openai' as ProviderId,
          input_tokens: 500,
          output_tokens: 500,
          cost_usd: 1,
        },
      },
    ];

    expect(summarizeLocalProviderUsage(messages, 'openai', start)).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 15,
      totalTokens: 125,
      costUsd: 0.012,
      calls: 1,
      lastUsed: 1_100,
    });
  });
});

describe('summarizeAllLocalProviderUsage', () => {
  it('rolls up every provider in one pass', () => {
    const start = 1_000;
    const messages = [
      {
        created_at: 1_100,
        usage: {
          provider: 'openai' as ProviderId,
          input_tokens: 10,
          output_tokens: 5,
          cost_usd: 0.01,
        },
      },
      {
        created_at: 1_150,
        usage: {
          provider: 'google' as ProviderId,
          input_tokens: 20,
          output_tokens: 8,
          cost_usd: 0.02,
        },
      },
    ];

    const totals = summarizeAllLocalProviderUsage(messages, ['openai', 'google'], start);
    expect(totals.openai).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
      costUsd: 0.01,
      calls: 1,
      lastUsed: 1_100,
    });
    expect(totals.google).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cachedTokens: 0,
      totalTokens: 28,
      costUsd: 0.02,
      calls: 1,
      lastUsed: 1_150,
    });
  });

  it('uses each provider-reported total without adding its cache subset again', () => {
    const opencodeProvider = 'opencode' as ProviderId;
    const messages = [
      {
        created_at: 1_100,
        usage: {
          provider: opencodeProvider,
          input_tokens: 33_264,
          output_tokens: 381,
          cache_read_tokens: 65_280,
          total_tokens: 98_925,
        },
      },
      {
        created_at: 1_200,
        usage: {
          provider: opencodeProvider,
          input_tokens: 103_896,
          output_tokens: 554,
          cache_read_tokens: 47_872,
          total_tokens: 104_450,
        },
      },
    ];

    expect(summarizeLocalProviderUsage(messages, opencodeProvider, 1_000)).toMatchObject({
      inputTokens: 137_160,
      outputTokens: 935,
      cachedTokens: 113_152,
      totalTokens: 203_375,
      calls: 2,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateConnectionUsage,
  recordConnectionUsage,
  resetConnectionUsageLedgerForTests,
} from './connectionUsageLedger';

describe('connection usage ledger', () => {
  beforeEach(resetConnectionUsageLedgerForTests);

  it('keeps subscription and API usage separate across analytics windows', () => {
    const now = 1_800_000_000_000;
    recordConnectionUsage({
      connectionId: 'openai-codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      timestamp: now - 1_000,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      costUsd: 0,
    });
    recordConnectionUsage({
      connectionId: 'openai-api',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      timestamp: now - 1_000,
      inputTokens: 20,
      cachedInputTokens: 3,
      outputTokens: 8,
      costUsd: 0.04,
    });

    expect(aggregateConnectionUsage('openai-codex', now - 86_400_000)).toMatchObject({
      inputTokens: 10,
      requests: 1,
      costUsd: 0,
      availability: 'available',
      source: 'vibespace-local-request-ledger',
    });
    expect(aggregateConnectionUsage('openai-api', now - 7 * 86_400_000)).toMatchObject({
      inputTokens: 20,
      requests: 1,
      costUsd: 0.04,
    });
    expect(aggregateConnectionUsage('openai-api', now - 30 * 86_400_000).models).toEqual([
      'gpt-5.6-sol',
    ]);
    expect(
      aggregateConnectionUsage('openai-api', now - 30 * 86_400_000, 'different-model'),
    ).toMatchObject({
      requests: 0,
      costUsd: 0,
      lastRequestAt: null,
      availability: 'unavailable',
    });
  });

  it('emits only the normalized usage fact needed by local status analytics', () => {
    const listener = vi.fn();
    window.addEventListener('jarvis:ai-connection-usage:changed', listener);
    recordConnectionUsage({
      connectionId: 'openai-api',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      timestamp: 1_800_000_000_000,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      costUsd: 0.04,
      costType: 'actual',
      ...({ prompt: 'must never cross the analytics boundary' } as Record<string, unknown>),
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail).toEqual({
      connectionId: 'openai-api',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      timestamp: 1_800_000_000_000,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      costUsd: 0.04,
      costType: 'actual',
    });
    expect(detail).not.toHaveProperty('prompt');
    window.removeEventListener('jarvis:ai-connection-usage:changed', listener);
  });

  it('keeps a provider total authoritative while cached input stays a separate subset', () => {
    const now = 1_800_000_000_000;
    recordConnectionUsage({
      connectionId: 'openai-api',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      timestamp: now,
      inputTokens: 33_264,
      cachedInputTokens: 65_280,
      outputTokens: 381,
      totalTokens: 98_925,
      costUsd: 0,
    });

    expect(aggregateConnectionUsage('openai-api', now - 1)).toMatchObject({
      inputTokens: 33_264,
      cachedInputTokens: 65_280,
      outputTokens: 381,
      totalTokens: 98_925,
    });
  });
});

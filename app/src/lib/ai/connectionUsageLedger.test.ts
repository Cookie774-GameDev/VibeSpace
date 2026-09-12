import { beforeEach, describe, expect, it } from 'vitest';
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
  });
});

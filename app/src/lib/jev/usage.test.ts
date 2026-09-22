import { describe, expect, it } from 'vitest';
import { JEV_INPUT_COST_PER_MILLION, buildJevUsageRecord } from './usage';

describe('Jev usage ledger projection', () => {
  it('computes local cost from provider-reported input tokens and preserves scope', () => {
    const record = buildJevUsageRecord({
      id: 'usage-1',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      missionId: 'mission-1',
      targetId: 'chat-1',
      model: 'jev-1.13.0',
      inputTokens: 1_000_000,
      outputTokens: 20,
      latencyMs: 40,
      status: 'ok',
      reason: 'sweep',
      recordedAt: 100,
    });
    expect(record.costUsd).toBe(JEV_INPUT_COST_PER_MILLION);
    expect(record.costProvenance).toBe('estimated');
    expect(record).toMatchObject({ accountId: 'account-1', workspaceId: 'workspace-1' });
  });

  it('does not invent cost when token usage is unavailable', () => {
    expect(
      buildJevUsageRecord({
        id: 'usage-2',
        accountId: 'a',
        workspaceId: 'w',
        missionId: null,
        targetId: null,
        model: 'jev-1.13.0',
        inputTokens: null,
        outputTokens: null,
        latencyMs: 10,
        status: 'unavailable',
        reason: 'provider_unavailable',
        recordedAt: 101,
      }).costUsd,
    ).toBeNull();
  });

  it('preserves provider-reported cost provenance when native returns it', () => {
    const record = buildJevUsageRecord({
      id: 'usage-3', accountId: 'a', workspaceId: 'w', missionId: null, targetId: null,
      model: 'jev-1.13.0', inputTokens: 10, outputTokens: 2, latencyMs: 1,
      status: 'ok', reason: 'event', recordedAt: 102, providerCostUsd: 0.0007,
    });
    expect(record).toMatchObject({ costUsd: 0.0007, costProvenance: 'provider-reported' });
  });
});

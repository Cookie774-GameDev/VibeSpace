import { describe, expect, it, vi } from 'vitest';
import { createJevUsageEventWriter } from './usageEventWriter';

describe('Jev usage event writer', () => {
  it('persists scoped provider cost provenance without blocking the decision path', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const writer = createJevUsageEventWriter({
      database: { jev_usage_records: { put } } as never,
      accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1',
      missionId: 'mission-1', targetId: 'target-1', now: () => 42, id: () => 'usage-1',
    });
    writer({ model: 'jev-1', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0004 }, latencyMs: 8, status: 'ok' });
    await Promise.resolve();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      id: 'usage-1', accountId: 'account-1', workspaceId: 'workspace-1',
      costUsd: 0.0004, costProvenance: 'provider-reported', recordedAt: 42,
    }));
  });

  it('labels calculated token cost as an estimate and preserves unknown usage', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const writer = createJevUsageEventWriter({
      database: { jev_usage_records: { put } } as never,
      accountId: 'a', workspaceId: 'w', now: () => 1, id: () => 'u1',
    });
    writer({ model: 'jev', usage: { inputTokens: 1_000_000, outputTokens: null, costUsd: null }, latencyMs: 1, status: 'ok' });
    writer({ model: 'jev', usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 1, status: 'error' });
    await Promise.resolve();
    expect(put).toHaveBeenNthCalledWith(1, expect.objectContaining({ costProvenance: 'estimated' }));
    expect(put).toHaveBeenNthCalledWith(2, expect.objectContaining({ costUsd: null, costProvenance: 'unavailable' }));
  });
});

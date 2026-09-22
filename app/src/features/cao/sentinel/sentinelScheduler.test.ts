import { describe, expect, it, vi } from 'vitest';
import { createCaoSentinelScheduler } from './sentinelScheduler';
import type { CaoTargetSnapshot } from './types';

const snapshot: CaoTargetSnapshot = {
  missionId: 'm', targetId: 't', kind: 'terminal', accountId: 'a', workspaceId: 'w', projectId: 'p',
  backend: 'opencode', providerId: 'openai', modelId: 'gpt-5.6-luna', reasoningEffort: 'low',
  assignment: 'test', ownedPaths: [], targetRevision: 1, runStatus: 'running', lastActivityAt: 100,
  pendingUserInput: false, pendingApproval: false, pendingTool: false, pendingRetry: false,
  receiptIds: [], verification: 'pending', recentDelta: 'steady', errors: [], claims: [],
  contextRevision: null, milestone: 'tests', cursor: { targetRevision: 1, contentHash: 'h', contextRevision: null, observedAt: 100 },
};

describe('CAO Sentinel scheduler', () => {
  it('debounces duplicate event notifications and skips unchanged healthy sweeps', async () => {
    const observe = vi.fn().mockResolvedValue(undefined);
    const scheduler = createCaoSentinelScheduler({ observe, debounceMs: 5, sweepMs: 30_000, now: () => 101 });
    scheduler.notify(snapshot, 'output');
    scheduler.notify(snapshot, 'output');
    await new Promise((resolve) => setTimeout(resolve, 12));
    expect(observe).toHaveBeenCalledOnce();
    await scheduler.sweep([snapshot]);
    expect(observe).toHaveBeenCalledOnce();
    scheduler.dispose();
  });
});

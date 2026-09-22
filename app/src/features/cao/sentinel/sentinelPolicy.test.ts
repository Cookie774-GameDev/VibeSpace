import { describe, expect, it } from 'vitest';
import { decideCaoSentinelAction } from './sentinelPolicy';
import type { CaoSentinelObservation, CaoTargetSnapshot } from './types';

const healthy: CaoTargetSnapshot = {
  missionId: 'm', targetId: 't', kind: 'chat', accountId: 'a', workspaceId: 'w', projectId: 'p',
  backend: 'codex', providerId: 'openai', modelId: 'gpt-5.6-luna', reasoningEffort: 'high',
  assignment: 'work', ownedPaths: [], targetRevision: 1, runStatus: 'running', lastActivityAt: 100,
  pendingUserInput: false, pendingApproval: false, pendingTool: false, pendingRetry: false,
  receiptIds: [], verification: 'pending', recentDelta: 'progress', errors: [], claims: [],
  contextRevision: null, milestone: 'build', cursor: { targetRevision: 1, contentHash: 'h', contextRevision: null, observedAt: 100 },
};

const observation: CaoSentinelObservation = {
  missionId: 'm', targetId: 't', targetRevision: 1, evidenceHash: 'e', observedAt: 101,
  health: 'healthy_working', nextAction: 'noop', urgency: 0.1, evidenceQuality: 0.9,
  needsMainCaoProbability: 0.1, offTrackProbability: 0.1, doneWithoutProofProbability: 0.1,
  reasonCode: 'jev_healthy',
};

describe('CAO Sentinel policy', () => {
  it('keeps a fresh healthy target as a no-op', () => {
    expect(decideCaoSentinelAction({ snapshot: healthy, observation })).toMatchObject({ action: 'noop' });
  });

  it('wakes the main CAO for failed evidence even when Jev proposes no-op', () => {
    expect(decideCaoSentinelAction({
      snapshot: { ...healthy, runStatus: 'error', errors: ['build failed'] },
      observation,
    })).toMatchObject({ action: 'wake_main_cao', reasonCode: 'target_failed' });
  });

  it('deduplicates unchanged wake evidence by mission, target, revision, and hash', () => {
    const first = decideCaoSentinelAction({
      snapshot: { ...healthy, runStatus: 'error', errors: ['build failed'] },
      observation: { ...observation, nextAction: 'wake_main_cao', health: 'failed' },
    });
    const second = decideCaoSentinelAction({
      snapshot: { ...healthy, runStatus: 'error', errors: ['build failed'] },
      observation: { ...observation, nextAction: 'wake_main_cao', health: 'failed' },
      previousWakeKey: first.wakeKey,
    });
    expect(first.action).toBe('wake_main_cao');
    expect(second.action).toBe('noop');
    expect(second.reasonCode).toBe('wake_deduplicated');
  });
});

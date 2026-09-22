import { describe, expect, it } from 'vitest';
import { sanitizeCaoTargetSnapshot } from './snapshotSanitizer';

describe('CAO Sentinel snapshot sanitization', () => {
  it('bounds text, removes secret-like fields, and keeps exact target scope', () => {
    const snapshot = sanitizeCaoTargetSnapshot({
      missionId: 'mission-1',
      targetId: 'chat-1',
      kind: 'chat',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      backend: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      assignment: 'Build the game',
      ownedPaths: ['game/src/main.ts'],
      targetRevision: 4,
      runStatus: 'running',
      lastActivityAt: 100,
      pendingUserInput: false,
      pendingApproval: false,
      pendingTool: false,
      pendingRetry: false,
      receiptIds: ['receipt-1'],
      verification: 'pending',
      recentDelta: 'x'.repeat(10_000),
      errors: ['safe error', 'sk-should-not-be-included'],
      claims: ['working'],
      contextRevision: 'ctx-4',
      milestone: 'implementation',
      cursor: { targetRevision: 4, contentHash: 'hash-4', observedAt: 100 },
      hiddenReasoning: 'never include this',
      apiKey: 'secret',
    } as never);
    expect(snapshot.recentDelta.length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(snapshot)).not.toMatch(/hiddenReasoning|apiKey|sk-should-not/u);
    expect(snapshot.targetId).toBe('chat-1');
  });

  it('keeps generated high-entropy mission and chat IDs intact', () => {
    const missionId = 'cao_mission_f7929214-7a99-4e8f-9f73-05386d3f1595';
    const targetId = 'cht_7e4b9d2a1c6f8b3e0d5a9f2c7b1e6d4a';
    const snapshot = sanitizeCaoTargetSnapshot({
      missionId,
      targetId,
      kind: 'chat',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      backend: 'codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      assignment: 'Review the current work',
      ownedPaths: [],
      targetRevision: 1,
      runStatus: 'running',
      lastActivityAt: 100,
      pendingUserInput: false,
      pendingApproval: false,
      pendingTool: false,
      pendingRetry: false,
      receiptIds: [],
      verification: 'pending',
      recentDelta: '',
      errors: [],
      claims: [],
      contextRevision: null,
      milestone: 'active-turn',
    });

    expect(snapshot.missionId).toBe(missionId);
    expect(snapshot.targetId).toBe(targetId);
  });

  it('rejects credential-shaped identifiers even when they fit the ID alphabet', () => {
    expect(() =>
      sanitizeCaoTargetSnapshot({
        missionId: 'cao_mission_f7929214-7a99-4e8f-9f73-05386d3f1595',
        targetId: 'chat-1',
        kind: 'chat',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        backend: 'codex',
        providerId: 'sk-12345678901234567890',
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        assignment: 'Review the current work',
        ownedPaths: [],
        targetRevision: 1,
        runStatus: 'running',
        lastActivityAt: 100,
        pendingUserInput: false,
        pendingApproval: false,
        pendingTool: false,
        pendingRetry: false,
        receiptIds: [],
        verification: 'pending',
        recentDelta: '',
        errors: [],
        claims: [],
        contextRevision: null,
        milestone: 'active-turn',
      }),
    ).toThrow('cao_snapshot_provider_invalid');
  });
});

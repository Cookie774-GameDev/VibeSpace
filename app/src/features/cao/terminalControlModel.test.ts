import { expect, it, vi } from 'vitest';
import type { RunAgentRequest, runAgent } from '@/lib/ai/router';
import { createCaoTerminalModel } from './terminalControlModel';
import type { CaoExecutionProfile } from './executionProfile';
vi.mock('@/lib/ai/router', () => ({ runAgent: vi.fn() }));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ accountId: 'account' }),
}));
const input = {
  accountId: 'account',
  action: 'grade' as const,
  objective: 'Playable game',
  evidence: 'Observed output',
  guidance: { schemaVersion: 1 as const, sections: {}, sourceIds: [] },
  signal: new AbortController().signal,
};
const profile: CaoExecutionProfile = {
  schemaVersion: 1,
  accountId: 'account',
  workspaceId: 'workspace-1',
  backend: 'codex',
  providerId: 'openai',
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'high',
  catalogReceipt: {
    source: 'live',
    accountId: 'account',
    workspaceId: 'workspace-1',
    catalogGeneration: 'test-generation',
    catalogHash: 'b'.repeat(64),
    verifiedAt: 1,
    entries: [
      {
        backend: 'codex',
        providerId: 'openai',
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'high',
      },
    ],
  },
  updatedAt: 1,
};
const profileDependencies = {
  readScope: () => ({ accountId: profile.accountId, workspaceId: profile.workspaceId }),
  resolveProfile: vi.fn(async () => profile),
};
function dispatcher(patch: Record<string, unknown> = {}) {
  return vi.fn(async (request: RunAgentRequest) => {
    request.onProviderCompletionEvidence?.({
      requestId: request.requestId!,
      sessionId: 'session',
      observedAt: Date.now(),
      connectionId: profile.connectionId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      reasoningEffort: profile.reasoningEffort,
      usage: { capturedAt: Date.now() },
      ...patch,
    });
    return { text: 'Gameplay verification is still missing.' };
  }) as unknown as typeof runAgent;
}
it('grades with the scoped live main profile, observed receipt, and no tool permissions', async () => {
  const dispatch = dispatcher();
  const result = await createCaoTerminalModel(dispatch, profileDependencies)(input);
  expect(result.receipt.sessionId).toBe('session');
  const request = vi.mocked(dispatch).mock.calls[0]![0];
  expect(request).toMatchObject({
    backend: profile.backend,
    connectionId: profile.connectionId,
    workspaceId: profile.workspaceId,
  });
  expect(request.agent.model).toEqual({ provider: profile.providerId, model: profile.modelId });
  expect(request.provider_options).toEqual({ reasoning_effort: profile.reasoningEffort });
  expect(request.accessLevel).toBe('read-only');
  expect(request.approveAllForRun).toBe(false);
  expect(Object.values(request.tools!)).not.toContain(true);
  expect(request.messages[0]!.content).toContain('Observed output');
});
it.each([
  { modelId: 'substitute' },
  { connectionId: 'other' },
  { reasoningEffort: 'low' },
  { requestId: 'other' },
  { sessionId: '' },
])('rejects substituted or ungrounded identity %j', async (patch) => {
  await expect(
    createCaoTerminalModel(dispatcher(patch), profileDependencies)(input),
  ).rejects.toThrow();
});

import { expect, it, vi } from 'vitest';
import type { RunAgentRequest, runAgent } from '@/lib/ai/router';
import { createCaoTerminalModel } from './terminalControlModel';
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
function dispatcher(patch: Record<string, unknown> = {}) {
  return vi.fn(async (request: RunAgentRequest) => {
    request.onProviderCompletionEvidence?.({
      requestId: request.requestId!,
      sessionId: 'session',
      observedAt: Date.now(),
      connectionId: 'openai-codex',
      providerId: 'openai',
      modelId: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      usage: { capturedAt: Date.now() },
      ...patch,
    });
    return { text: 'Gameplay verification is still missing.' };
  }) as unknown as typeof runAgent;
}
it('grades with the fixed learner, observed receipt, and no tool permissions', async () => {
  const dispatch = dispatcher();
  const result = await createCaoTerminalModel(dispatch)(input);
  expect(result.receipt.sessionId).toBe('session');
  const request = vi.mocked(dispatch).mock.calls[0]![0];
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
  await expect(createCaoTerminalModel(dispatcher(patch))(input)).rejects.toThrow();
});

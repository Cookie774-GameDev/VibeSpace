import { describe, expect, it, vi } from 'vitest';
import type { RunAgentRequest, runAgent } from '@/lib/ai/router';
import { createCaoCommandReviewer } from './chatCommandProduction';
import type { CaoGuidance } from '@/features/jarvis-memory/caoGuidance';
vi.mock('./chatCommands', () => ({ createCaoChatCommands: vi.fn(() => ({})) }));
vi.mock('@/lib/ai/router', () => ({ runAgent: vi.fn() }));
vi.mock('@/lib/accountIdentity', () => ({ getActiveAccountIdentity: () => ({ accountId: 'account-1' }) }));
vi.mock('@/features/jarvis-memory/caoChatControlProduction', () => ({ caoPermissionKey: (id: string) => `permission:${id}` }));
const guidance: CaoGuidance = { schemaVersion: 1, sections: {}, sourceIds: [] };
function dispatchWith(patch: Record<string, unknown> = {}) {
  return vi.fn(async (input: RunAgentRequest) => {
    input.onProviderCompletionEvidence?.({ requestId: input.requestId!, sessionId: 'native-session', observedAt: Date.now(),
      connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-terra', reasoningEffort: 'high', usage: { capturedAt: Date.now() }, ...patch });
    return { text: 'Observed evidence is insufficient for verification.' };
  }) as unknown as typeof runAgent;
}
describe('CAO command review model authority', () => {
  it('uses the fixed learner and refuses tools, delegation and approval escalation', async () => {
    const dispatch = dispatchWith();
    const result = await createCaoCommandReviewer(dispatch)('grade', 'observed evidence', guidance, new AbortController().signal, 'review-1');
    expect(result.receipt.sessionId).toBe('native-session');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ backend: 'codex', connectionId: 'openai-codex', interactionMode: 'ask', accessLevel: 'read-only', approveAllForRun: false }));
    const request = vi.mocked(dispatch).mock.calls[0]![0];
    expect(Object.values(request.tools!)).not.toContain(true);
    expect(request.agent.tools_allowed).toEqual([]);
  });
  it.each([{ modelId: 'substitute' }, { connectionId: 'other' }, { reasoningEffort: 'low' }, { requestId: 'wrong-request' }])('rejects a mismatched completion receipt: %j', async patch => {
    await expect(createCaoCommandReviewer(dispatchWith(patch))('verify', 'evidence', guidance, new AbortController().signal, 'review-1')).rejects.toThrow();
  });
  it('does not claim a completed review without a provider receipt', async () => {
    const dispatch = vi.fn(async () => ({ text: 'unsupported claim' })) as unknown as typeof runAgent;
    await expect(createCaoCommandReviewer(dispatch)('diagnose', 'evidence', guidance, new AbortController().signal, 'review-1')).rejects.toThrow('cao_control_review_receipt_missing');
  });
});

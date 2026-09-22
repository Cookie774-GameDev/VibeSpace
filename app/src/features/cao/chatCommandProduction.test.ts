import { describe, expect, it, vi } from 'vitest';
import type { RunAgentRequest, runAgent } from '@/lib/ai/router';
import { createCaoCommandReviewer } from './chatCommandProduction';
import type { CaoExecutionProfile } from './executionProfile';
import type { CaoGuidance } from '@/features/jarvis-memory/caoGuidance';
vi.mock('./chatCommands', () => ({ createCaoChatCommands: vi.fn(() => ({})) }));
vi.mock('@/lib/ai/router', () => ({ runAgent: vi.fn() }));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ accountId: 'account-1' }),
}));
vi.mock('@/features/jarvis-memory/caoChatControlProduction', () => ({
  caoPermissionKey: (id: string) => `permission:${id}`,
}));
const guidance: CaoGuidance = { schemaVersion: 1, sections: {}, sourceIds: [] };
const profile: CaoExecutionProfile = {
  schemaVersion: 1,
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  backend: 'codex',
  providerId: 'openai',
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'high',
  catalogReceipt: {
    source: 'live',
    accountId: 'account-1',
    workspaceId: 'workspace-1',
    catalogGeneration: 'test-generation',
    catalogHash: 'a'.repeat(64),
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
function dispatchWith(patch: Record<string, unknown> = {}) {
  return vi.fn(async (input: RunAgentRequest) => {
    input.onProviderCompletionEvidence?.({
      requestId: input.requestId!,
      sessionId: 'native-session',
      observedAt: Date.now(),
      connectionId: profile.connectionId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      reasoningEffort: profile.reasoningEffort,
      usage: { capturedAt: Date.now() },
      ...patch,
    });
    return { text: 'Observed evidence is insufficient for verification.' };
  }) as unknown as typeof runAgent;
}
describe('CAO command review model authority', () => {
  it('uses the scoped live main profile and refuses tools, delegation and approval escalation', async () => {
    const dispatch = dispatchWith();
    const result = await createCaoCommandReviewer(dispatch, profileDependencies)(
      'grade',
      'observed evidence',
      guidance,
      new AbortController().signal,
      'review-1',
    );
    expect(result.receipt.sessionId).toBe('native-session');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: profile.backend,
        connectionId: profile.connectionId,
        workspaceId: profile.workspaceId,
        interactionMode: 'ask',
        accessLevel: 'read-only',
        approveAllForRun: false,
      }),
    );
    const request = vi.mocked(dispatch).mock.calls[0]![0];
    expect(request.agent.model).toEqual({ provider: profile.providerId, model: profile.modelId });
    expect(request.provider_options).toEqual({ reasoning_effort: profile.reasoningEffort });
    expect(Object.values(request.tools!)).not.toContain(true);
    expect(request.agent.tools_allowed).toEqual([]);
  });
  it.each([
    { modelId: 'substitute' },
    { connectionId: 'other' },
    { reasoningEffort: 'low' },
    { requestId: 'wrong-request' },
  ])('rejects a mismatched completion receipt: %j', async (patch) => {
    await expect(
      createCaoCommandReviewer(dispatchWith(patch), profileDependencies)(
        'verify',
        'evidence',
        guidance,
        new AbortController().signal,
        'review-1',
      ),
    ).rejects.toThrow();
  });
  it('does not claim a completed review without a provider receipt', async () => {
    const dispatch = vi.fn(async () => ({
      text: 'unsupported claim',
    })) as unknown as typeof runAgent;
    await expect(
      createCaoCommandReviewer(dispatch, profileDependencies)(
        'diagnose',
        'evidence',
        guidance,
        new AbortController().signal,
        'review-1',
      ),
    ).rejects.toThrow('cao_control_review_receipt_missing');
  });
  it('rejects a resolved profile outside the active scope before dispatch', async () => {
    const dispatch = vi.fn() as unknown as typeof runAgent;
    const resolveProfile = vi.fn(async () => ({ ...profile, workspaceId: 'foreign-workspace' }));
    await expect(
      createCaoCommandReviewer(dispatch, { ...profileDependencies, resolveProfile })(
        'verify',
        'evidence',
        guidance,
        new AbortController().signal,
        'review-1',
      ),
    ).rejects.toThrow('cao_execution_profile_scope_mismatch');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

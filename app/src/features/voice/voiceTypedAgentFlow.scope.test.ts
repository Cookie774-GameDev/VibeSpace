import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureChat: vi.fn(), history: vi.fn(), persist: vi.fn(), capture: vi.fn(),
  dispatch: vi.fn(), info: vi.fn(), warning: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ messageRepo: { create: mocks.persist, listByChat: mocks.history } }));
vi.mock('./voiceChatRouting', () => ({ ensureJarvisChatForProvider: mocks.ensureChat }));
vi.mock('./voiceScreenCapture', () => ({ captureVoiceScreenAttachment: mocks.capture }));
vi.mock('@/lib/ai/vision', () => ({ modelSupportsVision: () => true }));
vi.mock('@/lib/ai/modelSelection', async (original) => ({
  ...await original<typeof import('@/lib/ai/modelSelection')>(),
  validateSendModelAccess: () => ({ ok: true }),
}));
vi.mock('./voiceProviderSelection', async () => {
  const { selectionFromOption } = await vi.importActual<typeof import('@/lib/ai/modelSelection')>('@/lib/ai/modelSelection');
  const { OPENCODE_CLI_CONNECTION } = await import('@/lib/ai/adapters/catalog');
  return { resolveVoiceProviderSelection: () => ({ provider: 'opencode', modelLabel: 'Synthetic Luna',
    selection: selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION) }) };
});
vi.mock('./voiceNativeDelegation', () => ({
  buildVoiceNativeDelegationGuidance: () => 'Synthetic native delegation guidance.',
  dispatchVoiceMainRequest: mocks.dispatch,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { info: mocks.info, warning: mocks.warning } }));

import { useAuthStore } from '@/stores/auth';
import { startTypedAgentOverride } from './voiceTypedAgentFlow';

type Auth = ReturnType<typeof useAuthStore.getState>;
let serial = 0;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function scopeRoundTrip(scope: 'account' | 'workspace' | 'project') {
  if (scope === 'account') {
    useAuthStore.setState({ localUserId: 'account-b' }); useAuthStore.setState({ localUserId: 'account-a' });
  } else if (scope === 'workspace') {
    useAuthStore.setState({ workspaceId: 'workspace-b' as Auth['workspaceId'] }); useAuthStore.setState({ workspaceId: 'workspace-a' as Auth['workspaceId'] });
  } else {
    useAuthStore.setState({ projectId: 'project-b' as Auth['projectId'] }); useAuthStore.setState({ projectId: 'project-a' as Auth['projectId'] });
  }
}
function input(saveAsDefault = false, capture = false) {
  return { parsed: { providers: { main: 'opencode' as const, worker: 'opencode' as const },
    taskText: `${capture ? 'Check on my screen' : 'Check this synthetic task'} ${serial}`, saveAsDefault },
    options: [], sourceChatId: `source-${serial}` };
}

beforeEach(() => {
  serial += 1;
  vi.clearAllMocks();
  mocks.ensureChat.mockResolvedValue(`target-${serial}`);
  mocks.history.mockResolvedValue([]);
  mocks.persist.mockResolvedValue({ id: `message-${serial}` });
  mocks.capture.mockResolvedValue({ ok: false, code: 'capture-unavailable', message: 'Synthetic capture unavailable.' });
  mocks.dispatch.mockImplementation(async (detail) => ({ status: 'accepted', chatId: detail.chatId, cancellationKey: String(detail.cancellationKey) }));
  useAuthStore.setState({ cloudSession: null, localUserId: 'account-a',
    workspaceId: 'workspace-a' as Auth['workspaceId'], projectId: 'project-a' as Auth['projectId'],
    voiceMainAgentProvider: 'codex', voiceWorkerProvider: 'codex' });
});

describe('typed provider directive original scope', () => {
  it.each(['account', 'workspace', 'project'] as const)('does not save defaults or send after a %s round trip during chat creation', async (scope) => {
    const pending = deferred<string>(); mocks.ensureChat.mockReturnValue(pending.promise);
    const outcome = startTypedAgentOverride(input(true)).then(() => 'sent', () => 'rejected');
    await vi.waitFor(() => expect(mocks.ensureChat).toHaveBeenCalledOnce());
    scopeRoundTrip(scope); pending.resolve(`target-${serial}`);
    expect(await outcome).toBe('rejected');
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('codex');
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each(['account', 'workspace', 'project'] as const)('does not persist or dispatch after a %s round trip during history loading', async (scope) => {
    const pending = deferred<unknown[]>(); mocks.history.mockReturnValue(pending.promise);
    const outcome = startTypedAgentOverride(input()).then(() => 'sent', () => 'rejected');
    await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
    scopeRoundTrip(scope); pending.resolve([]);
    expect(await outcome).toBe('rejected');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does not capture or dispatch after scope changes during message persistence', async () => {
    const pending = deferred<{ id: string }>(); mocks.persist.mockReturnValue(pending.promise);
    const outcome = startTypedAgentOverride(input(false, true)).then(() => 'sent', () => 'rejected');
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    scopeRoundTrip('account'); pending.resolve({ id: `message-${serial}` });
    expect(await outcome).toBe('rejected');
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch a completed capture after the scope was revoked', async () => {
    const pending = deferred<{ ok: false; code: string; message: string }>(); mocks.capture.mockReturnValue(pending.promise);
    const outcome = startTypedAgentOverride(input(false, true)).then(() => 'sent', () => 'rejected');
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    scopeRoundTrip('workspace'); pending.resolve({ ok: false, code: 'capture-unavailable', message: 'Synthetic limitation.' });
    expect(await outcome).toBe('rejected');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('retains explicit default saving and one dispatch while the original scope is current', async () => {
    expect(await startTypedAgentOverride(input(true))).toBe(`target-${serial}`);
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('opencode');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('opencode');
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a', speakReply: false }));
  });

  it('permits a same-task retry after scope revocation without replaying the cancelled coordinator entry', async () => {
    const pending = deferred<{ id: string }>(); mocks.persist.mockReturnValueOnce(pending.promise);
    const request = input();
    const outcome = startTypedAgentOverride(request).then(() => 'sent', () => 'rejected');
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    scopeRoundTrip('account'); pending.resolve({ id: `revoked-${serial}` });
    expect(await outcome).toBe('rejected');
    mocks.persist.mockResolvedValue({ id: `retry-${serial}` });
    expect(await startTypedAgentOverride(request)).toBe(`target-${serial}`);
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it('keeps ordinary accepted duplicate protection in an unchanged scope', async () => {
    const request = input();
    await startTypedAgentOverride(request);
    await startTypedAgentOverride(request);
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it('retains an already accepted dispatch and suppresses its stale success toast', async () => {
    const pending = deferred<{ status: 'accepted'; chatId: string; cancellationKey: string }>();
    mocks.dispatch.mockReturnValueOnce(pending.promise);
    const operation = startTypedAgentOverride(input());
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    scopeRoundTrip('project');
    pending.resolve({ status: 'accepted', chatId: `target-${serial}`, cancellationKey: `message-${serial}` });
    expect(await operation).toBe(`target-${serial}`);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(['success', 'chat unavailable', 'history failed'] as const)('removes its scope subscription after %s', async (outcome) => {
    const subscribe = useAuthStore.subscribe;
    const offs: ReturnType<typeof vi.fn>[] = [];
    const spy = vi.spyOn(useAuthStore, 'subscribe').mockImplementation((listener) => {
      const off = subscribe(listener);
      const tracked = vi.fn(() => { off(); }); offs.push(tracked); return tracked;
    });
    try {
      if (outcome === 'chat unavailable') mocks.ensureChat.mockResolvedValueOnce(null);
      if (outcome === 'history failed') mocks.history.mockRejectedValueOnce(new Error('Synthetic history error'));
      const result = await startTypedAgentOverride(input()).then(() => 'sent', () => 'rejected');
      expect(result).toBe(outcome === 'success' ? 'sent' : 'rejected');
      expect(offs).toHaveLength(1);
      expect(offs[0]).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
});

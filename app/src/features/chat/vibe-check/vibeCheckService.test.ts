import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  auth: {
    workspaceId: 'ws',
    projectId: null,
    localUserId: 'owner',
    chatModelSelection: { mode: 'none' },
  },
  chats: new Map<string, any>(),
  messages: new Map<string, any[]>(),
  run: undefined as any,
  cross: vi.fn(),
  send: vi.fn(),
  policy: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => f.auth, subscribe: () => () => {} },
}));
vi.mock('@/lib/accountIdentity', () => ({
  resolveAccountIdentity: () => ({ accountId: 'owner' }),
}));
vi.mock('@/lib/cloudSyncQueueOwner', () => ({ captureSyncQueueOwner: () => ({}) }));
vi.mock('@/lib/db/repositories', () => ({
  chatRepo: {
    getById: async (id: string) => f.chats.get(id),
    createAuthorized: async (input: any, _owner: any, valid: () => boolean) =>
      valid() ? { ...input, id: 'auditor' } : null,
  },
  workspaceRepo: { getById: async () => ({ owner_id: 'owner' }) },
  messageRepo: {
    listByChat: async (id: string) => f.messages.get(id) ?? [],
    create: async (input: any) => {
      const message = { ...input, id: 'audit-request', created_at: Date.now() };
      f.messages.set(input.chat_id, [...(f.messages.get(input.chat_id) ?? []), message]);
      return message;
    },
  },
}));
vi.mock('../chatToChatDispatch', () => ({
  dispatchChatToChat: f.cross,
  dispatchJarvisSendWithAcceptance: f.send,
}));
vi.mock('../runtime/chatRunState', () => ({ getChatRunState: () => f.run }));
vi.mock('../runtime/chatRuntimeSettingsStore', () => ({
  readChatRuntimePolicyState: () => ({ settings: {}, access: 'full' }),
  writeChatRuntimePolicyState: f.policy,
}));
vi.mock('../reasoningSlashStore', () => ({ readChatReasoningPreference: () => undefined }));
vi.mock('../activity/activityStore', () => ({ getChatActivityEvents: () => [] }));
vi.mock('@/lib/ai/modelSelection', () => ({ selectionFromOption: vi.fn() }));
import { closeVibeCheck, openVibeCheck, useVibeCheckStore } from './vibeCheckStore';
import { startVibeCheck, waitForAuditSlot } from './vibeCheckService';
const emit = (detail: any) => window.dispatchEvent(new CustomEvent('jarvis:run-state', { detail }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  f.run = undefined;
  f.chats.clear();
  f.messages.clear();
  f.auth.workspaceId = 'ws';
  f.chats.set('source', {
    id: 'source',
    workspace_id: 'ws',
    project_id: null,
    title: 'Source',
    mode: 'chat',
    created_at: 1,
    updated_at: 1,
    active_agent_ids: [],
  });
  f.messages.set('source', [
    {
      id: 'old',
      chat_id: 'source',
      role: 'assistant',
      created_at: 1,
      parts: [{ kind: 'text', text: 'old work' }],
    },
  ]);
  f.cross.mockImplementation(async () => {
    f.messages.set('auditor', [{ id: 'request', role: 'user', parts: [] }]);
    emit({ chatId: 'auditor', cancellationKey: 'request', status: 'running' });
    return { status: 'dispatched', messageId: 'request' };
  });
  f.send.mockImplementation(async (detail: any) =>
    emit({ chatId: detail.chatId, cancellationKey: detail.cancellationKey, status: 'running' }),
  );
  openVibeCheck('source');
});
afterEach(() => {
  closeVibeCheck();
  vi.useRealTimers();
});
describe('VibeCheck dispatch lifecycle', () => {
  it('starts a separate read-only auditor without interrupting the source', async () => {
    f.run = { chatId: 'source', status: 'running', cancellationKey: 'source-turn' };
    const cancel = vi.fn();
    window.addEventListener('jarvis:cancel', cancel);
    await startVibeCheck({ auditor: 'new', interrupt: false });
    expect(f.cross).toHaveBeenCalledOnce();
    expect(f.policy).toHaveBeenCalledWith(
      'auditor',
      expect.objectContaining({ access: 'read-only', approveAllForRun: false }),
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(useVibeCheckStore.getState().session?.status).toBe('running');
    window.removeEventListener('jarvis:cancel', cancel);
  });
  it('queues a main-agent audit until the source is idle', async () => {
    f.run = { status: 'running', cancellationKey: 'source-turn' };
    const pending = startVibeCheck({ auditor: 'main', interrupt: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(f.send).not.toHaveBeenCalled();
    f.run = undefined;
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'source',
        accessLevel: 'read-only',
        interactionMode: 'ask',
        queueIfBusy: true,
      }),
    );
  });
  it('interrupts only the exact source key when requested', async () => {
    f.run = { status: 'running', cancellationKey: 'exact-source' };
    const cancel = vi.fn((_event: Event) => {
      f.run = undefined;
    });
    window.addEventListener('jarvis:cancel', cancel);
    const pending = waitForAuditSlot('source', new AbortController().signal, true);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect((cancel.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      messageId: 'exact-source',
    });
    expect(cancel).toHaveBeenCalledOnce();
    window.removeEventListener('jarvis:cancel', cancel);
  });
  it('cancels a waiting audit on close without sending or interrupting source', async () => {
    f.run = { status: 'running', cancellationKey: 'source-turn' };
    const pending = startVibeCheck({ auditor: 'main', interrupt: false });
    await vi.advanceTimersByTimeAsync(200);
    closeVibeCheck();
    await pending;
    expect(f.send).not.toHaveBeenCalled();
    expect(useVibeCheckStore.getState().session).toBeNull();
  });
  it('keeps unrelated run output out and does not complete on acceptance', async () => {
    await startVibeCheck({ auditor: 'new', interrupt: false });
    emit({ chatId: 'auditor', cancellationKey: 'other', status: 'done' });
    expect(useVibeCheckStore.getState().session?.status).toBe('running');
    f.messages.get('auditor')!.push(
      {
        id: 'answer',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Verified audit findings' }],
      },
      { id: 'next', role: 'user', parts: [] },
      { id: 'unrelated', role: 'assistant', parts: [{ kind: 'text', text: 'UNRELATED' }] },
    );
    emit({ chatId: 'auditor', cancellationKey: 'request', status: 'done' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVibeCheckStore.getState().session).toMatchObject({
      status: 'complete',
      progress: 100,
      report: 'Verified audit findings',
    });
  });
  it('rejects cross-workspace source access before creating an audit', async () => {
    f.chats.get('source').workspace_id = 'foreign';
    await startVibeCheck({ auditor: 'new', interrupt: false });
    expect(f.cross).not.toHaveBeenCalled();
    expect(useVibeCheckStore.getState().session?.status).toBe('error');
  });
  it('shows a truthful failure when a completed run has no report', async () => {
    await startVibeCheck({ auditor: 'new', interrupt: false });
    emit({ chatId: 'auditor', cancellationKey: 'request', status: 'done' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(useVibeCheckStore.getState().session?.status).toBe('error');
  });
});

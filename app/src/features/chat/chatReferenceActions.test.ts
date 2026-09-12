import { describe, expect, it, vi } from 'vitest';
import { executeChatReferenceAction, type ChatReferenceDependencies } from './chatReferenceActions';
import type { Chat, Message } from '@/types/chat';
import {
  createJarvisActionCatalog,
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
} from '@/lib/jarvis/actions/catalog';

const chat = (id: string, workspace = 'ws') =>
  ({
    id,
    workspace_id: workspace,
    title: id,
    project_id: null,
    created_at: 1,
    updated_at: 1,
    mode: 'chat',
    active_agent_ids: [],
  }) as unknown as Chat;
function fixture() {
  const messages = [
    {
      id: 'm1',
      chat_id: 'source',
      role: 'user',
      created_at: 1,
      updated_at: 1,
      parts: [{ kind: 'text', text: 'Oldest detail ' + 'x'.repeat(35000) + ' final detail' }],
    },
  ] as unknown as Message[];
  const scope = { accountId: 'owner', workspaceId: 'ws', epoch: 1 };
  const deps: ChatReferenceDependencies = {
    scope: () => scope,
    getChat: async (id) => chat(id),
    getWorkspace: async () => ({ owner_id: 'owner' }),
    listMessages: async (id) =>
      id === 'receiver'
        ? ([
            { parts: [{ kind: 'chat_handoff', handoff: { sourceChatId: 'source' } }] },
          ] as unknown as Message[])
        : messages,
    dispatch: vi.fn(async () => ({
      status: 'dispatched' as const,
      dispatchKey: 'key',
      targetChatId: 'source',
      messageId: 'sent',
    })),
    now: () => 100,
  };
  return { deps, scope, messages };
}
const ctx = { source: 'ai' as const, chatId: 'receiver', accountId: 'owner', callId: 'call-1' };
describe('chat reference actions', () => {
  it('reuses the persisted reference snapshot when retrying the same send action', async () => {
    const { deps, messages } = fixture();
    const dispatch = vi.mocked(deps.dispatch);
    await executeChatReferenceAction('send', { chatId: 'source', message: 'Hello' }, ctx, deps);
    const original = dispatch.mock.calls[0][0];
    messages.push({
      id: 'sent',
      chat_id: 'source',
      role: 'user',
      created_at: 100,
      updated_at: 100,
      parts: [
        {
          kind: 'chat_handoff',
          handoff: {
            version: 1,
            sourceChatId: 'receiver',
            sourceTitle: 'receiver',
            snapshotAt: 100,
            boundaryMessageId: null,
            instruction: 'Hello',
            projection: original.projection,
            dispatchKey: original.dispatchKey,
          },
        },
      ],
    } as Message);
    deps.now = () => 200;
    await executeChatReferenceAction('send', { chatId: 'source', message: 'Hello' }, ctx, deps);
    expect(dispatch.mock.calls[1][0]).toEqual(original);
  });
  it('registers bounded read and approved send actions with exact target validation', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const read = catalog.resolve('chat.read')!;
    const send = catalog.resolve('chat.send')!;
    expect(read.approval).toBe('never');
    expect(send.approval).toBe('always');
    expect(read.validateParameters({ chatId: 'source', offset: 16000 })).toEqual({
      chatId: 'source',
      offset: 16000,
    });
    expect(() => read.validateParameters({ chatId: 'source', offset: -1 })).toThrow();
    expect(() =>
      send.validateParameters({ chatId: 'source', message: 'Hello', accountId: 'other' }),
    ).toThrow();
  });
  it('redacts credentials and excludes private reasoning from retrieved history', async () => {
    const { deps, messages } = fixture();
    messages[0].parts = [
      { kind: 'text', text: 'password=hunter42 visible result' },
      { kind: 'reasoning', text: 'private thought' },
    ] as Message['parts'];
    const result = await executeChatReferenceAction('read', { chatId: 'source' }, ctx, deps);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain('visible result');
    expect(JSON.stringify(result)).not.toContain('hunter42');
    expect(JSON.stringify(result)).not.toContain('private thought');
  });
  it('pages the entire old visible history without losing the beginning or end', async () => {
    const { deps } = fixture();
    let offset = 0;
    let transcript = '';
    do {
      const result = await executeChatReferenceAction(
        'read',
        { chatId: 'source', offset, snapshotAt: 100 },
        ctx,
        deps,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const data = result.data as {
        text: string;
        nextOffset: number | null;
        activityFile: { content: string };
      };
      transcript += data.text;
      expect(data.text.length).toBeLessThanOrEqual(16000);
      expect(data.activityFile.content).toContain('source');
      offset = data.nextOffset ?? -1;
    } while (offset !== -1);
    expect(transcript).toContain('Oldest detail ' + 'x'.repeat(35000) + ' final detail');
  });
  it('rejects an unreferenced or different-workspace chat', async () => {
    const { deps } = fixture();
    expect((await executeChatReferenceAction('read', { chatId: 'other' }, ctx, deps)).ok).toBe(
      false,
    );
    deps.getChat = async (id) => chat(id, id === 'source' ? 'other-ws' : 'ws');
    expect((await executeChatReferenceAction('read', { chatId: 'source' }, ctx, deps)).ok).toBe(
      false,
    );
  });
  it('rejects scope changes during retrieval', async () => {
    const { deps, scope } = fixture();
    deps.listMessages = async () => {
      scope.epoch++;
      return [];
    };
    expect((await executeChatReferenceAction('read', { chatId: 'source' }, ctx, deps)).ok).toBe(
      false,
    );
  });
  it('returns delivery failure honestly and uses stable action identity', async () => {
    const { deps } = fixture();
    deps.dispatch = vi.fn(async () => ({
      status: 'failed' as const,
      reason: 'runtime_rejected' as const,
      dispatchKey: 'key',
      targetChatId: 'source',
      messageId: 'sent',
    }));
    const result = await executeChatReferenceAction(
      'send',
      { chatId: 'source', message: 'Please check the build' },
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'receiver',
        targetChatId: 'source',
        instruction: 'Please check the build',
        dispatchKey: expect.stringContaining('call-1'),
      }),
    );
  });
});

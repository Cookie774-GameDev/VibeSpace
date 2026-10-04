import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Chat, ChatId, WorkspaceId } from '@/types';
import type { ProviderConnection } from '@/lib/ai/adapters/types';
import { createStoredChatNavigator, type StoredChatNavigationDependencies } from './openStoredChat';

const CAPABILITIES = {
  text: true,
  images: false,
  files: false,
  tools: false,
  modelSelection: true,
  structuredOutput: false,
  streaming: true,
  cancellation: true,
  resumeSession: true,
  systemPrompt: true,
  workingDirectory: true,
  usage: true,
  subscriptionQuota: false,
  localOnly: false,
} as const;

const CONNECTION: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-cli',
  providerId: 'openai',
  displayName: 'Codex CLI',
  mode: 'external-cli',
  authSource: 'cli-session',
  modelId: 'gpt-5.6-sol',
  capabilities: CAPABILITIES,
  promptTransport: 'native-system',
  enabled: true,
};

function chat(id = 'chat-a', workspaceId = 'workspace-a'): Chat {
  return {
    id: id as ChatId,
    workspace_id: workspaceId as WorkspaceId,
    title: id,
    mode: 'chat',
    active_agent_ids: [],
    connection: CONNECTION,
    created_at: 1,
    updated_at: 2,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('stored chat navigation', () => {
  const events: string[] = [];
  const getScope = vi.fn<StoredChatNavigationDependencies['getScope']>(() => ({
    accountId: 'account-a',
    workspaceId: 'workspace-a',
  }));
  const getChat = vi.fn<StoredChatNavigationDependencies['getChat']>(async (chatId: ChatId) =>
    chat(String(chatId)),
  );
  const restoreExactModel = vi.fn<StoredChatNavigationDependencies['restoreExactModel']>(() =>
    events.push('model'),
  );
  const readStoredEngine = vi.fn<StoredChatNavigationDependencies['readStoredEngine']>(() => ({
    engine: 'browser',
    providerId: 'chatgpt',
  }));
  const restoreExactEngine = vi.fn<StoredChatNavigationDependencies['restoreExactEngine']>(() =>
    events.push('engine'),
  );
  const activateAndRoute = vi.fn<StoredChatNavigationDependencies['activateAndRoute']>(() =>
    events.push('route'),
  );
  const restoreArchivedChat = vi.fn(async (_chatId: ChatId) => { events.push('restore'); });
  const deps = {
    getScope,
    getChat,
    restoreExactModel,
    readStoredEngine,
    restoreExactEngine,
    activateAndRoute,
    restoreArchivedChat,
  } satisfies StoredChatNavigationDependencies;

  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    deps.getScope.mockReturnValue({ accountId: 'account-a', workspaceId: 'workspace-a' });
    deps.getChat.mockImplementation(async (chatId: ChatId) => chat(String(chatId)));
    deps.readStoredEngine.mockReturnValue({ engine: 'browser', providerId: 'chatgpt' });
  });

  it('restores exact model and engine identity before one atomic activation', async () => {
    const openStoredChat = createStoredChatNavigator(deps);

    await expect(openStoredChat('chat-a' as ChatId)).resolves.toEqual({
      status: 'opened',
      chatId: 'chat-a',
      model: 'restored',
    });

    expect(deps.restoreExactModel).toHaveBeenCalledWith(CONNECTION);
    expect(deps.restoreExactEngine).toHaveBeenCalledWith('chat-a', {
      engine: 'browser',
      providerId: 'chatgpt',
    });
    expect(deps.activateAndRoute).toHaveBeenCalledWith('chat-a', null);
    expect(events).toEqual(['model', 'engine', 'route']);
  });

  it('restores the exact archived chat before opening it for continued messaging', async () => {
    deps.getChat.mockResolvedValueOnce({ ...chat(), archived: true });
    const restored = deferred<void>();
    restoreArchivedChat.mockImplementationOnce(() => restored.promise);
    const request = createStoredChatNavigator(deps)('chat-a' as ChatId);
    await vi.waitFor(() => expect(restoreArchivedChat).toHaveBeenCalledWith('chat-a'));
    expect(activateAndRoute).not.toHaveBeenCalled();
    restored.resolve();
    await expect(request).resolves.toMatchObject({ status: 'opened', chatId: 'chat-a' });
    expect(activateAndRoute).toHaveBeenCalledOnce();
  });

  it('opens messages when the exact stored model is unavailable without selecting a replacement', async () => {
    deps.restoreExactModel.mockImplementationOnce(() => {
      events.push('model');
      throw new Error('model unavailable');
    });
    const openStoredChat = createStoredChatNavigator(deps);

    await expect(openStoredChat('chat-a' as ChatId)).resolves.toEqual({
      status: 'opened',
      chatId: 'chat-a',
      model: 'unavailable',
    });

    expect(deps.restoreExactModel).toHaveBeenCalledTimes(1);
    expect(deps.activateAndRoute).toHaveBeenCalledWith('chat-a', null);
    expect(events).toEqual(['model', 'engine', 'route']);
  });

  it('fails closed for missing, foreign-workspace, or unauthenticated chats', async () => {
    const openStoredChat = createStoredChatNavigator(deps);
    deps.getChat.mockResolvedValueOnce(undefined);
    await expect(openStoredChat('missing' as ChatId)).resolves.toEqual({ status: 'not-found' });

    deps.getChat.mockResolvedValueOnce(chat('foreign', 'workspace-b'));
    await expect(openStoredChat('foreign' as ChatId)).resolves.toEqual({ status: 'forbidden' });

    deps.getScope.mockReturnValueOnce({ accountId: null, workspaceId: 'workspace-a' });
    await expect(openStoredChat('chat-a' as ChatId)).resolves.toEqual({ status: 'forbidden' });

    expect(deps.restoreExactModel).not.toHaveBeenCalled();
    expect(deps.restoreExactEngine).not.toHaveBeenCalled();
    expect(deps.activateAndRoute).not.toHaveBeenCalled();
  });

  it('allows only the newest rapid navigation request to activate', async () => {
    const first = deferred<Chat | undefined>();
    deps.getChat
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(chat('chat-newest'));
    const openStoredChat = createStoredChatNavigator(deps);

    const olderRequest = openStoredChat('chat-older' as ChatId);
    const newerRequest = openStoredChat('chat-newest' as ChatId);
    await expect(newerRequest).resolves.toMatchObject({ status: 'opened', chatId: 'chat-newest' });
    first.resolve(chat('chat-older'));
    await expect(olderRequest).resolves.toEqual({ status: 'superseded' });

    expect(deps.activateAndRoute).toHaveBeenCalledTimes(1);
    expect(deps.activateAndRoute).toHaveBeenCalledWith('chat-newest', null);
  });

  it('does not activate when the account or workspace changes during lookup', async () => {
    const lookup = deferred<Chat | undefined>();
    deps.getChat.mockImplementationOnce(() => lookup.promise);
    const openStoredChat = createStoredChatNavigator(deps);
    const request = openStoredChat('chat-a' as ChatId);

    deps.getScope.mockReturnValue({ accountId: 'account-b', workspaceId: 'workspace-b' });
    lookup.resolve(chat('chat-a'));

    await expect(request).resolves.toEqual({ status: 'superseded' });
    expect(deps.activateAndRoute).not.toHaveBeenCalled();
  });
});

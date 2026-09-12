import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_ENGINE_OPTIONS,
  createChatEngineTransition,
  type ChatEngineTransitionDependencies,
  type ChatEngineTransitionScope,
} from './chatEngineTransition';

const SOURCE_SCOPE: ChatEngineTransitionScope = {
  accountId: 'account-a',
  accountSource: 'local',
  syncOwner: { state: 'unbound', capturedAt: 1 },
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  activeChatId: 'chat-native',
};

function dependencies(
  overrides: Partial<ChatEngineTransitionDependencies> = {},
): ChatEngineTransitionDependencies {
  return {
    countMessages: vi.fn(async () => 0),
    createChat: vi.fn(async (_scope, _canCommit, beforeActivate) =>
      beforeActivate('new-chat') ? 'new-chat' : null,
    ),
    getEngine: vi.fn((): 'native' => 'native'),
    getScope: vi.fn((chatId: string) => ({ ...SOURCE_SCOPE, activeChatId: chatId })),
    reuseEmptyChat: vi.fn(async (_chatId, mutate) => mutate()),
    setEngine: vi.fn(),
    ...overrides,
  };
}

describe('chat engine transition', () => {
  it('shares the exact VibeSpace Chat and Browser Chat choices', () => {
    expect(CHAT_ENGINE_OPTIONS).toEqual([
      {
        id: 'native',
        label: 'VibeSpace Chat',
        description: 'Models, local AI, agents, files, tools, voice, and Prompt Forge.',
      },
      {
        id: 'browser',
        label: 'Browser Chat',
        description: 'Real ChatGPT in an isolated VibeSpace browser surface.',
      },
    ]);
  });

  it('reuses an empty chat and persists the selected engine on it', async () => {
    const deps = dependencies();
    const transition = createChatEngineTransition(deps);

    await expect(transition({ chatId: 'chat-empty', targetEngine: 'browser' })).resolves.toEqual({
      status: 'reused',
      chatId: 'chat-empty',
      engine: 'browser',
    });
    expect(deps.countMessages).toHaveBeenCalledWith('chat-empty');
    expect(deps.createChat).not.toHaveBeenCalled();
    expect(deps.setEngine).toHaveBeenCalledWith('browser', 'chat-empty');
  });

  it('opens the existing ChatGPT Browser Chat instead of creating another', async () => {
    const activateChat = vi.fn();
    const deps = dependencies({
      countMessages: vi.fn(async () => 2),
      findExistingBrowserChat: vi.fn(() => 'chat-chatgpt'),
      activateChat,
    });
    const transition = createChatEngineTransition(deps);

    await expect(
      transition({ chatId: 'chat-native-history', targetEngine: 'browser' }),
    ).resolves.toEqual({
      status: 'reused',
      chatId: 'chat-chatgpt',
      engine: 'browser',
    });
    expect(activateChat).toHaveBeenCalledWith('chat-chatgpt');
    expect(deps.createChat).not.toHaveBeenCalled();
    expect(deps.setEngine).not.toHaveBeenCalled();
  });

  it('opens a new chat in the selected engine when the current chat has messages', async () => {
    const deps = dependencies({
      countMessages: vi.fn(async () => 2),
      createChat: vi.fn(async (_scope, _canCommit, beforeActivate) =>
        beforeActivate('chat-browser') ? 'chat-browser' : null,
      ),
    });
    const transition = createChatEngineTransition(deps);

    await expect(
      transition({ chatId: 'chat-native-history', targetEngine: 'browser' }),
    ).resolves.toEqual({
      status: 'created',
      chatId: 'chat-browser',
      engine: 'browser',
    });
    expect(deps.setEngine).toHaveBeenCalledTimes(1);
    expect(deps.setEngine).toHaveBeenCalledWith('browser', 'chat-browser');
    expect(deps.setEngine).not.toHaveBeenCalledWith('browser', 'chat-native-history');
  });

  it('does nothing when the selected engine is already active', async () => {
    const deps = dependencies({ getEngine: vi.fn((): 'browser' => 'browser') });
    const transition = createChatEngineTransition(deps);

    await expect(transition({ chatId: 'chat-browser', targetEngine: 'browser' })).resolves.toEqual({
      status: 'unchanged',
      chatId: 'chat-browser',
      engine: 'browser',
    });
    expect(deps.countMessages).not.toHaveBeenCalled();
    expect(deps.createChat).not.toHaveBeenCalled();
    expect(deps.setEngine).not.toHaveBeenCalled();
  });

  it('fails without mutating either chat when populated-chat creation fails', async () => {
    const deps = dependencies({
      countMessages: vi.fn(async () => 1),
      createChat: vi.fn(async () => null),
    });
    const transition = createChatEngineTransition(deps);

    await expect(transition({ chatId: 'chat-native', targetEngine: 'browser' })).resolves.toEqual({
      status: 'failed',
      chatId: 'chat-native',
      engine: 'native',
    });
    expect(deps.setEngine).not.toHaveBeenCalled();
  });

  it('coalesces rapid duplicate selections into one new chat', async () => {
    let release: ((chatId: string) => void) | undefined;
    const created = new Promise<string>((resolve) => {
      release = resolve;
    });
    const deps = dependencies({
      countMessages: vi.fn(async () => 1),
      createChat: vi.fn(async (_scope, _canCommit, beforeActivate) => {
        const chatId = await created;
        return beforeActivate(chatId) ? chatId : null;
      }),
    });
    const transition = createChatEngineTransition(deps);

    const first = transition({ chatId: 'chat-native', targetEngine: 'browser' });
    const second = transition({ chatId: 'chat-native', targetEngine: 'browser' });
    release?.('chat-browser');

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'created', chatId: 'chat-browser', engine: 'browser' },
      { status: 'created', chatId: 'chat-browser', engine: 'browser' },
    ]);
    expect(deps.createChat).toHaveBeenCalledOnce();
  });

  it('honors the latest opposite-target intent while classification is in flight', async () => {
    let releaseCount: ((count: number) => void) | undefined;
    const pendingCount = new Promise<number>((resolve) => {
      releaseCount = resolve;
    });
    const deps = dependencies({
      countMessages: vi.fn(() => pendingCount),
    });
    const transition = createChatEngineTransition(deps);

    const selectBrowser = transition({ chatId: 'chat-native', targetEngine: 'browser' });
    const selectNative = transition({ chatId: 'chat-native', targetEngine: 'native' });
    releaseCount?.(0);

    await expect(Promise.all([selectBrowser, selectNative])).resolves.toEqual([
      { status: 'unchanged', chatId: 'chat-native', engine: 'native' },
      { status: 'unchanged', chatId: 'chat-native', engine: 'native' },
    ]);
    expect(deps.setEngine).not.toHaveBeenCalled();
    expect(deps.createChat).not.toHaveBeenCalled();
  });

  it('revokes commit authority when the opposite target arrives during scoped creation', async () => {
    let releaseCreate: (() => void) | undefined;
    let createStarted: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createReady = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const commitChecks: boolean[] = [];
    const deps = dependencies({
      countMessages: vi.fn(async () => 1),
      createChat: vi.fn(async (_scope, canCommit, beforeActivate) => {
        createStarted?.();
        await createGate;
        const authorized = canCommit();
        commitChecks.push(authorized);
        if (!authorized) return null;
        return beforeActivate('chat-browser') ? 'chat-browser' : null;
      }),
    });
    const transition = createChatEngineTransition(deps);

    const selectBrowser = transition({ chatId: 'chat-native', targetEngine: 'browser' });
    await createReady;
    const selectNative = transition({ chatId: 'chat-native', targetEngine: 'native' });
    releaseCreate?.();

    await expect(Promise.all([selectBrowser, selectNative])).resolves.toEqual([
      { status: 'unchanged', chatId: 'chat-native', engine: 'native' },
      { status: 'unchanged', chatId: 'chat-native', engine: 'native' },
    ]);
    expect(commitChecks).toEqual([false]);
    expect(deps.setEngine).not.toHaveBeenCalled();
  });

  it('fails closed when account, workspace, project, or active chat drifts during classification', async () => {
    let releaseCount: ((count: number) => void) | undefined;
    const pendingCount = new Promise<number>((resolve) => {
      releaseCount = resolve;
    });
    let scope = SOURCE_SCOPE;
    const deps = dependencies({
      countMessages: vi.fn(() => pendingCount),
      getScope: vi.fn(() => scope),
    });
    const transition = createChatEngineTransition(deps);

    const pending = transition({ chatId: 'chat-native', targetEngine: 'browser' });
    scope = {
      ...SOURCE_SCOPE,
      accountId: 'account-b',
      workspaceId: 'workspace-b',
      projectId: 'project-b',
      activeChatId: 'chat-other',
    };
    releaseCount?.(1);

    await expect(pending).resolves.toEqual({
      status: 'failed',
      chatId: 'chat-native',
      engine: 'native',
    });
    expect(deps.createChat).not.toHaveBeenCalled();
    expect(deps.setEngine).not.toHaveBeenCalled();
  });

  it('creates a new scoped chat when atomic empty reuse observes a committed message', async () => {
    const deps = dependencies({
      countMessages: vi.fn(async () => 0),
      reuseEmptyChat: vi.fn(async () => false),
      createChat: vi.fn(async (_scope, _canCommit, beforeActivate) =>
        beforeActivate('chat-browser') ? 'chat-browser' : null,
      ),
    });
    const transition = createChatEngineTransition(deps);

    await expect(transition({ chatId: 'chat-native', targetEngine: 'browser' })).resolves.toEqual({
      status: 'created',
      chatId: 'chat-browser',
      engine: 'browser',
    });
    expect(deps.countMessages).toHaveBeenCalledOnce();
    expect(deps.reuseEmptyChat).toHaveBeenCalledOnce();
    expect(deps.createChat).toHaveBeenCalledOnce();
    expect(deps.setEngine).toHaveBeenCalledWith('browser', 'chat-browser');
    expect(deps.setEngine).not.toHaveBeenCalledWith('browser', 'chat-native');
  });

  it('does not activate or persist the engine when scope drifts during explicit creation', async () => {
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let scope = SOURCE_SCOPE;
    let activated = false;
    const deps = dependencies({
      countMessages: vi.fn(async () => 1),
      getScope: vi.fn(() => scope),
      createChat: vi.fn(async (_capturedScope, _canCommit, beforeActivate) => {
        await createGate;
        if (!beforeActivate('chat-browser')) return null;
        activated = true;
        return 'chat-browser';
      }),
    });
    const transition = createChatEngineTransition(deps);

    const pending = transition({ chatId: 'chat-native', targetEngine: 'browser' });
    scope = { ...SOURCE_SCOPE, accountId: 'account-b' };
    releaseCreate?.();

    await expect(pending).resolves.toEqual({
      status: 'failed',
      chatId: 'chat-native',
      engine: 'native',
    });
    expect(activated).toBe(false);
    expect(deps.setEngine).not.toHaveBeenCalled();
  });
});

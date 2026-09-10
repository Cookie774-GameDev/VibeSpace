import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@/types/chat';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { VIBESPACE_CHAT_MIME, CHAT_OPEN_BESIDE_EVENT } from './chatDragPayload';
import { chatWorkspaceStorageKey } from './chatWorkspaceLayout';
import { ChatView } from './ChatView';
import { useChatPointerDrag } from './useChatPointerDrag';

function DragSource({ chat }: { chat: Chat }) {
  return (
    <div {...useChatPointerDrag(chat)} data-testid={`source-${chat.id}`}>
      <button>{chat.title}</button>
    </div>
  );
}

const chats = vi.hoisted(() =>
  ['chat-1', 'chat-2', 'chat-3', 'chat-4', 'chat-5'].map((id, index) => ({
    id: id as Chat['id'],
    workspace_id: 'workspace-a' as Chat['workspace_id'],
    project_id: 'project-a' as NonNullable<Chat['project_id']>,
    title: `Chat ${index + 1}`,
    mode: 'chat' as const,
    active_agent_ids: [],
    created_at: index + 1,
    updated_at: index + 1,
  })),
);

const testState = vi.hoisted(() => ({
  liveChats: undefined as unknown[] | undefined,
  getChat: vi.fn(),
  listMessages: vi.fn(),
  ensureActiveChat: vi.fn(),
  nativeDropHandler: undefined as ((event: { payload: unknown }) => void) | undefined,
  onDragDropEvent: vi.fn(),
  stopNativeDropListening: vi.fn(),
}));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, isTauri: true };
});

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: testState.onDragDropEvent }),
}));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => testState.liveChats }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    chatRepo: {
      ...actual.chatRepo,
      list: vi.fn(async () => testState.liveChats),
      getById: (...args: unknown[]) => testState.getChat(...args),
    },
    messageRepo: {
      ...actual.messageRepo,
      listByChat: (...args: unknown[]) => testState.listMessages(...args),
    },
  };
});

vi.mock('./chatLifecycle', () => ({ ensureActiveChat: () => testState.ensureActiveChat() }));
vi.mock('./ChatThread', () => ({
  ChatThread: ({ chatId }: { chatId: string }) => (
    <div data-testid={`thread-${chatId}`} data-chat-id={chatId} />
  ),
}));
vi.mock('./HarnessReadinessGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HarnessReadinessGate')>();
  return {
    ...actual,
    useHarnessRuntimeState: () => ({
      kind: 'ready' as const,
      source: 'managed' as const,
      version: 'test-runtime',
    }),
  };
});
vi.mock('@/features/browser/BrowserGoalStatus', () => ({
  BrowserGoalStatus: ({ chatId }: { chatId: string }) => (
    <div data-testid={`goal-${chatId}`} data-chat-id={chatId} />
  ),
}));
vi.mock('@/features/browser-chat', () => ({
  useBrowserChatStore: (selector: (state: object) => unknown) => selector({}),
  resolveChatEngine: () => 'native',
  BrowserChatHub: () => null,
}));
vi.mock('./OrigamiChatDecor', () => ({ OrigamiChatDecor: () => null }));
vi.mock('./WarmChatWelcome', () => ({ WarmChatWelcome: () => null }));
vi.mock('./TokenBossCinematic', () => ({ TokenBossCinematic: () => null }));
vi.mock('./ChatOutputPanel', () => ({
  ChatOutputPanel: ({ chatId, open }: { chatId: string; open: boolean }) => (
    <div data-testid={`output-${chatId}`} data-open={String(open)} />
  ),
}));
vi.mock('./EmptyChat', () => ({ EmptyChat: () => <div data-testid="empty-chat" /> }));

function typedTransfer(chatId: string) {
  const source = chats.find((chat) => String(chat.id) === chatId)!;
  return {
    types: [VIBESPACE_CHAT_MIME],
    files: [],
    getData: (type: string) =>
      type === VIBESPACE_CHAT_MIME
        ? JSON.stringify({
            version: 1,
            chatId,
            workspaceId: String(source.workspace_id),
            projectId: String(source.project_id),
            title: source.title,
          })
        : '',
  };
}

function openBesideDetail(chatId: string, title = `Forged ${chatId}`) {
  return {
    version: 1,
    chatId,
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    title,
  };
}

const scope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
};

async function settleComposerEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChatView handoff workspace integration', () => {
  it('keeps the confirmed layout through synchronous external navigation outside act batching', async () => {
    render(<ChatView />);
    await settleComposerEffects();
    // Deliberately exercise the real async continuation rather than having act
    // combine React local state with the synchronous Zustand notification.
    const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (const [index, chatId] of ['chat-2', 'chat-3', 'chat-4'].entries()) {
        window.dispatchEvent(
          new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: openBesideDetail(chatId) }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(useUIStore.getState().activeChatId).toBe(chatId);
        expect(screen.getByTestId('chat-workspace').getAttribute('data-pane-count')).toBe(
          String(index + 2),
        );
      }
      const saved = JSON.parse(localStorage.getItem(chatWorkspaceStorageKey(scope))!);
      expect(saved.chatIds).toEqual(['chat-1', 'chat-2', 'chat-3', 'chat-4']);
      useUIStore.getState().setActiveChat('chat-1');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.getByTestId('chat-workspace').getAttribute('data-pane-count')).toBe('4');
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
        actEnvironment;
    }
  });
  it('previews real panes on pointer hover, confirms up to four, restores membership and drags a pane out', async () => {
    class Transfer {
      values = new Map<string, string>();
      setData(type: string, value: string) {
        this.values.set(type, value);
      }
      getData(type: string) {
        return this.values.get(type) ?? '';
      }
      get types() {
        return [...this.values.keys()];
      }
    }
    class Drag extends MouseEvent {
      dataTransfer: DataTransfer | null;
      constructor(type: string, init: DragEventInit = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    }
    class Pointer extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal('DataTransfer', Transfer);
    vi.stubGlobal('DragEvent', Drag);
    vi.stubGlobal('PointerEvent', Pointer);
    const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    const hitTest = vi.fn();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTest });
    try {
      const view = render(
        <>
          <aside data-testid="sidebar">
            {chats.map((chat) => (
              <DragSource key={chat.id} chat={chat as Chat} />
            ))}
          </aside>
          <ChatView />
        </>,
      );
      await settleComposerEffects();
      for (const id of ['chat-2', 'chat-3', 'chat-4']) {
        fireEvent.pointerDown(screen.getByTestId(`source-${id}`).firstElementChild!, {
          button: 0,
          pointerId: 1,
          clientX: 0,
          clientY: 0,
        });
        hitTest.mockReturnValue(screen.getByTestId('thread-chat-1'));
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 100 });
        expect(screen.getByTestId(`thread-${id}`)).toBeTruthy();
        expect(screen.getByText('Release to confirm')).toBeTruthy();
        // Layout reflow can place the incoming composer's controls under the
        // pointer. That release must still confirm the preview, not send context.
        hitTest.mockReturnValue(
          screen.getByTestId(`chat-pane-${id}`).querySelector('[data-tour="chat-composer"]'),
        );
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 100 });
        await waitFor(() => expect(screen.queryByTestId('chat-layout-drop-preview')).toBeNull());
        expect(screen.getByTestId(`thread-${id}`)).toBeTruthy();
      }
      expect(screen.getByTestId('chat-workspace').getAttribute('data-pane-count')).toBe('4');
      for (const id of ['chat-1', 'chat-2', 'chat-3', 'chat-4']) {
        act(() => useUIStore.getState().setActiveChat(id));
        expect(screen.getByTestId('chat-workspace').getAttribute('data-pane-count')).toBe('4');
      }
      hitTest.mockReturnValue(screen.getByTestId('sidebar'));
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Focus Chat 2' }), {
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
      await waitFor(() => expect(screen.queryByTestId('thread-chat-2')).toBeNull());
      view.unmount();
      render(<ChatView />);
      await settleComposerEffects();
      expect(screen.getByTestId('chat-workspace').getAttribute('data-pane-count')).toBe('3');
    } finally {
      vi.unstubAllGlobals();
      if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });
  it('keeps a drop pending while its destination receives redundant focus', async () => {
    render(<ChatView />);
    await settleComposerEffects();
    let resolveSource!: (chat: Chat) => void;
    testState.getChat.mockImplementation((id: string) =>
      id === 'chat-2'
        ? new Promise<Chat>((resolve) => {
            resolveSource = resolve;
          })
        : Promise.resolve(chats.find((chat) => chat.id === id)),
    );
    fireEvent.drop(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: typedTransfer('chat-2'),
    });
    fireEvent.focus(screen.getByTestId('thread-chat-1'));
    await act(async () => {
      resolveSource(chats[1] as Chat);
    });
    await waitFor(() =>
      expect(screen.getByTestId('chat-workspace').getAttribute('data-pane-count')).toBe('2'),
    );
    act(() => useUIStore.getState().setActiveChat('chat-1'));
    expect(screen.getByTestId('thread-chat-2')).toBeTruthy();
  });
  it('does not revert a newly selected persisted chat while the live list catches up', async () => {
    testState.liveChats = [chats[0]];
    const view = render(<ChatView />);
    await screen.findByTestId('thread-chat-1');
    act(() => useUIStore.getState().setActiveChat('chat-2'));
    await settleComposerEffects();
    expect(useUIStore.getState().activeChatId).toBe('chat-2');
    testState.liveChats = chats;
    view.rerender(<ChatView />);
    await screen.findByTestId('thread-chat-2');
    expect(screen.queryByTestId('thread-chat-1')).toBeNull();
  });

  it('switches the mounted pane when the selected chat changes without retaining the old layout', async () => {
    render(<ChatView />);
    await screen.findByTestId('thread-chat-1');
    act(() => useUIStore.getState().setActiveChat('chat-2'));
    await waitFor(() => expect(screen.queryByTestId('thread-chat-1')).toBeNull());
    expect(screen.getByTestId('thread-chat-2')).toBeTruthy();
    expect(useUIStore.getState().activeChatId).toBe('chat-2');
  });

  beforeEach(() => {
    localStorage.clear();
    testState.liveChats = chats;
    testState.getChat.mockReset();
    testState.getChat.mockImplementation(async (id: string) =>
      chats.find((chat) => String(chat.id) === String(id)),
    );
    testState.listMessages.mockReset();
    testState.listMessages.mockResolvedValue([]);
    testState.ensureActiveChat.mockReset();
    testState.ensureActiveChat.mockResolvedValue(null);
    testState.nativeDropHandler = undefined;
    testState.stopNativeDropListening.mockReset();
    testState.onDragDropEvent.mockReset();
    testState.onDragDropEvent.mockImplementation(
      async (handler: (event: { payload: unknown }) => void) => {
        testState.nativeDropHandler = handler;
        return testState.stopNativeDropListening;
      },
    );
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a' as never,
      projectId: 'project-a' as never,
    });
    useUIStore.setState({ activeChatId: 'chat-1' });
    delete document.documentElement.dataset.monochromeChatState;
    delete document.documentElement.dataset.monochromeChatFixture;
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('opens a typed conversation-area drop beside the current chat and restores it from persistence', async () => {
    const first = render(<ChatView />);
    await settleComposerEffects();

    fireEvent.drop(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: typedTransfer('chat-2'),
    });

    await screen.findByTestId('chat-pane-chat-2');
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(chatWorkspaceStorageKey(scope))!)).toEqual({
      version: 1,
      chatIds: ['chat-1', 'chat-2'],
      focusedChatId: 'chat-2',
    });

    first.unmount();
    const restored = render(<ChatView />);
    await settleComposerEffects();
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(2);
    expect(
      restored.container.querySelector(
        '[data-composer-drop-zone="true"][data-terminal-drop-chat-id="chat-1"]',
      ),
    ).not.toBeNull();
    expect(
      restored.container.querySelector(
        '[data-composer-drop-zone="true"][data-terminal-drop-chat-id="chat-2"]',
      ),
    ).not.toBeNull();
  });

  it('keeps composer drops out of open-beside handling while the conversation region accepts them', async () => {
    const { container } = render(<ChatView />);

    fireEvent.drop(
      container.querySelector(
        '[data-composer-drop-zone="true"][data-terminal-drop-chat-id="chat-1"]',
      )!,
      {
        dataTransfer: typedTransfer('chat-2'),
      },
    );
    expect(screen.queryByTestId('chat-pane-chat-2')).toBeNull();

    fireEvent.drop(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: typedTransfer('chat-2'),
    });
    expect(await screen.findByTestId('chat-pane-chat-2')).toBeTruthy();
  });

  it('opens unrelated chats separately and restores each explicit group by any member', async () => {
    const view = render(<ChatView />);
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: openBesideDetail('chat-2') }),
    );
    await screen.findByTestId('chat-pane-chat-2');
    act(() => useUIStore.getState().setActiveChat('chat-3'));
    await waitFor(() => expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(1));
    expect(screen.getByTestId('chat-pane-chat-3')).toBeTruthy();
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: openBesideDetail('chat-4') }),
    );
    await screen.findByTestId('chat-pane-chat-4');
    for (const [chatId, expected] of [
      ['chat-1', ['chat-1', 'chat-2']],
      ['chat-5', ['chat-5']],
      ['chat-4', ['chat-3', 'chat-4']],
      ['chat-2', ['chat-1', 'chat-2']],
    ] as const) {
      act(() => useUIStore.getState().setActiveChat(chatId));
      await waitFor(() =>
        expect(
          screen.getAllByTestId(/^chat-pane-/).map((p) => p.getAttribute('data-chat-id')),
        ).toEqual(expected),
      );
    }
    view.unmount();
    render(<ChatView />);
    await screen.findByTestId('chat-pane-chat-1');
    expect(screen.getByTestId('chat-pane-chat-2')).toBeTruthy();
  });

  it('focuses and closes panes without cancelling their independent runs', async () => {
    const cancelled = vi.fn();
    window.addEventListener('jarvis:cancel', cancelled);
    render(<ChatView />);
    fireEvent.drop(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: typedTransfer('chat-2'),
    });
    const second = await screen.findByTestId('chat-pane-chat-2');

    fireEvent.click(screen.getByRole('button', { name: 'Focus Chat 1' }));
    expect(useUIStore.getState().activeChatId).toBe('chat-1');
    expect(screen.getByTestId('chat-pane-chat-1').getAttribute('data-focused')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Close Chat 1' }));
    expect(screen.queryByTestId('chat-pane-chat-1')).toBeNull();
    expect(second.getAttribute('data-focused')).toBe('true');
    expect(useUIStore.getState().activeChatId).toBe('chat-2');
    expect(cancelled).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:cancel', cancelled);
  });

  it.each([
    ['missing', 'missing-chat'],
    ['archived', 'archived-chat'],
    ['wrong-project', 'wrong-project-chat'],
  ])(
    'never mounts an inaccessible %s active chat and chooses a canonical fallback',
    async (_, id) => {
      testState.liveChats = [chats[0]];
      useUIStore.setState({ activeChatId: id });

      render(<ChatView />);

      await waitFor(() => expect(useUIStore.getState().activeChatId).toBe('chat-1'));
      expect(screen.queryByTestId(`thread-${id}`)).toBeNull();
      expect(screen.getByTestId('thread-chat-1')).toBeTruthy();
    },
  );

  it('falls through to the existing empty-chat creation flow when no canonical chat exists', async () => {
    testState.liveChats = [];
    useUIStore.setState({ activeChatId: 'missing-chat' });

    render(<ChatView />);

    await waitFor(() => expect(useUIStore.getState().activeChatId).toBeNull());
    await waitFor(() => expect(testState.ensureActiveChat).toHaveBeenCalled());
    expect(screen.queryByTestId('thread-missing-chat')).toBeNull();
  });

  it('never mounts a persisted stale surface while canonical access hydrates and durably clears an empty result', async () => {
    const key = chatWorkspaceStorageKey(scope);
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        chatIds: ['stale-chat'],
        focusedChatId: 'stale-chat',
      }),
    );
    testState.liveChats = undefined;
    useUIStore.setState({ activeChatId: 'stale-chat' });

    const first = render(<ChatView />);
    const firstRoot = first.container.querySelector('[data-vibespace-page="chat"]');
    expect(screen.queryByTestId('thread-stale-chat')).toBeNull();
    expect(first.container.querySelector('[data-composer-drop-zone="true"]')).toBeNull();
    expect(firstRoot?.getAttribute('data-terminal-drop')).toBeNull();
    expect(firstRoot?.getAttribute('data-terminal-drop-chat-id')).toBeNull();

    testState.liveChats = [];
    first.rerender(<ChatView />);
    await waitFor(() => expect(useUIStore.getState().activeChatId).toBeNull());
    await waitFor(() => expect(testState.ensureActiveChat).toHaveBeenCalled());
    expect(localStorage.getItem(key)).toBeNull();
    expect(firstRoot?.getAttribute('data-terminal-drop')).toBeNull();
    expect(firstRoot?.getAttribute('data-terminal-drop-chat-id')).toBeNull();

    first.unmount();
    testState.ensureActiveChat.mockClear();
    const remounted = render(<ChatView />);
    await waitFor(() => expect(testState.ensureActiveChat).toHaveBeenCalled());
    await screen.findByText(/Could not open a chat yet/);
    expect(screen.queryByTestId('thread-stale-chat')).toBeNull();
    expect(remounted.container.querySelector('[data-composer-drop-zone="true"]')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('registers native drops only for canonical focus and rejects a detached stale-scope listener', async () => {
    const key = chatWorkspaceStorageKey(scope);
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        chatIds: ['stale-chat'],
        focusedChatId: 'stale-chat',
      }),
    );
    testState.liveChats = undefined;
    useUIStore.setState({ activeChatId: 'stale-chat' });
    const received: CustomEvent[] = [];
    const onAttach = (event: Event) => received.push(event as CustomEvent);
    window.addEventListener('jarvis:file:attach', onAttach);

    const view = render(<ChatView />);
    await settleComposerEffects();
    expect(testState.onDragDropEvent).not.toHaveBeenCalled();
    expect(received).toEqual([]);

    testState.liveChats = [];
    view.rerender(<ChatView />);
    await settleComposerEffects();
    expect(testState.onDragDropEvent).not.toHaveBeenCalled();
    expect(received).toEqual([]);

    testState.liveChats = [chats[0]];
    act(() => {
      useUIStore.setState({ activeChatId: 'chat-1' });
      view.rerender(<ChatView />);
    });
    await waitFor(() => expect(testState.onDragDropEvent).toHaveBeenCalled());
    await waitFor(() =>
      expect(testState.stopNativeDropListening.mock.calls.length).toBe(
        testState.onDragDropEvent.mock.calls.length - 1,
      ),
    );
    const firstScopeHandler = testState.nativeDropHandler;
    const firstScopeRegistrationCount = testState.onDragDropEvent.mock.calls.length;

    const chatRoot = view.container.querySelector(
      '[data-vibespace-page="chat"][data-terminal-drop-chat-id="chat-1"]',
    );
    expect(chatRoot).not.toBeNull();
    const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    const elementFromPoint = vi.fn(() => chatRoot as Element);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });

    act(() => {
      testState.nativeDropHandler?.({
        payload: {
          type: 'drop',
          paths: ['C:\\fixtures\\canonical.md'],
          position: { x: 20, y: 20 },
        },
      });
    });
    expect(received.map((event) => event.detail)).toEqual([
      { path: 'C:\\fixtures\\canonical.md', chatId: 'chat-1' },
    ]);

    testState.liveChats = undefined;
    act(() => {
      useAuthStore.setState({
        localUserId: 'account-b',
        workspaceId: 'workspace-b' as never,
        projectId: 'project-b' as never,
      });
      useUIStore.setState({ activeChatId: 'chat-b' });
      view.rerender(<ChatView />);
    });
    await waitFor(() =>
      expect(testState.stopNativeDropListening).toHaveBeenCalledTimes(firstScopeRegistrationCount),
    );
    expect(testState.onDragDropEvent).toHaveBeenCalledTimes(firstScopeRegistrationCount);

    const detachedStaleRoot = document.createElement('div');
    detachedStaleRoot.setAttribute('data-vibespace-page', 'chat');
    detachedStaleRoot.setAttribute('data-terminal-drop', 'chat');
    detachedStaleRoot.setAttribute('data-terminal-drop-chat-id', 'chat-1');
    elementFromPoint.mockReturnValue(detachedStaleRoot);
    act(() => {
      firstScopeHandler?.({
        payload: {
          type: 'drop',
          paths: ['C:\\fixtures\\stale-scope.md'],
          position: { x: 20, y: 20 },
        },
      });
    });
    expect(received.map((event) => event.detail)).toEqual([
      { path: 'C:\\fixtures\\canonical.md', chatId: 'chat-1' },
    ]);

    window.removeEventListener('jarvis:file:attach', onAttach);
    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
    } else {
      delete (document as Partial<Document>).elementFromPoint;
    }
  });

  it('rejects an in-flight open-beside result after the account scope changes', async () => {
    let resolveSource!: (chat: Chat) => void;
    const sourcePending = new Promise<Chat>((resolve) => {
      resolveSource = resolve;
    });
    testState.getChat.mockImplementation((id: string) => {
      if (id === 'chat-2') return sourcePending;
      return Promise.resolve(chats.find((chat) => String(chat.id) === id));
    });
    const view = render(<ChatView />);
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: openBesideDetail('chat-2') }),
    );

    const nextScopeChat: Chat = {
      ...chats[0],
      id: 'chat-b' as Chat['id'],
      workspace_id: 'workspace-b' as Chat['workspace_id'],
      project_id: 'project-b' as NonNullable<Chat['project_id']>,
      title: 'Chat B',
    };
    testState.liveChats = [nextScopeChat];
    act(() => {
      useAuthStore.setState({
        localUserId: 'account-b',
        workspaceId: 'workspace-b' as never,
        projectId: 'project-b' as never,
      });
      useUIStore.getState().setActiveChat('chat-b');
    });
    view.rerender(<ChatView />);
    resolveSource(chats[1]);

    await waitFor(() => expect(screen.getByTestId('chat-pane-chat-b')).toBeTruthy());
    expect(screen.queryByTestId('chat-pane-chat-2')).toBeNull();
    const nextScopeKey = chatWorkspaceStorageKey({
      accountId: 'account-b',
      workspaceId: 'workspace-b',
      projectId: 'project-b',
    });
    expect(localStorage.getItem(nextScopeKey) ?? '').not.toContain('chat-2');
  });

  it('validates duplicate and malformed events and announces only canonical metadata/actions', async () => {
    render(<ChatView />);
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, {
        detail: openBesideDetail('chat-2', 'Forged title'),
      }),
    );
    await screen.findByTestId('chat-pane-chat-2');
    expect(screen.getByRole('status').textContent).toContain('Chat 2 opened beside Chat 1');
    expect(screen.getByRole('status').textContent).not.toContain('Forged title');

    fireEvent.click(screen.getByRole('button', { name: 'Focus Chat 1' }));
    testState.getChat.mockImplementation(async (id: string) =>
      id === 'chat-2' ? undefined : chats.find((chat) => String(chat.id) === id),
    );
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, {
        detail: openBesideDetail('chat-2', 'Stale duplicate'),
      }),
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unavailable'));
    expect(useUIStore.getState().activeChatId).toBe('chat-1');
    expect(screen.getByRole('status').textContent).not.toContain('Stale duplicate');

    window.dispatchEvent(new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: { title: 17 } }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unavailable'));
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(2);
  });

  it('focuses a canonical existing pane and reports the focused-existing action', async () => {
    render(<ChatView />);
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: openBesideDetail('chat-2') }),
    );
    await screen.findByTestId('chat-pane-chat-2');
    fireEvent.click(screen.getByRole('button', { name: 'Focus Chat 1' }));
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: openBesideDetail('chat-2') }),
    );

    await waitFor(() => expect(useUIStore.getState().activeChatId).toBe('chat-2'));
    expect(screen.getByRole('status').textContent).toContain('Focused existing Chat 2');
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(2);
  });

  it('keeps output events isolated per chat in a multipane workspace', async () => {
    render(<ChatView />);
    fireEvent.drop(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: typedTransfer('chat-2'),
    });
    await screen.findByTestId('chat-pane-chat-2');

    act(() => {
      window.dispatchEvent(new CustomEvent('jarvis:chat:output', { detail: { chatId: 'chat-1' } }));
    });
    expect(screen.getByTestId('output-chat-1').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('output-chat-2').getAttribute('data-open')).toBe('false');
  });

  it('keeps a handoff drop inside the real Composer boundary instead of opening a pane', async () => {
    testState.listMessages.mockResolvedValue([
      {
        id: 'message-1',
        chat_id: 'chat-2',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Canonical handoff activity' }],
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const { container } = render(<ChatView />);

    const dropZone = container.querySelector('[data-composer-drop-zone="true"]');
    expect(dropZone).not.toBeNull();
    fireEvent.drop(dropZone!, { dataTransfer: typedTransfer('chat-2') });

    await screen.findByLabelText('Pending handoff from Chat 2');
    expect(screen.queryByTestId('chat-pane-chat-2')).toBeNull();
  });
});

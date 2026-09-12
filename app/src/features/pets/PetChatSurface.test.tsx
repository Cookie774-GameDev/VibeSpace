import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PetChatSurface } from './PetChatSurface';
import { usePetPresentationStore } from './petPresentationStore';

const updateChat = vi.fn(async (_id: unknown, _patch: unknown) => undefined);
const createChat = vi.fn(async (_input: unknown) => ({ id: 'chat-new', title: 'New chat' }));
const deleteChat = vi.fn(async (_id: unknown) => undefined);
const setActiveChat = vi.fn();
const uiState = vi.hoisted(() => ({
  theme: 'warm' as string,
  activeChatId: 'chat-2' as string | null,
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => [
    { id: 'chat-1', title: 'First thread' },
    { id: 'chat-2', title: 'Second thread' },
  ],
}));

vi.mock('@/features/chat/ChatThread', () => ({
  ChatThread: ({ chatId }: { chatId: string }) => <div data-testid="thread">{chatId}</div>,
}));

vi.mock('@/features/chat/Composer', () => ({
  Composer: ({ chatId, compact }: { chatId: string; compact?: boolean }) => (
    <div data-testid="composer" data-compact={compact ? 'true' : 'false'}>
      {chatId}
    </div>
  ),
}));

vi.mock('@/features/chat/WarmChatWelcome', () => ({
  WarmChatWelcome: ({ chatId, compact }: { chatId: string; compact?: boolean }) => (
    <div data-testid="warm-welcome" data-compact={compact ? 'true' : 'false'} data-chat={chatId} />
  ),
}));

vi.mock('@/features/chat/token-boss/TokenBossCinematic', () => ({
  TokenBossCinematic: () => null,
}));

vi.mock('@/lib/db', () => ({
  chatRepo: {
    list: vi.fn(),
    update: (id: unknown, patch: unknown) => updateChat(id, patch),
    create: (input: unknown) => createChat(input),
    delete: (id: unknown) => deleteChat(id),
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: { workspaceId: string; projectId: string | null }) => unknown) =>
    selector({ workspaceId: 'workspace-1', projectId: null }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (
      selector: (state: {
        activeChatId: string | null;
        setActiveChat: typeof setActiveChat;
        theme: string;
      }) => unknown,
    ) =>
      selector({
        activeChatId: uiState.activeChatId,
        setActiveChat,
        theme: uiState.theme,
      }),
    {
      getState: () => ({
        activeChatId: uiState.activeChatId,
        setActiveChat,
        theme: uiState.theme,
      }),
    },
  ),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

describe('PetChatSurface independent panel selection', () => {
  beforeEach(() => {
    updateChat.mockClear();
    createChat.mockClear();
    deleteChat.mockClear();
    setActiveChat.mockClear();
    uiState.theme = 'warm';
    uiState.activeChatId = 'chat-2';
    usePetPresentationStore.setState({
      chats: {},
      panelActiveChatId: null,
    });
  });

  it('shows every workspace chat without move-to-main controls', () => {
    render(<PetChatSurface />);

    expect(screen.getByRole('tab', { name: 'Open chat First thread' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Open chat Second thread' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /main app/i })).toBeNull();
    expect(screen.getByTestId('thread').textContent).toBe('chat-1');
    expect(screen.getByTestId('composer').textContent).toBe('chat-1');
    expect(screen.getByTestId('composer').getAttribute('data-compact')).toBe('true');
    // Every release theme gets its own empty-state art + the same 4 starters.
    expect(screen.getByTestId('warm-welcome').getAttribute('data-compact')).toBe('true');
  });

  it('keeps the scaled welcome available outside the warm theme', () => {
    uiState.theme = 'monochrome';
    render(<PetChatSurface />);
    expect(screen.getByTestId('warm-welcome').getAttribute('data-compact')).toBe('true');
  });

  it('selects a panel tab without touching main app active chat', () => {
    render(<PetChatSurface />);

    fireEvent.click(screen.getByRole('tab', { name: 'Open chat Second thread' }));

    expect(usePetPresentationStore.getState().panelActiveChatId).toBe('chat-2');
    expect(screen.getByTestId('thread').textContent).toBe('chat-2');
  });

  it('creates a panel chat without hijacking main app focus', async () => {
    render(<PetChatSurface />);

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    await waitFor(() => expect(createChat).toHaveBeenCalledTimes(1));
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'workspace-1',
        title: 'New chat',
        mode: 'chat',
      }),
    );
    // Stays on the new panel id even before the live list includes it.
    await waitFor(() =>
      expect(usePetPresentationStore.getState().panelActiveChatId).toBe('chat-new'),
    );
  });

  it('requires confirm before deleting a chat from the mini X', async () => {
    usePetPresentationStore.setState({ panelActiveChatId: 'chat-2' });
    render(<PetChatSurface />);

    fireEvent.click(screen.getByTestId('pet-chat-delete-chat-2'));
    expect(deleteChat).not.toHaveBeenCalled();
    expect(screen.getByTestId('pet-chat-delete-confirm')).toBeTruthy();

    fireEvent.click(screen.getByTestId('pet-chat-delete-cancel'));
    expect(screen.queryByTestId('pet-chat-delete-confirm')).toBeNull();
    expect(deleteChat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pet-chat-delete-chat-2'));
    fireEvent.click(screen.getByTestId('pet-chat-delete-confirm-btn'));

    await waitFor(() => expect(deleteChat).toHaveBeenCalledWith('chat-2'));
    expect(usePetPresentationStore.getState().panelActiveChatId).toBe('chat-1');
    expect(setActiveChat).toHaveBeenCalledWith('chat-1');
  });

  it('renames a chat inline on double-click and keeps it selected', async () => {
    render(<PetChatSurface />);

    const tab = screen.getByRole('tab', { name: 'Open chat First thread' });
    // Second thread tab
    const tab2 = screen.getByRole('tab', { name: 'Open chat Second thread' });
    fireEvent.doubleClick(tab2);
    const input = screen.getByRole('textbox', { name: 'Rename Second thread' });
    fireEvent.change(input, { target: { value: 'Release notes' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(updateChat).toHaveBeenCalledWith('chat-2', { title: 'Release notes' }),
    );
    expect(usePetPresentationStore.getState().panelActiveChatId).toBe('chat-2');
    expect(tab).toBeTruthy();
  });
});

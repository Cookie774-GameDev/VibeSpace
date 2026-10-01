import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@/types';
import { HistoryList } from './HistoryList';

const mocks = vi.hoisted(() => ({
  activeAccountId: 'account-a',
  activeWorkspaceId: 'workspace-a',
  liveQueryCall: 0,
  chats: [] as Chat[],
  bindings: [] as Array<{ chatId: string; provider: string; localTitle: string }>,
  snapshots: [] as Array<{
    id: string;
    title: string;
    messageCount: number;
    updatedAt: number;
    messages: Array<{ text: string }>;
  }>,
  getById: vi.fn(),
  remove: vi.fn(),
  removeSnapshot: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => {
    const slot = mocks.liveQueryCall++ % 6;
    if (slot === 0) return mocks.chats;
    if (slot === 1) return [];
    if (slot === 2) return {};
    if (slot === 3) return null;
    if (slot === 4) return mocks.bindings;
    return mocks.snapshots;
  },
}));

vi.mock('@/lib/db', () => ({
  chatRepo: {
    getById: mocks.getById,
    deleteAuthorized: (chatId: string) => mocks.remove(chatId),
  },
  db: {
    chats: {},
    messages: {},
    browser_chat_bindings: {},
    browser_chat_snapshots: {},
  },
  projectRepo: {
    listByWorkspace: vi.fn(),
  },
}));

vi.mock('@/features/browser-chat/chatGptExport', () => ({
  createChatGptSnapshotRepository: () => ({
    remove: mocks.removeSnapshot,
  }),
}));

vi.mock('@/stores/auth', () => {
  const getState = () => ({
    cloudSession: { user_id: mocks.activeAccountId },
    localUserId: null,
    workspaceId: mocks.activeWorkspaceId,
    projectId: null,
  });
  return {
    useAuthStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState },
    ),
  };
});

vi.mock('@/stores/agents', () => ({
  useAgentStore: (selector: (state: { agents: Record<string, never> }) => unknown) =>
    selector({ agents: {} }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

function chat(id: string, title: string): Chat {
  return {
    id,
    title,
    workspace_id: 'workspace-a',
    project_id: null,
    active_agent_ids: [],
    created_at: 1,
    updated_at: 1,
  } as unknown as Chat;
}

function renderHistory(selectedChatId: string | null = null, onSelectChat = vi.fn()) {
  return render(
    <HistoryList
      selectedChatId={selectedChatId as Parameters<typeof HistoryList>[0]['selectedChatId']}
      onSelectChat={onSelectChat}
    />,
  );
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.activeAccountId = 'account-a';
  mocks.activeWorkspaceId = 'workspace-a';
  mocks.liveQueryCall = 0;
  mocks.chats = [chat('chat-a', 'Alpha chat'), chat('chat-b', 'Beta chat')];
  mocks.bindings = [];
  mocks.snapshots = [];
  mocks.getById.mockReset();
  mocks.getById.mockImplementation(async (id: string) => ({
    id,
    workspace_id: 'workspace-a',
  }));
  mocks.remove.mockReset();
  mocks.remove.mockResolvedValue(undefined);
  mocks.removeSnapshot.mockReset();
  mocks.removeSnapshot.mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HistoryList destructive confirmation', () => {
  it('labels and opens a durable Browser Chat binding without replaying provider content', () => {
    const onSelectChat = vi.fn();
    const onOpenBrowserChat = vi.fn();
    mocks.bindings = [{ chatId: 'chat-a', provider: 'chatgpt', localTitle: 'Bound browser chat' }];
    render(
      <HistoryList
        selectedChatId={null}
        onSelectChat={onSelectChat}
        onOpenBrowserChat={onOpenBrowserChat}
      />,
    );

    expect(screen.getByText('Browser Chat · ChatGPT')).toBeTruthy();
    fireEvent.click(screen.getByText('Alpha chat').closest('button')!);

    expect(onOpenBrowserChat).toHaveBeenCalledWith('chat-a');
    expect(onSelectChat).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/provider message|provider reply/i);
  });

  it('opens and explicitly deletes only a local imported ChatGPT snapshot', async () => {
    const onSelectChat = vi.fn();
    const onSelectSnapshot = vi.fn();
    mocks.snapshots = [
      {
        id: 'snapshot-a',
        title: 'Imported Alpha',
        messageCount: 2,
        updatedAt: 10,
        messages: [{ text: 'provider snapshot text' }],
      },
    ];
    render(
      <HistoryList
        selectedChatId={null}
        selectedSnapshotId={null}
        onSelectChat={onSelectChat}
        onSelectSnapshot={onSelectSnapshot}
      />,
    );

    expect(screen.getByText('Imported snapshot · ChatGPT')).toBeTruthy();
    fireEvent.click(screen.getByText('Imported Alpha').closest('button')!);
    expect(onSelectSnapshot).toHaveBeenCalledWith('snapshot-a');
    expect(onSelectChat).toHaveBeenCalledWith(null);

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete imported snapshot Imported Alpha' }),
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Delete local snapshot Imported Alpha?',
    });
    expect(dialog.textContent).toMatch(/original ChatGPT conversation.*not changed/i);
    fireEvent.click(screen.getByRole('button', { name: 'Delete local snapshot' }));

    await waitFor(() =>
      expect(mocks.removeSnapshot).toHaveBeenCalledWith(
        { accountId: 'account-a', workspaceId: 'workspace-a' },
        'snapshot-a',
      ),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('opens an alert dialog for one chat and keeps Cancel focused without deleting', async () => {
    renderHistory();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha chat' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete Alpha chat?' });
    expect(dialog.textContent).toContain('Alpha chat');
    expect(mocks.remove).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
  });

  it('closes on Cancel or Escape without deleting', async () => {
    renderHistory();
    const trigger = screen.getByRole('button', { name: 'Delete Alpha chat' });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: 'Delete Alpha chat?' })).toBeNull();
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Alpha chat?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Delete Alpha chat?' })).toBeNull(),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('deletes the explicitly confirmed chat exactly once', async () => {
    renderHistory();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(mocks.remove).toHaveBeenCalledWith('chat-a');
  });

  it('names the visible count and deletes only the confirmed visible ids', async () => {
    renderHistory();

    fireEvent.click(screen.getByRole('button', { name: 'Clear visible' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete 2 visible chats?' });
    expect(dialog.textContent).toContain('2 visible chats');
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 chats' }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    expect(mocks.remove.mock.calls).toEqual([['chat-a'], ['chat-b']]);
  });

  it('fails closed if the active workspace changes before explicit confirmation', async () => {
    renderHistory();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha chat' }));
    mocks.activeWorkspaceId = 'workspace-b';
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('closes the pending confirmation on an equal-workspace account transition', async () => {
    const view = renderHistory();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha chat' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete Alpha chat?' })).toBeTruthy();

    mocks.activeAccountId = 'account-b';
    view.rerender(<HistoryList selectedChatId={null} onSelectChat={vi.fn()} />);

    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Delete Alpha chat?' })).toBeNull(),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not clear a newly selected chat when deletion of the prior selection completes', async () => {
    const pendingRemove = deferredVoid();
    const onSelectChat = vi.fn();
    mocks.remove.mockReturnValue(pendingRemove.promise);
    const view = renderHistory('chat-a', onSelectChat);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('chat-a'));

    view.rerender(
      <HistoryList
        selectedChatId={'chat-b' as Parameters<typeof HistoryList>[0]['selectedChatId']}
        onSelectChat={onSelectChat}
      />,
    );
    await act(async () => {
      pendingRemove.resolve();
      await pendingRemove.promise;
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());

    expect(onSelectChat).not.toHaveBeenCalled();
  });

  it('clears a deleted chat that becomes selected before deletion completes', async () => {
    const pendingRemove = deferredVoid();
    const onSelectChat = vi.fn();
    mocks.remove.mockReturnValue(pendingRemove.promise);
    const view = renderHistory('chat-b', onSelectChat);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('chat-a'));

    view.rerender(
      <HistoryList
        selectedChatId={'chat-a' as Parameters<typeof HistoryList>[0]['selectedChatId']}
        onSelectChat={onSelectChat}
      />,
    );
    await act(async () => {
      pendingRemove.resolve();
      await pendingRemove.promise;
    });

    await waitFor(() => expect(onSelectChat).toHaveBeenCalledTimes(1));
    expect(onSelectChat).toHaveBeenCalledWith(null);
  });

  it('does not delegate History safety to window.confirm', () => {
    const source = readFileSync(resolve(__dirname, 'HistoryList.tsx'), 'utf8');
    expect(source).not.toContain('window.confirm');
  });
});

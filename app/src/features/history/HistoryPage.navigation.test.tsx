import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openStoredChat: vi.fn(), setEngine: vi.fn(), toastError: vi.fn(),
  accountId: 'account-a', workspaceId: 'workspace-a', projectId: 'project-a' as string | null }));
vi.mock('./HistoryList', () => ({
  HistoryList: ({ onOpenBrowserChat, onSelectChat }: {
    onOpenBrowserChat(id: string): void; onSelectChat(id: string): void;
  }) => <>
    <button onClick={() => onOpenBrowserChat('archived-browser-chat')}>Open saved browser chat</button>
    <button onClick={() => onSelectChat('archived-regular-chat')}>Replay saved chat</button>
  </>,
}));
vi.mock('./Replay', () => ({ Replay: ({ chatId }: { chatId: string | null }) =>
  <div data-testid="replay-chat">{chatId ?? 'pick a chat'}</div> }));
vi.mock('@/stores/auth', () => ({ useAuthStore: (selector: (state: {
  localUserId: string; workspaceId: string; projectId: string | null; cloudSession: null;
}) => unknown) => selector({ localUserId: mocks.accountId, workspaceId: mocks.workspaceId,
  projectId: mocks.projectId, cloudSession: null }) }));
vi.mock('./openStoredChat', () => ({ openStoredChat: mocks.openStoredChat }));
vi.mock('@/features/browser-chat/browserChatStore', () => ({
  browserChatStore: { getState: () => ({ setEngine: mocks.setEngine }) },
}));
vi.mock('@/components/ui/toast', () => ({ toast: { error: mocks.toastError } }));

import { HistoryPage } from './HistoryPage';

describe('History browser chat restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openStoredChat.mockResolvedValue({ status: 'opened' });
    mocks.workspaceId = 'workspace-a';
    mocks.accountId = 'account-a';
    mocks.projectId = 'project-a';
  });

  it('uses the validated archived-chat opener for the exact bound chat', async () => {
    render(<HistoryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved browser chat' }));
    await waitFor(() => expect(mocks.openStoredChat).toHaveBeenCalledWith('archived-browser-chat'));
    expect(mocks.setEngine).toHaveBeenCalledWith('browser', 'archived-browser-chat');
  });

  it.each(['project', 'workspace', 'account'] as const)('hides the old replay immediately on a %s switch', (scope) => {
    const view = render(<HistoryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay saved chat' }));
    expect(screen.getByTestId('replay-chat').textContent).toBe('archived-regular-chat');
    if (scope === 'project') mocks.projectId = 'project-b';
    else if (scope === 'workspace') mocks.workspaceId = 'workspace-b';
    else mocks.accountId = 'account-b';
    view.rerender(<HistoryPage />);
    expect(screen.getByTestId('replay-chat').textContent).toBe('pick a chat');
  });
});

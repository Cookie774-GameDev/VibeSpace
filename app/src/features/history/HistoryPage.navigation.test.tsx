import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openStoredChat: vi.fn(), setEngine: vi.fn(), toastError: vi.fn() }));
vi.mock('./HistoryList', () => ({
  HistoryList: ({ onOpenBrowserChat }: { onOpenBrowserChat(id: string): void }) =>
    <button onClick={() => onOpenBrowserChat('archived-browser-chat')}>Open saved browser chat</button>,
}));
vi.mock('./Replay', () => ({ Replay: () => null }));
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
  });

  it('uses the validated archived-chat opener for the exact bound chat', async () => {
    render(<HistoryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved browser chat' }));
    await waitFor(() => expect(mocks.openStoredChat).toHaveBeenCalledWith('archived-browser-chat'));
    expect(mocks.setEngine).toHaveBeenCalledWith('browser', 'archived-browser-chat');
  });
});

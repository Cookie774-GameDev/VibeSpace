import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import { usePetPresentationStore } from '@/features/pets/petPresentationStore';

vi.mock('./ChatThread', () => ({
  ChatThread: () => <div data-testid="main-chat-thread" />,
}));

vi.mock('./Composer', () => ({
  Composer: () => <div data-testid="main-chat-composer" />,
}));

vi.mock('./EmptyChat', () => ({ EmptyChat: () => <div /> }));
vi.mock('./OrigamiChatDecor', () => ({ OrigamiChatDecor: () => null }));
vi.mock('./chatLifecycle', () => ({ ensureActiveChat: vi.fn() }));

vi.mock('@/stores/ui', () => ({
  createDefaultDoneNotifications: () => ({
    jarvis: false,
    terminal: false,
    tasks: false,
    contextMaps: false,
    skills: false,
    connectors: false,
    reminders: false,
  }),
  useUIStore: (selector: (state: { activeChatId: string }) => unknown) =>
    selector({ activeChatId: 'chat-1' }),
}));

describe('ChatView mirrored Pet presentation', () => {
  beforeEach(() => {
    document.documentElement.dataset.monochromeChatState = '';
    document.documentElement.dataset.monochromeChatFixture = '';
    usePetPresentationStore.setState({
      chats: {
        'chat-1': { chatId: 'chat-1', owner: 'pet-mini-panel', activeRequestId: null },
      },
    });
  });

  it('keeps the main chat interactive without Bring back controls', () => {
    render(<ChatView />);

    expect(screen.getByTestId('main-chat-thread')).toBeTruthy();
    expect(screen.getByTestId('main-chat-composer')).toBeTruthy();
    expect(screen.queryByText('Bring back here')).toBeNull();
    expect(screen.queryByText(/open in the Pet panel/i)).toBeNull();
  });
});

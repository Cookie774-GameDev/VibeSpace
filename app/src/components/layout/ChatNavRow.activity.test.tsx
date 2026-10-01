import * as React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '@/types/chat';
import { ChatNavRow } from './ChatNavRow';

vi.mock('@/features/chat/useChatPointerDrag', () => ({ useChatPointerDrag: () => ({}) }));

const chat = { id: 'chat-1', title: 'Research', workspace_id: 'workspace-1' } as Chat;

describe('ChatNavRow completion', () => {
  it('stops only the finished chat while another chat continues working', () => {
    const props = { navOpen: true, onOpen: vi.fn(), onTogglePin: vi.fn() };
    const now = Date.now();
    const other = { ...chat, id: 'chat-2', title: 'Writing' } as Chat;
    const view = render(
      <>
        <ChatNavRow
          {...props}
          chat={chat}
          activityRuns={[{ chatId: 'chat-1', status: 'completed', updatedAt: now }]}
        />
        <ChatNavRow
          {...props}
          chat={other}
          activityRuns={[{ chatId: 'chat-2', status: 'running', updatedAt: now }]}
        />
      </>,
    );
    const finished = view.getByTestId('chat-nav-row-chat-1');
    const working = view.getByTestId('chat-nav-row-chat-2');
    expect(finished.querySelectorAll('[data-chat-activity-cell]')).toHaveLength(0);
    expect(finished.querySelector('[data-chat-activity-completion-dot]')).not.toBeNull();
    expect(working.querySelectorAll('[data-chat-activity-cell]')).toHaveLength(16);
    fireEvent.click(view.getByRole('button', { name: 'Research' }));
    expect(finished.querySelector('[data-chat-activity-completion-dot]')).toBeNull();
    expect(working.querySelectorAll('[data-chat-activity-cell]')).toHaveLength(16);
  });

  it('shows completion when collapsed and keeps acknowledgement after leaving the chat', () => {
    const runs = [{ chatId: 'chat-1', status: 'completed', updatedAt: Date.now() }];
    const props = {
      chat,
      navOpen: false,
      activityRuns: runs,
      onOpen: vi.fn(),
      onTogglePin: vi.fn(),
    };
    const view = render(<ChatNavRow {...props} />);
    expect(view.getByRole('status').textContent).toBe('Research: Reply ready');
    fireEvent.click(view.getByRole('button', { name: 'Research' }));
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-chat-activity-completion-dot]')).toBeNull();
    view.rerender(<ChatNavRow {...props} navOpen active />);
    view.rerender(<ChatNavRow {...props} navOpen active={false} />);
    expect(view.container.querySelector('[data-chat-activity-completion-dot]')).toBeNull();
    view.rerender(
      <ChatNavRow
        {...props}
        navOpen
        activityRuns={[{ ...runs[0], updatedAt: runs[0].updatedAt + 1 }]}
      />,
    );
    expect(view.container.querySelector('[data-chat-activity-completion-dot]')).not.toBeNull();
  });
});

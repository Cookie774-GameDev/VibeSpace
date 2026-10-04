import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '@/types/chat';
import { ChatNavRow } from './ChatNavRow';

vi.mock('@/features/chat/useChatPointerDrag', () => ({ useChatPointerDrag: () => ({}) }));

const chat = {
  id: 'chat-menu',
  workspace_id: 'workspace-1',
  title: 'Menu chat',
  mode: 'chat',
  active_agent_ids: [],
  created_at: 1,
  updated_at: 2,
} as Chat;

describe('ChatNavRow context actions', () => {
  it('opens from right click and keyboard without an ellipsis, and calls fork/delete handlers', () => {
    const onFork = vi.fn();
    const onDelete = vi.fn();
    const onTogglePin = vi.fn();
    render(
      <ChatNavRow
        chat={chat}
        navOpen
        onOpen={vi.fn()}
        onTogglePin={onTogglePin}
        onFork={onFork}
        onDelete={onDelete}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Chat actions for Menu chat' })).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('chat-nav-row-chat-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin chat' }));
    expect(onTogglePin).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu chat' }), { key: 'ContextMenu' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork chat' }));
    expect(onFork).toHaveBeenCalledOnce();
    fireEvent.contextMenu(screen.getByTestId('chat-nav-row-chat-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat…' }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('offers the context menu when collapsed', () => {
    render(<ChatNavRow chat={chat} navOpen={false} onOpen={vi.fn()} onTogglePin={vi.fn()} />);
    fireEvent.contextMenu(screen.getByTestId('chat-nav-row-chat-menu'));
    expect(screen.getByRole('menuitem', { name: 'Mark as unread' })).not.toBeNull();
  });
});

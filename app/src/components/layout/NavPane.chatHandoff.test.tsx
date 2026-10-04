import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '@/types/chat';
import { VIBESPACE_CHAT_MIME } from '@/features/chat/chatDragPayload';
import { ChatNavRow } from './ChatNavRow';

vi.mock('@/features/chat/activity', () => ({ ChatListActivityIndicator: () => null }));

const sourceChat: Chat = {
  id: 'chat-source' as Chat['id'],
  workspace_id: 'workspace-1' as Chat['workspace_id'],
  project_id: 'project-1' as NonNullable<Chat['project_id']>,
  title: 'Source chat',
  mode: 'chat',
  active_agent_ids: [],
  created_at: 1,
  updated_at: 2,
};

function renderRow() {
  render(
    <ChatNavRow chat={sourceChat} navOpen active={false} onOpen={vi.fn()} onTogglePin={vi.fn()} />,
  );
}

describe('ChatNavRow handoff actions', () => {
  it('writes the typed identifier-only payload when dragged', () => {
    renderRow();
    const values = new Map<string, string>();
    const setData = vi.fn((type: string, value: string) => values.set(type, value));

    fireEvent.dragStart(screen.getByTestId('chat-nav-row-chat-source'), {
      dataTransfer: { setData, effectAllowed: '' },
    });

    expect(setData).toHaveBeenCalledWith(VIBESPACE_CHAT_MIME, expect.any(String));
    expect(JSON.parse(values.get(VIBESPACE_CHAT_MIME)!)).toEqual({
      version: 1,
      chatId: 'chat-source',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Source chat',
    });
  });

  it('offers keyboard-equivalent context and beside actions', () => {
    const context = vi.fn();
    const beside = vi.fn();
    window.addEventListener('vibespace:chat-send-context', context);
    window.addEventListener('vibespace:chat-open-beside', beside);
    renderRow();

    fireEvent.contextMenu(screen.getByTestId('chat-nav-row-chat-source'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send context to current chat' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Source chat' }), {
      key: 'F10',
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open beside current chat' }));

    expect(context).toHaveBeenCalledOnce();
    expect((context.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      chatId: 'chat-source',
      version: 1,
    });
    expect(beside).toHaveBeenCalledOnce();

    window.removeEventListener('vibespace:chat-send-context', context);
    window.removeEventListener('vibespace:chat-open-beside', beside);
  });
});

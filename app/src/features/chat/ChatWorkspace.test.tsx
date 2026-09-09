import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VIBESPACE_CHAT_MIME, type ChatDragPayloadV1 } from './chatDragPayload';
import {
  addChatPane,
  closeChatPane,
  focusChatPane,
  type ChatWorkspaceLayoutV1,
} from './chatWorkspaceLayout';
import { ChatWorkspace, type ChatWorkspaceOpenResult } from './ChatWorkspace';

vi.mock('./ChatThread', () => ({
  ChatThread: ({ chatId }: { chatId: string }) => (
    <div data-testid={`thread-${chatId}`} data-chat-id={chatId} />
  ),
}));

vi.mock('./Composer', () => ({
  Composer: ({ chatId }: { chatId: string }) => (
    <div data-testid={`composer-${chatId}`} data-chat-id={chatId} data-tour="chat-composer" />
  ),
}));

vi.mock('@/features/browser/BrowserGoalStatus', () => ({
  BrowserGoalStatus: ({ chatId }: { chatId: string }) => (
    <div data-testid={`goal-${chatId}`} data-chat-id={chatId} />
  ),
}));

vi.mock('@/features/browser-chat', () => ({
  useBrowserChatStore: (selector: (state: object) => unknown) => selector({}),
  resolveChatEngine: (_state: object, chatId: string) =>
    chatId === 'browser-chat' ? 'browser' : 'native',
  BrowserChatHub: ({ chatId }: { chatId: string }) => (
    <div data-testid={`browser-${chatId}`} data-chat-id={chatId} />
  ),
}));

vi.mock('./TokenBossCinematic', () => ({ TokenBossCinematic: () => null }));
vi.mock('./WarmChatWelcome', () => ({
  WarmChatWelcome: () => <div data-testid="welcome">Welcome</div>,
}));
vi.mock('./ChatOutputPanel', () => ({ ChatOutputPanel: () => null }));

const titles: Readonly<Record<string, string>> = {
  'chat-1': 'Alpha',
  'chat-2': 'Beta',
  'chat-3': 'Gamma',
  'chat-4': 'Delta',
  'chat-5': 'Epsilon',
  'browser-chat': 'Browser work',
};

function typedTransfer(chatId: string, title = titles[chatId] ?? chatId) {
  const payload: ChatDragPayloadV1 = {
    version: 1,
    chatId,
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    title,
  };
  return {
    types: [VIBESPACE_CHAT_MIME],
    files: [],
    getData: (type: string) => (type === VIBESPACE_CHAT_MIME ? JSON.stringify(payload) : ''),
  };
}

function WorkspaceHarness({
  initial,
  chatTitles = titles,
}: {
  initial: ChatWorkspaceLayoutV1;
  chatTitles?: Readonly<Record<string, string>>;
}) {
  const [layout, setLayout] = useState(initial);
  const openBeside = (input: unknown): ChatWorkspaceOpenResult => {
    const payload = input as ChatDragPayloadV1;
    const next = addChatPane(layout, payload.chatId);
    const source = { chatId: payload.chatId, title: titles[payload.chatId] ?? payload.chatId };
    if ('ok' in next) return { ...next, source };
    setLayout(next);
    return { ok: true, paneCount: next.chatIds.length, action: 'opened', source };
  };
  return (
    <ChatWorkspace
      layout={layout}
      chatTitles={chatTitles}
      onFocus={(chatId) => setLayout((current) => focusChatPane(current, chatId))}
      onClose={(chatId) => setLayout((current) => closeChatPane(current, chatId))}
      onOpenBeside={openBeside}
    />
  );
}

function layout(...chatIds: string[]): ChatWorkspaceLayoutV1 {
  return { version: 1, chatIds, focusedChatId: chatIds[0] };
}

describe('ChatWorkspace', () => {
  it('leaves composer chat-context drops to the existing composer system', () => {
    render(<WorkspaceHarness initial={layout('chat-1')} />);
    const composer = screen.getByTestId('composer-chat-1');
    fireEvent.dragOver(composer, { dataTransfer: typedTransfer('chat-2') });
    fireEvent.drop(composer, { dataTransfer: typedTransfer('chat-2') });
    expect(screen.queryByTestId('chat-layout-drop-preview')).toBeNull();
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(1);
  });
  it('keeps one native chat as a full-size surface with explicit IDs', () => {
    render(<WorkspaceHarness initial={layout('chat-1')} />);

    const workspace = screen.getByTestId('chat-workspace');
    expect(workspace.className).toContain('grid-cols-1');
    expect(workspace.className).toContain('grid-rows-1');
    expect(screen.getByTestId('thread-chat-1').getAttribute('data-chat-id')).toBe('chat-1');
    expect(screen.getByTestId('goal-chat-1').getAttribute('data-chat-id')).toBe('chat-1');
    expect(screen.getByTestId('composer-chat-1').getAttribute('data-chat-id')).toBe('chat-1');
  });

  it('renders two independent panes as equal columns and keeps browser behavior per pane', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'browser-chat')} />);

    const workspace = screen.getByTestId('chat-workspace');
    expect(workspace.className).toContain('grid-cols-2');
    expect(workspace.className).toContain('grid-rows-1');
    expect(screen.getByTestId('thread-chat-1')).toBeTruthy();
    expect(screen.getByTestId('composer-chat-1')).toBeTruthy();
    expect(screen.getByTestId('browser-browser-chat')).toBeTruthy();
    expect(screen.queryByTestId('composer-browser-chat')).toBeNull();
  });

  it('uses the full workspace for three panes with the first pane spanning both rows', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2', 'chat-3')} />);

    const workspace = screen.getByTestId('chat-workspace');
    expect(workspace.className).toContain('grid-cols-2');
    expect(workspace.className).toContain('grid-rows-2');
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(3);
    expect(screen.queryByTestId('chat-workspace-empty-cell')).toBeNull();
    expect(screen.getByTestId('chat-pane-chat-1').className).toContain('row-span-2');
  });

  it('fills the two-by-two grid with four independent chat surfaces', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2', 'chat-3', 'chat-4')} />);

    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(4);
    expect(screen.queryByTestId('chat-workspace-empty-cell')).toBeNull();
    for (const chatId of ['chat-1', 'chat-2', 'chat-3', 'chat-4']) {
      expect(screen.getByTestId(`thread-${chatId}`).getAttribute('data-chat-id')).toBe(chatId);
      expect(screen.getByTestId(`composer-${chatId}`).getAttribute('data-chat-id')).toBe(chatId);
    }
  });

  it('provides pane title, focus, close, live focus announcements, and reduced-motion styling', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2')} />);
    const secondPane = screen.getByTestId('chat-pane-chat-2');

    expect(within(secondPane).getByText('Beta')).toBeTruthy();
    fireEvent.click(within(secondPane).getByRole('button', { name: 'Focus Beta' }));
    expect(secondPane.getAttribute('data-focused')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Focused Beta');
    expect(screen.getByTestId('chat-workspace').className).toContain(
      'motion-reduce:transition-none',
    );
    expect(secondPane.className).toContain('motion-reduce:transition-none');

    fireEvent.click(within(secondPane).getByRole('button', { name: 'Close Beta' }));
    expect(screen.queryByTestId('chat-pane-chat-2')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Focused Alpha');
  });

  it('closes a pane without emitting chat cancellation', () => {
    const cancelled = vi.fn();
    window.addEventListener('jarvis:cancel', cancelled);
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close Beta' }));

    expect(screen.queryByTestId('chat-pane-chat-2')).toBeNull();
    expect(cancelled).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:cancel', cancelled);
  });

  it('does not steal focus when a real pointer sequence closes a non-focused middle pane', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2', 'chat-3')} />);
    const close = screen.getByRole('button', { name: 'Close Beta' });

    fireEvent.pointerDown(close);
    fireEvent.focus(close);
    fireEvent.click(close);

    expect(screen.queryByTestId('chat-pane-chat-2')).toBeNull();
    expect(screen.getByTestId('chat-pane-chat-1').getAttribute('data-focused')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Focused Alpha');
  });

  it('announces equal-title focus changes with a distinct pane ordinal', () => {
    render(
      <WorkspaceHarness
        initial={layout('chat-1', 'chat-2')}
        chatTitles={{ 'chat-1': 'Same title', 'chat-2': 'Same title' }}
      />,
    );
    const focusButtons = screen.getAllByRole('button', { name: 'Focus Same title' });

    expect(screen.getByRole('status').textContent).toContain('pane 1 of 2');
    fireEvent.click(focusButtons[1]);
    expect(screen.getByRole('status').textContent).toContain('pane 2 of 2');
  });

  it('shows a structural drag-over state on the conversation target and clears it on leave', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2')} />);
    const pane = screen.getByTestId('chat-pane-chat-1');
    const conversation = screen.getByTestId('chat-conversation-region-chat-1');

    fireEvent.dragOver(conversation, { dataTransfer: typedTransfer('chat-3') });
    expect(pane.getAttribute('data-chat-drag-over')).toBe('true');
    expect(pane.className).toContain('ring-accent-copper');

    fireEvent.dragLeave(conversation, { relatedTarget: null });
    expect(pane.getAttribute('data-chat-drag-over')).toBe('false');
  });

  it('announces a fifth dropped chat as rejected by the four-chat limit', async () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2', 'chat-3', 'chat-4')} />);

    fireEvent.drop(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: typedTransfer('chat-5'),
    });

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Cannot open Epsilon beside Alpha. This workspace supports up to four chats.',
      ),
    );
    expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(4);
  });

  it.each([1, 2, 3])(
    'previews the actual next layout from %i panes with real chat contents before confirmation',
    async (count) => {
      render(
        <WorkspaceHarness initial={layout(...['chat-1', 'chat-2', 'chat-3'].slice(0, count))} />,
      );
      const incoming = `chat-${count + 1}`;
      const originalThread = screen.getByTestId('thread-chat-1');
      const originalComposer = screen.getByTestId('composer-chat-1');
      const region = screen.getByTestId('chat-conversation-region-chat-1');
      fireEvent.dragOver(region, { dataTransfer: typedTransfer(incoming) });
      const preview = screen.getByTestId('chat-layout-drop-preview');
      expect(preview.getAttribute('data-preview-pane-count')).toBe(String(count + 1));
      expect(preview.textContent).toBe('Release to confirm');
      expect(screen.getByTestId(`thread-${incoming}`)).toBeTruthy();
      expect(screen.getByTestId('thread-chat-1')).toBe(originalThread);
      expect(screen.getByTestId('composer-chat-1')).toBe(originalComposer);
      const incomingThread = screen.getByTestId(`thread-${incoming}`);
      expect(screen.getAllByTestId(/^thread-/)).toHaveLength(count + 1);
      fireEvent.drop(region, { dataTransfer: typedTransfer(incoming) });
      await waitFor(() => expect(screen.getAllByTestId(/^chat-pane-/)).toHaveLength(count + 1));
      expect(screen.queryByTestId('chat-layout-drop-preview')).toBeNull();
      expect(screen.getByTestId(`thread-${incoming}`)).toBe(incomingThread);
    },
  );

  it('includes the welcome area and clears the preview when dragging is cancelled', () => {
    render(<WorkspaceHarness initial={layout('chat-1')} />);
    expect(
      screen.getByTestId('welcome').closest('[data-testid="chat-conversation-region-chat-1"]'),
    ).toBeTruthy();
    fireEvent.dragOver(screen.getByTestId('welcome'), { dataTransfer: typedTransfer('chat-2') });
    expect(screen.getByTestId('chat-layout-drop-preview')).toBeTruthy();
    fireEvent.dragEnd(window);
    expect(screen.queryByTestId('chat-layout-drop-preview')).toBeNull();
    expect(screen.queryByTestId('thread-chat-2')).toBeNull();
    expect(screen.getByTestId('chat-pane-chat-1').getAttribute('data-chat-drag-over')).toBe(
      'false',
    );
  });

  it('remembers same-window drag metadata while the browser protects dragover data', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2', 'chat-3', 'chat-4')} />);
    fireEvent.dragStart(window, { dataTransfer: typedTransfer('chat-2') });
    fireEvent.dragOver(screen.getByTestId('chat-conversation-region-chat-1'), {
      dataTransfer: { types: [VIBESPACE_CHAT_MIME], getData: () => '' },
    });
    expect(screen.getByTestId('chat-layout-drop-preview').textContent).toContain(
      'Release to confirm',
    );
    expect(screen.queryByText('Four chats already open')).toBeNull();
  });

  it('shows a visible limit before dropping a fifth chat and ignores file drags', () => {
    render(<WorkspaceHarness initial={layout('chat-1', 'chat-2', 'chat-3', 'chat-4')} />);
    const region = screen.getByTestId('chat-conversation-region-chat-1');
    fireEvent.dragOver(region, { dataTransfer: typedTransfer('chat-5') });
    expect(screen.getByText('Four chats already open')).toBeTruthy();
    fireEvent.dragEnd(window);
    fireEvent.dragOver(region, { dataTransfer: { types: ['Files'], getData: () => '' } });
    expect(screen.queryByTestId('chat-layout-drop-preview')).toBeNull();
  });
});

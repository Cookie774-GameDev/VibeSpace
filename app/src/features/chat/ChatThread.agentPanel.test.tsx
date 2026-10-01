import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types/chat';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { useUIStore } from '@/stores/ui';
import { TooltipProvider } from '@/components/ui/tooltip';
import { openNativeChildChat } from '@/features/jarvis-interaction/openNativeChildChat';

const mockState = vi.hoisted(() => ({
  messages: [] as Message[],
  messagesByChat: {} as Record<string, Message[]>,
  hasOlder: false,
  loadOlder: vi.fn(),
}));

vi.mock('./hooks', () => ({
  usePagedChatMessages: (chatId: string | null) => ({
    messages: chatId
      ? (mockState.messagesByChat[chatId] ?? mockState.messages)
      : mockState.messages,
    hasOlder: mockState.hasOlder,
    loadOlder: mockState.loadOlder,
  }),
}));

import { ChatThread } from './ChatThread';

const baseAgent = {
  agentId: 'ja_multitask',
  name: 'Fix Jarvis runtime plans',
  parentChatId: 'chat_parent',
  childChatId: 'chat_child_multitask',
  task: '/multitask Fix runtime plans',
  modelLabel: 'Google / gemini',
  status: 'thinking' as const,
  currentStep: 'Reading coordination',
  filesTouched: [],
  lockedFiles: [],
  filesRead: ['docs/AGENT_COORDINATION.md'],
  filesEditing: [],
  diffSummary: { addedLines: 6, removedLines: 1 },
  createdAt: '2026-06-24T12:00:00.000Z',
  updatedAt: '2026-06-24T12:00:01.000Z',
};

describe('ChatThread agent panel attachment', () => {
  beforeEach(() => {
    mockState.messages = [];
    mockState.messagesByChat = {};
    mockState.hasOlder = false;
    mockState.loadOlder.mockReset();
    useJarvisInteractionStore.setState({
      modesByChat: {},
      planSafeApprovalsByChat: {},
      agentsByChat: {},
    });
    useUIStore.setState({ activeChatId: 'chat_parent', route: 'chat', chatMode: 'chat' });
  });

  it('requests the next bounded database page when the user scrolls to older history', () => {
    mockState.messages = [
      {
        id: 'msg_recent' as Message['id'],
        chat_id: 'chat_parent' as Message['chat_id'],
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Recent message' }],
        created_at: 2,
        updated_at: 2,
      },
    ];
    mockState.hasOlder = true;

    render(
      <TooltipProvider>
        <ChatThread chatId="chat_parent" />
      </TooltipProvider>,
    );

    const log = screen.getByRole('log');
    Object.defineProperties(log, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 600 },
    });
    fireEvent.scroll(log);

    expect(mockState.loadOlder).toHaveBeenCalledOnce();
  });

  it('renders multitask and subagent activity as one connected chat panel', () => {
    mockState.messages = [
      {
        id: 'msg_user' as Message['id'],
        chat_id: 'chat_parent' as Message['chat_id'],
        role: 'user',
        parts: [{ kind: 'text', text: '/subagents audit model dropdowns' }],
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'msg_agent_card' as Message['id'],
        chat_id: 'chat_parent' as Message['chat_id'],
        role: 'assistant',
        parts: [{ kind: 'agent_card', agent: baseAgent }],
        created_at: 2,
        updated_at: 2,
      },
    ];

    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [
          baseAgent,
          {
            ...baseAgent,
            agentId: 'ja_subagent',
            name: 'Audit model dropdowns',
            childChatId: 'chat_child_subagent',
            task: '/subagents Audit model dropdowns',
            currentStep: 'Reading provider registry',
            filesRead: ['app/src/lib/ai/providerModelCatalog.ts'],
            filesEditing: ['app/src/components/ai/ProviderModelSelect.tsx'],
            diffSummary: { addedLines: 12, removedLines: 4 },
            createdAt: '2026-06-24T12:00:02.000Z',
          },
        ],
      },
    });

    render(
      <TooltipProvider>
        <ChatThread chatId="chat_parent" />
      </TooltipProvider>,
    );

    expect(screen.getByText('2 Working')).toBeTruthy();
    expect(screen.queryByText('All agents are active and making progress')).toBeNull();
    expect(screen.getByText('Live agent work for this chat')).toBeTruthy();
    expect(screen.getByTestId('chat-agent-connector')).toBeTruthy();
    expect(screen.getAllByText('Fix Jarvis runtime plans').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Audit model dropdowns').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Reading coordination').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Reading provider registry')).toBeTruthy();
    expect(screen.getAllByText('docs/AGENT_COORDINATION.md').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('app/src/components/ai/ProviderModelSelect.tsx').length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('chat-agent-card')).toBeTruthy();
    expect(screen.getAllByText('Agent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Subagent').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: /Stop all/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Open chat for/i }).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('consumes only a selected child belonging to the exact parent and releases its listener on unmount', () => {
    mockState.messagesByChat.chat_child_multitask = [
      {
        id: 'child_selected_reply' as Message['id'],
        chat_id: 'chat_child_multitask' as Message['chat_id'],
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Selected child transcript.' }],
        created_at: 3,
        updated_at: 3,
      },
    ];
    useJarvisInteractionStore.getState().upsertAgent('chat_parent', baseAgent);
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(
      <TooltipProvider>
        <ChatThread chatId="chat_parent" />
      </TooltipProvider>,
    );
    try {
      act(() => openNativeChildChat('chat_child_multitask', 'other_parent'));
      expect(screen.queryByTestId('subagent-child-side-panel')).toBeNull();
      act(() => openNativeChildChat('unknown_child', 'chat_parent'));
      expect(screen.queryByTestId('subagent-child-side-panel')).toBeNull();
      act(() => openNativeChildChat('chat_child_multitask', 'chat_parent'));
      expect(
        screen.getByRole('dialog', { name: 'Child chat for Fix Jarvis runtime plans' }),
      ).toBeTruthy();
      expect(screen.getByText('Selected child transcript.')).toBeTruthy();
      expect(useUIStore.getState()).toMatchObject({ activeChatId: 'chat_parent', route: 'chat' });
      view.unmount();
      expect(remove.mock.calls.some(([name]) => name === 'vibespace:open-child-chat-panel')).toBe(
        true,
      );
    } finally {
      view.unmount();
      remove.mockRestore();
    }
  });

  it('records a live Created sub-agent event and opens that child in the parent side panel', () => {
    mockState.messagesByChat.chat_child_multitask = [
      {
        id: 'child_reply' as Message['id'],
        chat_id: 'chat_child_multitask' as Message['chat_id'],
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Child task progress is visible here.' }],
        created_at: 3,
        updated_at: 3,
      },
    ];

    const view = render(
      <TooltipProvider>
        <ChatThread chatId="chat_parent" />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId('subagent-created-event')).toBeNull();
    act(() => useJarvisInteractionStore.getState().upsertAgent('chat_parent', baseAgent));
    expect(screen.getByText('Created sub-agent')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Open child side panel for Fix Jarvis runtime plans' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Child chat for Fix Jarvis runtime plans' }),
    ).toBeTruthy();
    expect(screen.getByText('Child task progress is visible here.')).toBeTruthy();
    expect(useUIStore.getState().activeChatId).toBe('chat_parent');
    expect(useUIStore.getState().route).toBe('chat');

    fireEvent.click(screen.getByRole('button', { name: 'Close child chat' }));
    expect(screen.queryByTestId('subagent-child-side-panel')).toBeNull();
    view.unmount();
  });
});

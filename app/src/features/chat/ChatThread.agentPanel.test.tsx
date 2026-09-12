import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types/chat';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { TooltipProvider } from '@/components/ui/tooltip';

const mockState = vi.hoisted(() => ({
  messages: [] as Message[],
}));

vi.mock('./hooks', () => ({
  useChatMessages: () => mockState.messages,
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
    useJarvisInteractionStore.setState({
      modesByChat: {},
      planSafeApprovalsByChat: {},
      agentsByChat: {},
    });
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
});

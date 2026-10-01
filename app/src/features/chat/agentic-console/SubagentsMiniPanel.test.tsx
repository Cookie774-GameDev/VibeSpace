import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { useUIStore } from '@/stores/ui';
import { SubagentsHeaderButton } from './SubagentsMiniPanel';

describe('SubagentsMiniPanel', () => {
  beforeEach(() => {
    useJarvisInteractionStore.setState({ agentsByChat: {} });
    browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
    useUIStore.setState({ activeChatId: 'chat_parent', route: 'chat' });
  });

  it('shows empty state when no subagents exist', () => {
    render(<SubagentsHeaderButton chatId="chat_parent" />);
    fireEvent.click(screen.getByTestId('agentic-subagents-toggle'));
    expect(screen.getByText(/No subagents running/i)).toBeTruthy();
  });

  it('lists subagents and opens native child chat', () => {
    useJarvisInteractionStore.getState().upsertAgent('chat_parent', {
      agentId: 'ja_1',
      name: 'Subagent 1: Fix UI',
      parentChatId: 'chat_parent',
      childChatId: 'chat_child',
      task: 'Fix slash UI',
      modelLabel: 'Ollama / llama3.2',
      status: 'editing',
      currentStep: 'Editing InputToken',
      filesTouched: [],
      lockedFiles: [],
      createdAt: new Date(Date.now() - 90_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(<SubagentsHeaderButton chatId="chat_parent" />);
    expect(screen.getByTestId('agentic-subagents-toggle').textContent).toMatch(/1/);
    fireEvent.click(screen.getByTestId('agentic-subagents-toggle'));
    expect(screen.getByText(/Fix slash UI/i)).toBeTruthy();
    expect(screen.getByText(/Ollama \/ llama3.2/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open chat for Subagent/i }));
    expect(browserChatStore.getState().chatPreferences.chat_child?.engine).toBe('native');
    expect(useUIStore.getState().activeChatId).toBe('chat_child');
  });
});

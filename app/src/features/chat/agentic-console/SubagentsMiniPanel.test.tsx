import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { useUIStore } from '@/stores/ui';
import { SubagentsHeaderButton, subagentStatusLabel } from './SubagentsMiniPanel';
import { requestNativeSubagentReply } from '@/features/jarvis-interaction/nativeSubagentReply';

vi.mock('@/features/jarvis-interaction/nativeSubagentReply', () => ({
  requestNativeSubagentReply: vi.fn().mockResolvedValue(undefined),
  requestBoundChildReply: vi.fn().mockResolvedValue(undefined),
}));

describe('SubagentsMiniPanel', () => {
  it('shows native results and only requests one reply to the returned child without navigating away', async () => {
    let finish!: () => void;
    vi.mocked(requestNativeSubagentReply).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const run = {
      id: 'child',
      name: 'Review layout',
      sessionId: 'native_child',
      harness: 'codex' as const,
      status: 'done' as const,
      modelLabel: 'gpt-child',
      reasoningEffort: 'high',
      result: 'Found an edge case.',
    };
    render(<SubagentsHeaderButton chatId="chat_parent" nativeRuns={[run]} />);
    fireEvent.click(screen.getByTestId('agentic-subagents-toggle'));
    expect(screen.getByText('Found an edge case.')).toBeTruthy();
    fireEvent.click(screen.getByText('Details and reply'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Review layout' }), {
      target: { value: 'Check it again' },
    });
    const button = screen.getByRole('button', { name: 'Request reply' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(requestNativeSubagentReply).toHaveBeenCalledTimes(1);
    expect(requestNativeSubagentReply).toHaveBeenCalledWith(
      expect.objectContaining({ parentChatId: 'chat_parent', text: 'Check it again', run }),
    );
    finish();
    expect(await screen.findByText('Reply requested through the native agent.')).toBeTruthy();
    expect(useUIStore.getState().activeChatId).toBe('chat_parent');
  });

  it('labels unreported model and unavailable native reply honestly', () => {
    render(
      <SubagentsHeaderButton
        chatId="chat_parent"
        nativeRuns={[{ id: 'legacy', name: 'Review', status: 'unknown' }]}
      />,
    );
    fireEvent.click(screen.getByTestId('agentic-subagents-toggle'));
    expect(screen.getByText('Model not reported')).toBeTruthy();
    expect(screen.getByText(/Native reply unavailable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request reply' })).toBeNull();
  });
  it('maps pause, resume, working, and terminal states to truthful labels', () => {
    expect(subagentStatusLabel('paused')).toBe('Paused');
    expect(subagentStatusLabel('resuming')).toBe('Resuming');
    expect(subagentStatusLabel('resumed')).toBe('Resumed');
    expect(subagentStatusLabel('working')).toBe('Working');
    expect(subagentStatusLabel('completed')).toBe('Completed');
    expect(subagentStatusLabel('failed')).toBe('Failed');
  });

  it('shows real native task rows in the same Runs panel without creating another execution', () => {
    const runs = [
      { id: 'a', name: 'Read alpha', status: 'running' as const, currentStep: 'Reading alpha.txt' },
      { id: 'b', name: 'Read beta', status: 'error' as const },
    ];
    const view = render(<SubagentsHeaderButton chatId="native-fixture" nativeRuns={runs} />);
    const toggle = screen.getByRole('button', { name: '2 Subagents' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText('Reading alpha.txt')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    view.rerender(
      <SubagentsHeaderButton
        chatId="native-fixture"
        nativeRuns={[{ ...runs[0]!, status: 'done' }, runs[1]!]}
      />,
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('shows two authoritative runs collapsed and preserves independent progress through updates', () => {
    for (const [id, status] of [
      ['one', 'editing'],
      ['two', 'failed'],
    ] as const) {
      useJarvisInteractionStore.getState().upsertAgent('chat_parent', {
        agentId: id,
        name: id,
        parentChatId: 'chat_parent',
        childChatId: `chat_${id}`,
        task: `Inspect ${id}`,
        modelLabel: 'provider/model',
        status,
        filesTouched: [],
        lockedFiles: [],
        createdAt: '2026-09-05T12:00:00Z',
        updatedAt: '2026-09-05T12:00:02Z',
      });
    }
    const view = render(<SubagentsHeaderButton chatId="chat_parent" />);
    const toggle = screen.getByRole('button', { name: '2 Subagents' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    view.rerender(<SubagentsHeaderButton chatId="chat_parent" />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByText('Inspect one')).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    useJarvisInteractionStore.setState({ agentsByChat: {} });
    browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
    useUIStore.setState({ activeChatId: 'chat_parent', route: 'chat' });
  });

  it('shows empty state when no subagents exist', () => {
    render(<SubagentsHeaderButton chatId="chat_parent" />);
    fireEvent.click(screen.getByTestId('agentic-subagents-toggle'));
    expect(screen.getByText(/No subagents running/i)).toBeTruthy();
  });

  it('lists subagents and opens the child panel without changing the parent chat', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Open child side panel for Subagent/i }));
    expect(useUIStore.getState().activeChatId).toBe('chat_parent');
    expect(useUIStore.getState().route).toBe('chat');
    expect(browserChatStore.getState().chatPreferences.chat_child).toBeUndefined();
  });
});

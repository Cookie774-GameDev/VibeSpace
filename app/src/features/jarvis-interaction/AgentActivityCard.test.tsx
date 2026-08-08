import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Part } from '@/types/chat';
import { AgentActivityCard, ChatAgentActivityPanel } from './AgentActivityCard';
import { useUIStore } from '@/stores/ui';
import { useJarvisInteractionStore } from './sessionStore';

const agentPart: Extract<Part, { kind: 'agent_card' }> = {
  kind: 'agent_card',
  agent: {
    agentId: 'ja_1',
    name: 'Jarvis Runtime',
    parentChatId: 'chat_parent',
    childChatId: 'chat_child',
    task: 'Review runtime modes',
    modelLabel: 'Google / gemini',
    status: 'thinking',
    currentStep: 'Reading context',
    filesTouched: ['app/src/lib/ai/runtime.ts'],
    lockedFiles: ['app/src/lib/ai/runtime.ts'],
    filesRead: ['app/src/features/chat/Composer.tsx'],
    filesEditing: ['app/src/lib/ai/runtime.ts'],
    diffSummary: { addedLines: 12, removedLines: 3 },
    createdAt: '2026-06-24T12:00:00.000Z',
    updatedAt: '2026-06-24T12:00:01.000Z',
  },
};

describe('AgentActivityCard', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    useUIStore.setState(useUIStore.getInitialState());
    useJarvisInteractionStore.setState({
      modesByChat: {},
      planSafeApprovalsByChat: {},
      agentsByChat: {},
    });
  });

  it('renders multitask and subagent rows in one chat-connected panel', () => {
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [
          { ...agentPart.agent, task: '/multitask Review runtime modes' },
          {
            ...agentPart.agent,
            agentId: 'ja_2',
            name: 'Audit model dropdowns',
            childChatId: 'chat_child_2',
            task: '/subagents Audit provider registry',
            status: 'editing',
            currentStep: 'Reading provider registry',
            filesRead: ['app/src/lib/ai/providerModelCatalog.ts'],
            filesEditing: ['app/src/components/ai/ProviderModelSelect.tsx'],
            diffSummary: { addedLines: 18, removedLines: 4 },
            createdAt: '2026-06-24T12:00:02.000Z',
          },
          {
            ...agentPart.agent,
            agentId: 'ja_3',
            name: 'Fix creator agent prompts',
            childChatId: 'chat_child_3',
            task: 'Creator prompt tests',
            status: 'testing',
            currentStep: 'Running RED tests',
            filesRead: ['app/src/features/jarvis-creator/contracts.ts'],
            filesEditing: [],
            diffSummary: { addedLines: 0, removedLines: 0 },
            createdAt: '2026-06-24T12:00:03.000Z',
          },
        ],
      },
    });

    render(<ChatAgentActivityPanel chatId="chat_parent" />);

    expect(screen.getByTestId('chat-agent-connector')).toBeTruthy();
    expect(screen.getByText('3 Working')).toBeTruthy();
    expect(screen.getByText('Live agent work for this chat')).toBeTruthy();
    expect(screen.getByText(/Jarvis Runtime/i)).toBeTruthy();
    expect(screen.getByText(/Reading context/i)).toBeTruthy();
    expect(screen.getByText(/Audit model dropdowns/i)).toBeTruthy();
    expect(screen.getByText(/Reading provider registry/i)).toBeTruthy();
    expect(screen.getByText(/Fix creator agent prompts/i)).toBeTruthy();
    expect(screen.getByText(/Running RED tests/i)).toBeTruthy();
    expect(screen.getAllByText(/Composer.tsx/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/ProviderModelSelect.tsx/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('-3')).toBeTruthy();
    expect(screen.getByText('+18')).toBeTruthy();
    expect(screen.getByText('-4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Stop all/i })).toBeNull();
    expect(screen.getAllByText('Agent')).toHaveLength(2);
    expect(screen.getAllByText('Subagent')).toHaveLength(1);
    expect(screen.getByText('Agents (2)')).toBeTruthy();
    expect(screen.getByText('Subagents (1)')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Open chat for/i })).toHaveLength(3);
    expect(screen.queryByTestId('agent-progress-line')).toBeNull();
    expect(screen.queryByTestId('agent-waveform')).toBeNull();
  });

  it('collapses, expands, dismisses, and opens a child chat', () => {
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [agentPart.agent],
      },
    });

    render(<ChatAgentActivityPanel chatId="chat_parent" />);

    fireEvent.click(screen.getByRole('button', { name: /Collapse/i }));

    expect(screen.queryByText(/Jarvis Runtime/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Expand/i }));

    expect(screen.getByText(/Jarvis Runtime/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Jarvis Runtime/i }));

    expect(useUIStore.getState().activeChatId).toBe('chat_child');
    expect(useUIStore.getState().route).toBe('chat');

    fireEvent.click(screen.getByRole('button', { name: /Dismiss multitask activity/i }));

    expect(screen.queryByText('1 Working')).toBeNull();
    expect(screen.queryByLabelText('Multitask activity')).toBeNull();
  });

  it('keeps a dismissal across remounts but reappears for newer agent work', () => {
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [agentPart.agent],
      },
    });

    const first = render(<ChatAgentActivityPanel chatId="chat_parent" />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss multitask activity/i }));
    expect(screen.queryByText('1 Working')).toBeNull();
    first.unmount();

    // Remount with the same (old) agent work - the dismissal must hold.
    const second = render(<ChatAgentActivityPanel chatId="chat_parent" />);
    expect(screen.queryByText('1 Working')).toBeNull();
    second.unmount();

    // A newer agent launch supersedes the dismissal.
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [
          agentPart.agent,
          {
            ...agentPart.agent,
            agentId: 'ja_new',
            name: 'Fresh work',
            createdAt: new Date(Date.now() + 60_000).toISOString(),
            updatedAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      },
    });
    render(<ChatAgentActivityPanel chatId="chat_parent" />);
    expect(screen.getByText('2 Working')).toBeTruthy();
  });

  it('renders standalone message-level agent cards as compact chat rows', () => {
    render(<AgentActivityCard part={agentPart} />);

    expect(screen.getByTestId('chat-agent-card')).toBeTruthy();
    expect(screen.getByText(/Jarvis Runtime/i)).toBeTruthy();
    expect(screen.getByText(/Review runtime modes/i)).toBeTruthy();
    expect(screen.getByText(/Reading context/i)).toBeTruthy();
    expect(screen.getByText(/Google \/ gemini/i)).toBeTruthy();
    expect(useUIStore.getState().activeChatId).not.toBe('chat_child');

    fireEvent.click(screen.getByRole('button', { name: /Open chat for Jarvis Runtime/i }));

    expect(useUIStore.getState().activeChatId).toBe('chat_child');
    expect(useUIStore.getState().route).toBe('chat');
  });

  it('reconciles a persisted inline card with the matching live child status', () => {
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [
          {
            ...agentPart.agent,
            status: 'failed',
            currentStep: 'Failed',
            summary: 'The provider attempt ended before canonical completion.',
            updatedAt: '2026-06-24T12:00:03.000Z',
          },
        ],
      },
    });

    render(<AgentActivityCard part={agentPart} />);

    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('thinking')).toBeNull();
    expect(screen.queryByText('Reading context')).toBeNull();
  });

  it('keeps files read, files changed, and line evidence collapsed by default', () => {
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [agentPart.agent],
      },
    });

    render(<ChatAgentActivityPanel chatId="chat_parent" />);

    const disclosure = screen.getByText('Files and changes').closest('details');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('Composer.tsx');
    expect(disclosure?.textContent).toContain('runtime.ts');
    expect(disclosure?.textContent).toContain('+12');
    expect(disclosure?.textContent).toContain('-3');
  });

  it('dedupes duplicate agents by id in the connected panel', () => {
    const secondPart: Extract<Part, { kind: 'agent_card' }> = {
      ...agentPart,
      agent: {
        ...agentPart.agent,
        currentStep: 'Reading updated context',
        createdAt: '2026-06-24T12:00:02.000Z',
      },
    };

    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [agentPart.agent, secondPart.agent],
      },
    });

    render(<ChatAgentActivityPanel chatId="chat_parent" />);

    expect(screen.getByText('1 Working')).toBeTruthy();
    expect(screen.getAllByText(/Jarvis Runtime/i)).toHaveLength(1);
    expect(screen.getByText(/Reading updated context/i)).toBeTruthy();
  });

  it('does not render synthetic empty subagent details for sparse agent state', () => {
    useJarvisInteractionStore.setState({
      agentsByChat: {
        chat_parent: [
          {
            ...agentPart.agent,
            filesRead: [],
            filesEditing: [],
            lockedFiles: [],
            diffSummary: undefined,
            currentStep: undefined,
          },
        ],
      },
    });

    render(<ChatAgentActivityPanel chatId="chat_parent" />);

    expect(screen.getByText('1 Working')).toBeTruthy();
    expect(screen.getByText(/Review runtime modes/i)).toBeTruthy();
    expect(screen.getByText(/Google \/ gemini/i)).toBeTruthy();
    expect(screen.queryByText('Subagent')).toBeNull();
    expect(screen.queryByTestId('agent-waveform')).toBeNull();
    expect(screen.queryByText('+0')).toBeNull();
    expect(screen.queryByText('-0')).toBeNull();
    expect(screen.getByRole('button', { name: /Open chat for Jarvis Runtime/i })).toBeTruthy();
  });
});

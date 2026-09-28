import { act, render } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { useChatActivityStore } from '@/features/chat/activity/activityStore';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import type { JarvisChatAgent } from './types';
import { AgentActivityIndicator } from './AgentActivityIndicator';

const agent: JarvisChatAgent = {
  agentId: 'agent-1',
  parentChatId: 'parent',
  childChatId: 'child',
  name: 'Subagent',
  task: 'Review',
  modelLabel: 'Model',
  status: 'thinking',
  filesTouched: [],
  lockedFiles: [],
  createdAt: '2026-09-06T12:00:00Z',
  updatedAt: '2026-09-06T12:00:00Z',
};
beforeEach(() => {
  useChatActivityStore.setState({ eventsByChat: {} });
  useJarvisTaskRunStore.setState({ activityByChat: {} });
});

it('uses canonical journal communication for the exact native child session', () => {
  useJarvisTaskRunStore.setState({
    activityByChat: {
      parent: [
        {
          id: 'canonical-message',
          chatId: 'parent',
          kind: 'subagent',
          category: 'coordination',
          semanticIntent: 'mail',
          status: 'running',
          title: 'Message',
          ts: 2,
          nativeTask: { name: 'Task', sessionId: 'session-1' },
        },
      ],
    },
  });
  const { container } = render(
    <AgentActivityIndicator agent={{ ...agent, harnessSessionId: 'session-1' }} />,
  );
  expect(container.querySelector('[data-agent-motion="mail-send"]')).toBeTruthy();
});

it('uses existing coordination motion while delegated work is running', () => {
  const { container } = render(<AgentActivityIndicator agent={agent} />);
  expect(container.querySelector('[data-agent-motion="nine-dot-fold"]')).toBeTruthy();
});

it('distinguishes pending resume and observed work from paused or accepted-resume states', () => {
  const { container, rerender } = render(<AgentActivityIndicator agent={{ ...agent, status: 'paused' }} />);
  for (const status of ['paused', 'resumed'] as const) {
    rerender(<AgentActivityIndicator agent={{ ...agent, status }} />);
    expect(container.querySelector('[data-agent-motion]')).toBeNull();
  }

  for (const status of ['resuming', 'working'] as const) {
    rerender(<AgentActivityIndicator agent={{ ...agent, status }} />);
    expect(container.querySelector('[data-agent-motion="nine-dot-fold"]')).toBeTruthy();
  }
});

it('follows canonical child messaging and stops when the task completes', () => {
  const { container, rerender } = render(<AgentActivityIndicator agent={agent} />);
  act(() =>
    useChatActivityStore.getState().record({
      id: 'message',
      chatId: 'child',
      kind: 'tool',
      category: 'coordination',
      semanticIntent: 'mail',
      status: 'running',
      title: 'Message',
      ts: 1,
    }),
  );
  expect(container.querySelector('[data-agent-motion="mail-send"]')).toBeTruthy();
  rerender(<AgentActivityIndicator agent={{ ...agent, status: 'done' }} />);
  expect(container.querySelector('[data-agent-motion]')).toBeNull();
});

it('does not display another subagents parent message effect or animate waiting permission', () => {
  useChatActivityStore.getState().record({
    id: 'other',
    chatId: 'parent',
    agentId: 'other' as never,
    kind: 'tool',
    category: 'coordination',
    semanticIntent: 'mail',
    status: 'running',
    title: 'Message',
    ts: 1,
  });
  const { container, rerender } = render(<AgentActivityIndicator agent={agent} />);
  expect(container.querySelector('[data-agent-motion="mail-send"]')).toBeNull();
  rerender(<AgentActivityIndicator agent={{ ...agent, status: 'waiting_permission' }} />);
  expect(container.querySelector('[data-agent-motion]')).toBeNull();
});

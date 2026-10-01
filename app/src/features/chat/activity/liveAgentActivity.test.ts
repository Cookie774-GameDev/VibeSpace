import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from '@/stores/agents';
import type { AgentId } from '@/types';
import { useChatActivityStore } from './activityStore';
import {
  bindLiveAgentActivityRun,
  setLiveAgentActivityPhase,
  setLiveAgentActivityRunPhase,
} from './liveAgentActivity';

describe('live agent activity phases', () => {
  beforeEach(() => {
    useChatActivityStore.setState({ eventsByChat: {} });
    useAgentStore.setState({ verbs: {} });
  });

  it('synchronizes the agent verb from structured phase data rather than English labels', () => {
    const agentId = 'agent-live-verb' as AgentId;
    useChatActivityStore.getState().record({
      id: 'agent-verb-activity',
      chatId: 'chat-verb',
      kind: 'agent',
      category: 'context',
      status: 'running',
      title: 'This title deliberately says writing',
      agentId,
      ts: 1,
    });

    expect(
      setLiveAgentActivityPhase('chat-verb', 'agent-verb-activity', {
        category: 'context',
        title: 'This title deliberately says writing',
      }),
    ).toBe(false);
    expect(useAgentStore.getState().verbs[agentId]).toBe('gathering context');

    setLiveAgentActivityPhase('chat-verb', 'agent-verb-activity', {
      category: 'file',
      title: 'This title deliberately says thinking',
    });
    expect(useAgentStore.getState().verbs[agentId]).toBe('reading files');

    setLiveAgentActivityPhase('chat-verb', 'agent-verb-activity', {
      category: 'response',
      title: 'This title deliberately says context',
    });
    expect(useAgentStore.getState().verbs[agentId]).toBe('writing response');
  });

  it('moves one running activity through truthful structured phases', () => {
    useChatActivityStore.getState().record({
      id: 'agent-live',
      chatId: 'chat-live',
      kind: 'agent',
      category: 'context',
      status: 'running',
      title: 'Gathering project context',
      ts: 1,
    });

    expect(
      setLiveAgentActivityPhase('chat-live', 'agent-live', {
        category: 'file',
        title: 'Reading attached files',
        subtitle: '2 files',
      }),
    ).toBe(true);
    expect(useChatActivityStore.getState().eventsByChat['chat-live']?.[0]).toMatchObject({
      category: 'file',
      status: 'running',
      title: 'Reading attached files',
      subtitle: '2 files',
    });

    expect(
      setLiveAgentActivityPhase('chat-live', 'agent-live', {
        category: 'thinking',
        title: 'Reasoning',
      }),
    ).toBe(true);
    expect(useChatActivityStore.getState().eventsByChat['chat-live']?.[0]?.category).toBe(
      'thinking',
    );
  });

  it('routes canonical provider chunks to the bound activity and releases cleanly', () => {
    useChatActivityStore.getState().record({
      id: 'agent-canonical',
      chatId: 'chat-canonical',
      kind: 'agent',
      category: 'thinking',
      status: 'running',
      title: 'Reasoning',
      ts: 1,
    });
    const release = bindLiveAgentActivityRun('run-canonical', 'chat-canonical', 'agent-canonical');

    expect(
      setLiveAgentActivityRunPhase('run-canonical', {
        category: 'response',
        title: 'Preparing the final response',
      }),
    ).toBe(true);
    expect(useChatActivityStore.getState().eventsByChat['chat-canonical']?.[0]).toMatchObject({
      category: 'response',
      status: 'running',
      title: 'Preparing the final response',
    });

    release();
    expect(
      setLiveAgentActivityRunPhase('run-canonical', {
        category: 'writing',
        title: 'Writing',
      }),
    ).toBe(false);
  });

  it('does not revive completed activity or rewrite an unchanged phase', () => {
    useChatActivityStore.getState().record({
      id: 'agent-done',
      chatId: 'chat-done',
      kind: 'agent',
      category: 'response',
      status: 'done',
      title: 'Finished',
      ts: 1,
    });

    expect(
      setLiveAgentActivityPhase('chat-done', 'agent-done', {
        category: 'writing',
        title: 'Writing',
      }),
    ).toBe(false);

    useChatActivityStore.getState().record({
      id: 'agent-same',
      chatId: 'chat-same',
      kind: 'agent',
      category: 'thinking',
      status: 'running',
      title: 'Reasoning',
      ts: 1,
    });
    const before = useChatActivityStore.getState().eventsByChat;
    expect(
      setLiveAgentActivityPhase('chat-same', 'agent-same', {
        category: 'thinking',
        title: 'Reasoning',
      }),
    ).toBe(false);
    expect(useChatActivityStore.getState().eventsByChat).toBe(before);
  });
});

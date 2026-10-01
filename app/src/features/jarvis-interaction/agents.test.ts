import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { useJarvisInteractionStore } from './sessionStore';
import { createJarvisChatAgentCard, createJarvisChatAgentName } from './agents';
import { launchJarvisChatAgent } from './agentRunner';

describe('Jarvis chat agents', () => {
  beforeEach(async () => {
    useUIStore.setState(useUIStore.getInitialState());
    useJarvisInteractionStore.setState({
      modesByChat: {},
      planSafeApprovalsByChat: {},
      agentsByChat: {},
    });
    const { browserChatStore } = await import('@/features/browser-chat/browserChatStore');
    browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
  });

  it('creates deterministic readable names from tasks', () => {
    expect(createJarvisChatAgentName('review the composer and runtime')).toBe('Jarvis Composer');
    expect(createJarvisChatAgentName('')).toBe('Jarvis Agent');
  });

  it('creates agent card metadata with current model label and child chat id', () => {
    const card = createJarvisChatAgentCard({
      agentId: 'ja_1',
      parentChatId: 'chat_parent',
      childChatId: 'chat_child',
      task: 'Review the plan',
      modelLabel: 'OpenAI / gpt-4o',
      now: '2026-06-24T12:00:00.000Z',
    });

    expect(card.status).toBe('thinking');
    expect(card.childChatId).toBe('chat_child');
    expect(card.modelLabel).toBe('OpenAI / gpt-4o');
  });

  it('launches a child chat, inserts an agent card, and dispatches the child run', async () => {
    const chatRepo = {
      getById: vi.fn().mockResolvedValue({
        id: 'chat_parent',
        workspace_id: 'workspace_1',
        project_id: 'project_1',
        title: 'Parent',
        mode: 'chat',
        active_agent_ids: [],
      }),
      create: vi.fn().mockResolvedValue({ id: 'chat_child' }),
    };
    const messageRepo = { create: vi.fn().mockResolvedValue({}) };
    const dispatchEvent = vi.fn();

    const result = await launchJarvisChatAgent({
      parentChatId: 'chat_parent',
      task: 'Review runtime modes',
      modelLabel: 'Google / gemini-2.5-flash',
      modelSelection: { mode: 'single', providerId: 'google', modelId: 'gemini-2.5-flash' },
      jarvisAgentId: 'agent_jarvis',
      repos: { chatRepo, messageRepo },
      dispatchEvent,
      now: '2026-06-24T12:00:00.000Z',
      createId: (prefix) => `${prefix}_fixed`,
    });

    expect(result.childChatId).toBe('chat_fixed');
    expect(chatRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat_fixed',
        workspace_id: 'workspace_1',
        project_id: 'project_1',
        active_agent_ids: ['agent_jarvis'],
      }),
    );
    // Child threads must pin native VibeSpace chat (never sticky Browser Chat).
    const { browserChatStore } = await import('@/features/browser-chat/browserChatStore');
    expect(browserChatStore.getState().chatPreferences.chat_fixed?.engine).toBe('native');
    expect(messageRepo.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat_id: 'chat_parent',
        role: 'user',
        parts: [expect.objectContaining({ kind: 'text', text: '/multitask Review runtime modes' })],
      }),
    );
    expect(messageRepo.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: 'assistant',
        parts: [expect.objectContaining({ kind: 'agent_card' })],
      }),
    );
    // Child thread must get a persisted user turn before jarvis:send (runtime contract).
    expect(messageRepo.create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        chat_id: 'chat_fixed',
        role: 'user',
        parts: [
          expect.objectContaining({
            kind: 'text',
            text: expect.stringContaining('Review runtime modes'),
          }),
        ],
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'jarvis:send',
        detail: expect.objectContaining({
          chatId: 'chat_fixed',
          text: expect.stringContaining('Review runtime modes'),
          interactionMode: 'agent',
          agentId: 'agent_jarvis',
          modelSelectionOverride: {
            mode: 'single',
            providerId: 'google',
            modelId: 'gemini-2.5-flash',
          },
        }),
      }),
    );
  });

  it('launches a planner plus derived subagent tasks without navigating away from the parent chat', async () => {
    useUIStore.setState({ activeChatId: 'chat_parent' });
    const chatRepo = {
      getById: vi.fn().mockResolvedValue({
        id: 'chat_parent',
        workspace_id: 'workspace_1',
        project_id: 'project_1',
        title: 'Parent',
        mode: 'chat',
        active_agent_ids: [],
      }),
      create: vi.fn().mockResolvedValue({}),
    };
    const messageRepo = { create: vi.fn().mockResolvedValue({}) };
    const dispatchEvent = vi.fn();
    const ids = { chat: 0, agent: 0 };

    const result = await launchJarvisChatAgent({
      parentChatId: 'chat_parent',
      task: 'Fix slash aliases, panel close behavior, and queued bar polish',
      commandName: 'subagents',
      modelLabel: 'Google / gemini-2.5-flash',
      modelSelection: { mode: 'single', providerId: 'google', modelId: 'gemini-2.5-flash' },
      jarvisAgentId: 'agent_jarvis',
      repos: { chatRepo, messageRepo },
      dispatchEvent,
      now: '2026-06-24T12:00:00.000Z',
      createId: (prefix) => `${prefix}_${ids[prefix]++}`,
    });

    expect(result.agents).toHaveLength(3);
    expect(chatRepo.create).toHaveBeenCalledTimes(3);
    const assistantMessage = messageRepo.create.mock.calls.find(
      ([message]) => message.role === 'assistant',
    )?.[0];
    const cards = assistantMessage.parts.filter(
      (part: { kind: string }) => part.kind === 'agent_card',
    );
    expect(cards).toHaveLength(3);
    expect(cards[0].agent.name).toMatch(/Planner/i);
    expect(cards.slice(1).map((part: { agent: { task: string } }) => part.agent.task)).toEqual([
      'Fix slash aliases',
      'panel close behavior',
    ]);
    // Parent command + parent cards + one user seed per child thread.
    expect(messageRepo.create).toHaveBeenCalledTimes(5);
    const childUserMessages = messageRepo.create.mock.calls
      .map(([message]) => message)
      .filter(
        (message: { role: string; chat_id: string }) =>
          message.role === 'user' && message.chat_id !== 'chat_parent',
      );
    expect(childUserMessages.map((m: { chat_id: string }) => m.chat_id)).toEqual([
      'chat_0',
      'chat_1',
      'chat_2',
    ]);
    expect(dispatchEvent).toHaveBeenCalledTimes(3);
    expect(dispatchEvent.mock.calls.map(([event]) => event.detail.chatId)).toEqual([
      'chat_0',
      'chat_1',
      'chat_2',
    ]);
    for (const [event] of dispatchEvent.mock.calls) {
      expect(event.detail.modelSelectionOverride).toEqual({
        mode: 'single',
        providerId: 'google',
        modelId: 'gemini-2.5-flash',
      });
      expect(event.detail.agentId).toBe('agent_jarvis');
    }
    expect(useJarvisInteractionStore.getState().agentsForChat('chat_parent')).toHaveLength(3);
    expect(useUIStore.getState().activeChatId).toBe('chat_parent');
  });
});

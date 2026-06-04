import { vi } from 'vitest';
import type { Agent, Message } from '@/types';
import type { AgentId, ChatId, MessageId } from '@/types/common';

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  chatGetById: vi.fn(),
  notifyDone: vi.fn(),
  devLog: vi.fn(),
}));

vi.mock('./router', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('@/lib/db', () => ({
  chatRepo: { getById: mocks.chatGetById, update: vi.fn() },
}));

vi.mock('@/features/dev-console', () => ({
  devConsole: { log: mocks.devLog },
}));

vi.mock('@/lib/notifications', () => ({
  getAiCompletionInstruction: () => '',
  notifyDone: mocks.notifyDone,
}));

vi.mock('@/features/terminals/agentContext', () => ({
  buildAgentTerminalContext: () => '',
}));

vi.mock('./context', () => ({
  getProjectContextBlock: async () => '',
  getProjectContextTreeBlock: () => '',
  getConnectedFilesBlock: async () => '',
  getExplicitContextBlock: () => '',
  getExplicitFilesBlock: async () => '',
  getExplicitTerminalBlock: () => '',
}));

import { startRuntimeListener } from './runtime';

function agent(id: string, slug: string, systemPrompt: string): Agent {
  return {
    id: id as AgentId,
    slug,
    name: slug,
    description: slug,
    system_prompt: systemPrompt,
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    created_at: 1,
    updated_at: 1,
  };
}

describe('startRuntimeListener agent routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAgent.mockResolvedValue({
      text: 'APPLE',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      provider: 'mock',
      model: 'mock-default',
    });
    mocks.chatGetById.mockResolvedValue(undefined);
  });

  it('uses the chat-bound active agent and its system prompt', async () => {
    const apple = agent('agent_apple', 'apple', 'Always answer with APPLE.');
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_1' as ChatId;
    const placeholderId = 'msg_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'what is the code word?' }],
      created_at: 1,
      updated_at: 1,
    };

    const stop = startRuntimeListener({
      getAgentById: (id) => (id === apple.id ? apple : id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'apple' ? apple : slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => apple),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({
        ...msg,
        id: placeholderId,
        created_at: 2,
        updated_at: 2,
      })),
      updateMessage: vi.fn(async () => undefined),
    });

    window.dispatchEvent(new CustomEvent('jarvis:send', {
      detail: { chatId, text: 'what is the code word?' },
    }));

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
    expect(mocks.runAgent.mock.calls[0][0].agent.id).toBe(apple.id);
    expect(mocks.runAgent.mock.calls[0][0].agent.system_prompt).toContain('Always answer with APPLE.');

    stop();
  });
});

import { vi } from 'vitest';
import type { Agent, Message } from '@/types';
import type { AgentId, ChatId, MessageId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  chatGetById: vi.fn(),
  notifyDone: vi.fn(),
  devLog: vi.fn(),
  streamingSession: {
    onDelta: vi.fn(),
    onComplete: vi.fn(async () => undefined),
    stop: vi.fn(),
  },
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

vi.mock('@/features/voice/streamingVoice', () => ({
  createStreamingVoiceSession: () => mocks.streamingSession,
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
    mocks.streamingSession.onDelta.mockClear();
    mocks.streamingSession.onComplete.mockClear();
    mocks.streamingSession.stop.mockClear();
    useAuthStore.setState({
      speakReplies: false,
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
    });
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

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: 'what is the code word?' },
      }),
    );

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
    expect(mocks.runAgent.mock.calls[0][0].agent.id).toBe(apple.id);
    expect(mocks.runAgent.mock.calls[0][0].agent.system_prompt).toContain(
      'Always answer with APPLE.',
    );

    stop();
  });

  it('uses composer-resolved mentioned agent ids before the chat default', async () => {
    const apple = agent('agent_apple', 'apple', 'Always answer with APPLE.');
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_mentions' as ChatId;
    const placeholderId = 'msg_mentions_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_mentions_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: '@apple what is the code word?' }],
      created_at: 1,
      updated_at: 1,
    };

    const stop = startRuntimeListener({
      getAgentById: (id) => (id === apple.id ? apple : id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'apple' ? apple : slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({
        ...msg,
        id: placeholderId,
        created_at: 2,
        updated_at: 2,
      })),
      updateMessage: vi.fn(async () => undefined),
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: '@apple what is the code word?', mentionedAgentIds: [apple.id] },
      }),
    );

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
    expect(mocks.runAgent.mock.calls[0][0].agent.id).toBe(apple.id);
    expect(mocks.runAgent.mock.calls[0][0].agent.system_prompt).toContain(
      'Always answer with APPLE.',
    );

    stop();
  });

  it('routes hyphenated textual mentions when composer ids are unavailable', async () => {
    const apple = agent('agent_apple', 'apple-agent', 'Always answer with APPLE.');
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_hyphen_mention' as ChatId;
    const placeholderId = 'msg_hyphen_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_hyphen_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: '@apple-agent what is the code word?' }],
      created_at: 1,
      updated_at: 1,
    };

    const stop = startRuntimeListener({
      getAgentById: (id) => (id === apple.id ? apple : id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) =>
        slug === 'apple-agent' ? apple : slug === 'jarvis' ? jarvis : null,
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({
        ...msg,
        id: placeholderId,
        created_at: 2,
        updated_at: 2,
      })),
      updateMessage: vi.fn(async () => undefined),
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: '@apple-agent what is the code word?' },
      }),
    );

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
    expect(mocks.runAgent.mock.calls[0][0].agent.id).toBe(apple.id);
    expect(mocks.runAgent.mock.calls[0][0].agent.system_prompt).toContain(
      'Always answer with APPLE.',
    );

    stop();
  });

  it('speaks final prose for normal sends when spoken replies are enabled', async () => {
    useAuthStore.setState({
      speakReplies: true,
      voicePreset: 'atlas',
      voiceEngine: 'local',
    });
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_voice' as ChatId;
    const placeholderId = 'msg_voice_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_voice_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'tell me the plan' }],
      created_at: 1,
      updated_at: 1,
    };

    mocks.runAgent.mockResolvedValueOnce({
      text: [
        'Here is the plan.',
        '```action',
        '{"action_id":"nav.chat","params":{},"rationale":"Open chat."}',
        '```',
      ].join('\n'),
      usage: { input_tokens: 1, output_tokens: 4, cost_usd: 0 },
      provider: 'mock',
      model: 'mock-default',
    });

    const stop = startRuntimeListener({
      getAgentById: (id) => (id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({
        ...msg,
        id: placeholderId,
        created_at: 2,
        updated_at: 2,
      })),
      updateMessage: vi.fn(async () => undefined),
    });

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: 'tell me the plan', speakReply: true },
      }),
    );

    await vi.waitFor(() => expect(mocks.streamingSession.onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.streamingSession.onComplete).toHaveBeenCalledWith(
      expect.stringContaining('Here is the plan.'),
    );

    stop();
  });

  it('does NOT speak a plain typed send even when speak-replies is enabled', async () => {
    useAuthStore.setState({ speakReplies: true, voicePreset: 'atlas', voiceEngine: 'local' });
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_typed' as ChatId;
    const placeholderId = 'msg_typed_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_typed_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
      created_at: 1,
      updated_at: 1,
    };
    mocks.runAgent.mockResolvedValueOnce({
      text: 'Hello there.',
      usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 },
      provider: 'mock',
      model: 'mock-default',
    });
    const stop = startRuntimeListener({
      getAgentById: (id) => (id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({ ...msg, id: placeholderId, created_at: 2, updated_at: 2 })),
      updateMessage: vi.fn(async () => undefined),
    });

    // No speakReply flag → plain typed message → must stay silent.
    window.dispatchEvent(
      new CustomEvent('jarvis:send', { detail: { chatId, text: 'hello' } }),
    );

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.streamingSession.onComplete).not.toHaveBeenCalled();

    stop();
  });
});

import { vi } from 'vitest';
import type { Agent, Message, Part } from '@/types';
import type { AgentId, ChatId, MessageId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  chatGetById: vi.fn(),
  getJarvisCoordinationContextBlock: vi.fn(),
  notifyDone: vi.fn(),
  devLog: vi.fn(),
  streamingSession: {
    onDelta: vi.fn(),
    onComplete: vi.fn(async () => undefined),
    stop: vi.fn(),
    haltPlayback: vi.fn(),
  },
  voiceCanSpeak: true,
}));

vi.mock('@/features/voice/voiceRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/voice/voiceRouter')>();
  return {
    ...actual,
    canVoiceModuleSpeak: () => mocks.voiceCanSpeak,
  };
});

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
  getJarvisCoordinationContextBlock: mocks.getJarvisCoordinationContextBlock,
}));

import { startRuntimeListener } from './runtime';
import { selectionFromOption } from './modelSelection';
import { DEFAULT_CUSTOM_STEPS } from './stacks/presets';

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

const activeStoppers: Array<() => void> = [];

describe('startRuntimeListener agent routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.voiceCanSpeak = true;
    try {
      localStorage.clear();
    } catch {
      /* jsdom */
    }
    mocks.streamingSession.onDelta.mockClear();
    mocks.streamingSession.onComplete.mockClear();
    mocks.streamingSession.stop.mockClear();
    mocks.streamingSession.haltPlayback.mockClear();
    useAuthStore.setState({
      speakReplies: false,
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
      stackPreset: 'off',
      stackCustomSteps: DEFAULT_CUSTOM_STEPS,
      plan: 'free',
      apiKeys: { mock: 'mock-skip-sentinel' },
      defaultProvider: 'mock',
      offlineMode: false,
      chatModelSelection: selectionFromOption('mock', 'mock-default'),
    });
    useUIStore.setState({ voiceModalOpen: true });
    mocks.runAgent.mockResolvedValue({
      text: 'APPLE',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      provider: 'mock',
      model: 'mock-default',
    });
    mocks.getJarvisCoordinationContextBlock.mockResolvedValue('');
    mocks.chatGetById.mockResolvedValue(undefined);
  });

  afterEach(() => {
    while (activeStoppers.length > 0) {
      activeStoppers.pop()!();
    }
  });

  function trackListener(stop: () => void): () => void {
    activeStoppers.push(stop);
    return stop;
  }

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

    const stop = trackListener(startRuntimeListener({
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
    }));

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

    const stop = trackListener(startRuntimeListener({
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
    }));

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

    const stop = trackListener(startRuntimeListener({
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
    }));

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

    const stop = trackListener(startRuntimeListener({
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
    }));

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

  it('speaks a plain typed send when speak-replies is enabled', async () => {
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
    const stop = trackListener(startRuntimeListener({
      getAgentById: (id) => (id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({ ...msg, id: placeholderId, created_at: 2, updated_at: 2 })),
      updateMessage: vi.fn(async () => undefined),
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', { detail: { chatId, text: 'hello', speakReply: true } }),
    );

    await vi.waitFor(() => expect(mocks.streamingSession.onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.streamingSession.onComplete).toHaveBeenCalledWith('Hello there.');

    stop();
  });

  it('does not speak on a plain send when speak-replies is enabled but speakReply is omitted', async () => {
    useAuthStore.setState({ speakReplies: true, voicePreset: 'atlas', voiceEngine: 'local' });
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_silent' as ChatId;
    const placeholderId = 'msg_silent_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_silent_user' as MessageId,
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
    const stop = trackListener(startRuntimeListener({
      getAgentById: (id) => (id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({ ...msg, id: placeholderId, created_at: 2, updated_at: 2 })),
      updateMessage: vi.fn(async () => undefined),
    }));

    window.dispatchEvent(new CustomEvent('jarvis:send', { detail: { chatId, text: 'hello' } }));

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
    expect(mocks.streamingSession.onComplete).not.toHaveBeenCalled();

    stop();
  });

  it('does not speak when the voice module is closed even if speakReply is true', async () => {
    mocks.voiceCanSpeak = false;
    useUIStore.setState({ voiceModalOpen: false });
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_closed_voice' as ChatId;
    const placeholderId = 'msg_closed_voice_assistant' as MessageId;
    const userMessage: Message = {
      id: 'msg_closed_voice_user' as MessageId,
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
    const stop = trackListener(startRuntimeListener({
      getAgentById: (id) => (id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => [userMessage]),
      appendMessage: vi.fn(async (msg) => ({ ...msg, id: placeholderId, created_at: 2, updated_at: 2 })),
      updateMessage: vi.fn(async () => undefined),
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', { detail: { chatId, text: 'hello', speakReply: true } }),
    );

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(1));
    expect(mocks.streamingSession.onComplete).not.toHaveBeenCalled();

    stop();
  });

  it('cancels an in-flight speakReply run when a new voice send arrives', async () => {
    useUIStore.setState({ voiceModalOpen: true });
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_voice_replace' as ChatId;
    let placeholderSeq = 0;
    const signals: AbortSignal[] = [];
    mocks.runAgent.mockImplementation(async (payload: { signal: AbortSignal }) => {
      signals.push(payload.signal);
      await new Promise<void>((resolve) => {
        payload.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        text: `reply-${signals.length}`,
        usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 },
        provider: 'mock',
        model: 'mock-default',
      };
    });

    const stop = trackListener(startRuntimeListener({
      getAgentById: (id) => (id === jarvis.id ? jarvis : null),
      getAgentBySlug: (slug) => (slug === 'jarvis' ? jarvis : null),
      getAgentForChat: vi.fn(async () => jarvis),
      getMessages: vi.fn(async () => []),
      appendMessage: vi.fn(async (msg) => ({
        ...msg,
        id: `msg_voice_${++placeholderSeq}` as MessageId,
        created_at: placeholderSeq,
        updated_at: placeholderSeq,
      })),
      updateMessage: vi.fn(async () => undefined),
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', { detail: { chatId, text: 'first', speakReply: true } }),
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', { detail: { chatId, text: 'second', speakReply: true } }),
    );

    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(2));

    stop();
  });

  it('adds an approval proposal when a tiny local model answers an app-control request in prose', async () => {
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_action_fallback' as ChatId;
    const placeholderId = 'msg_action_fallback_assistant' as MessageId;
    const updateMessage = vi.fn(async () => undefined);
    const userMessage: Message = {
      id: 'msg_action_fallback_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'please open the settings page' }],
      created_at: 1,
      updated_at: 1,
    };
    mocks.runAgent.mockResolvedValueOnce({
      text: "I'll open the Settings page for you.",
      usage: { input_tokens: 1, output_tokens: 8, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:1b',
    });

    const stop = trackListener(startRuntimeListener({
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
      updateMessage,
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: 'please open the settings page' },
      }),
    );

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalled());
    const updateCalls = updateMessage.mock.calls as unknown as Array<
      [MessageId, { parts: Part[] }]
    >;
    const finalWrite = updateCalls[updateCalls.length - 1]?.[1];
    if (!finalWrite) throw new Error('expected a final assistant message write');
    expect(finalWrite.parts[0]).toMatchObject({
      kind: 'text',
      text: expect.stringMatching(/approve/i),
    });
    expect(finalWrite.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action_proposal',
          action_id: 'settings.open',
          status: 'pending',
        }),
      ]),
    );

    stop();
  });

  it('adds a terminal bulk-close approval proposal when a local model answers in prose', async () => {
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_terminal_bulk_close_fallback' as ChatId;
    const placeholderId = 'msg_terminal_bulk_close_fallback_assistant' as MessageId;
    const updateMessage = vi.fn(async () => undefined);
    const userMessage: Message = {
      id: 'msg_terminal_bulk_close_fallback_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'close 5 terminals' }],
      created_at: 1,
      updated_at: 1,
    };
    mocks.runAgent.mockResolvedValueOnce({
      text: 'To close terminals, click the X button on each pane.',
      usage: { input_tokens: 1, output_tokens: 8, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:1b',
    });

    const stop = trackListener(startRuntimeListener({
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
      updateMessage,
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: 'close 5 terminals' },
      }),
    );

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalled());
    const updateCalls = updateMessage.mock.calls as unknown as Array<
      [MessageId, { parts: Part[] }]
    >;
    const finalWrite = updateCalls[updateCalls.length - 1]?.[1];
    if (!finalWrite) throw new Error('expected a final assistant message write');
    expect(finalWrite.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action_proposal',
          action_id: 'terminal.bulkClose',
          params: { count: 5 },
          status: 'pending',
        }),
      ]),
    );

    stop();
  });

  it('adds a terminal bulk-close approval proposal for /terminals slash prefix', async () => {
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_slash_terminal_close' as ChatId;
    const placeholderId = 'msg_slash_terminal_close_assistant' as MessageId;
    const updateMessage = vi.fn(async () => undefined);
    const userMessage: Message = {
      id: 'msg_slash_terminal_close_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'close 5 terminals' }],
      created_at: 1,
      updated_at: 1,
    };
    mocks.runAgent.mockResolvedValueOnce({
      text: 'To close terminals, click the X on each pane.',
      usage: { input_tokens: 1, output_tokens: 8, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:1b',
    });

    const stop = trackListener(startRuntimeListener({
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
      updateMessage,
    }));

    // Composer strips the slash prefix before dispatch; text arrives as the remainder.
    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: 'close 5 terminals' },
      }),
    );

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalled());
    const updateCalls = updateMessage.mock.calls as unknown as Array<
      [MessageId, { parts: Part[] }]
    >;
    const finalWrite = updateCalls[updateCalls.length - 1]?.[1];
    if (!finalWrite) throw new Error('expected a final assistant message write');
    expect(finalWrite.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action_proposal',
          action_id: 'terminal.bulkClose',
          params: { count: 5 },
          status: 'pending',
        }),
      ]),
    );

    stop();
  });

  it('adds a terminal bulk-open approval proposal when a local model answers with code', async () => {
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_terminal_bulk_fallback' as ChatId;
    const placeholderId = 'msg_terminal_bulk_fallback_assistant' as MessageId;
    const updateMessage = vi.fn(async () => undefined);
    const userMessage: Message = {
      id: 'msg_terminal_bulk_fallback_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'open 5 terminals with opencode' }],
      created_at: 1,
      updated_at: 1,
    };
    mocks.runAgent.mockResolvedValueOnce({
      text: '```js\nfor (let i = 0; i < 5; i++) openTerminal(\"opencode\")\n```',
      usage: { input_tokens: 1, output_tokens: 8, cost_usd: 0 },
      provider: 'ollama',
      model: 'llama3.2:1b',
    });
    mocks.getJarvisCoordinationContextBlock.mockResolvedValueOnce(
      '## Coordination Summary\n- Coder (opencode, idle, terminal term_1)',
    );

    const stop = trackListener(startRuntimeListener({
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
      updateMessage,
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: 'open 5 terminals with opencode' },
      }),
    );

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalled());
    const updateCalls = updateMessage.mock.calls as unknown as Array<
      [MessageId, { parts: Part[] }]
    >;
    const finalWrite = updateCalls[updateCalls.length - 1]?.[1];
    if (!finalWrite) throw new Error('expected a final assistant message write');
    expect(finalWrite.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action_proposal',
          action_id: 'terminal.bulkOpen',
          params: { count: 5, command: 'opencode' },
          status: 'pending',
        }),
      ]),
    );
    const runPayload = mocks.runAgent.mock.calls.at(-1)?.[0] as { agent: Agent } | undefined;
    expect(runPayload?.agent.system_prompt).toContain('## Jarvis chat interface');
    expect(runPayload?.agent.system_prompt).toContain('Coordination Summary');
    expect(runPayload?.agent.system_prompt).toContain('terminal.bulkOpen');

    stop();
  });

  it('runs Hive Quality from a /Hive slash prefix and writes stack step parts', async () => {
    useAuthStore.setState({
      apiKeys: {
        xai: 'xai-test',
        anthropic: 'anthropic-test',
        openai: 'openai-test',
        google: 'google-test',
      },
      chatModelSelection: selectionFromOption('mock', 'mock-default'),
    });
    const jarvis = agent('agent_jarvis', 'jarvis', 'You are Jarvis.');
    const chatId = 'chat_hive_quality' as ChatId;
    const placeholderId = 'msg_hive_quality_assistant' as MessageId;
    const updateMessage = vi.fn(async () => undefined);
    const userMessage: Message = {
      id: 'msg_hive_quality_user' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: '/Hive quality explain the release' }],
      created_at: 1,
      updated_at: 1,
    };
    mocks.runAgent
      .mockResolvedValueOnce({
        text: 'orient',
        usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 },
        provider: 'xai',
        model: 'grok-4.3',
      })
      .mockResolvedValueOnce({
        text: 'draft',
        usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 },
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      })
      .mockResolvedValueOnce({
        text: 'harden',
        usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 },
        provider: 'openai',
        model: 'gpt-5.5-codex',
      })
      .mockResolvedValueOnce({
        text: 'final',
        usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 },
        provider: 'google',
        model: 'gemini-3.5-flash',
      });

    const stop = trackListener(startRuntimeListener({
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
      updateMessage,
    }));

    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: { chatId, text: '/Hive quality explain the release' },
      }),
    );

    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(4));
    const updateCalls = updateMessage.mock.calls as unknown as Array<
      [MessageId, { parts: Part[] }]
    >;
    const finalWrite = updateCalls[updateCalls.length - 1]?.[1];
    if (!finalWrite) throw new Error('expected final Hive write');
    expect(finalWrite.parts.filter((part) => part.kind === 'stack_step')).toHaveLength(4);
    expect(finalWrite.parts.at(-1)).toEqual({ kind: 'text', text: 'final' });
    expect(mocks.runAgent.mock.calls[0][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'explain the release' }),
      ]),
    );

    stop();
  });
});

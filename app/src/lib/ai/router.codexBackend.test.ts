import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import { useAuthStore } from '@/stores/auth';

const { codexSend, openCodeSend } = vi.hoisted(() => ({
  codexSend: vi.fn(),
  openCodeSend: vi.fn(),
}));

vi.mock('./adapters/codexPersistent', () => ({
  codexPersistentAdapter: {
    id: 'codex-app-server',
    send: codexSend,
    cancel: vi.fn(),
  },
}));

vi.mock('./adapters/opencodePersistent', () => ({
  openCodePersistentAdapter: {
    id: 'opencode-cli',
    probeAuth: vi.fn(),
    send: openCodeSend,
    cancel: vi.fn(),
  },
}));

import { runAgent } from './router';

const agent: Agent = {
  id: 'agent_codex' as Agent['id'],
  slug: 'jarvis',
  name: 'Jarvis',
  description: 'Jarvis',
  system_prompt: 'You are Jarvis.',
  model: {
    provider: 'opencode-go' as Agent['model']['provider'],
    model: 'deepseek-v4-flash-vision-exp',
  },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

function events(text: string) {
  return (async function* () {
    yield { type: 'session', sessionId: 'thread_native_1' } as const;
    yield { type: 'text', delta: text, streamPartId: 'message_native_1' } as const;
    yield { type: 'done', finishReason: 'completed' } as const;
  })();
}

describe('explicit Chat backend routing', () => {
  it('normalizes a subscription model selected from the shared OpenCode catalog', async () => {
    await runAgent({
      backend: 'codex',
      agent: {
        ...agent,
        model: { provider: 'opencode' as Agent['model']['provider'], model: 'openai/gpt-5.6-luna' },
      },
      chatId: 'chat_luna',
      requestId: 'request_luna',
      connectionId: 'openai-codex',
      interactionMode: 'agent',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(codexSend).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gpt-5.6-luna' }));
    expect(openCodeSend).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    codexSend.mockReset();
    codexSend.mockImplementation(() => events('codex complete'));
    openCodeSend.mockReset();
    openCodeSend.mockImplementation(() => events('opencode complete'));
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'deepseek',
      selectedModels: {},
      chatModelSelection: { mode: 'none' },
      offlineMode: false,
      defaultLocalModel: 'llama3.2',
      plan: 'free',
      workspaceId: 'workspace-a' as never,
      projectId: 'project-a' as never,
    });
  });

  it('dispatches an explicitly Codex-locked chat through structured Codex only', async () => {
    const onHarnessSessionBound = vi.fn();
    const result = await runAgent({
      backend: 'codex',
      agent,
      chatId: 'chat_codex_1',
      requestId: 'request_codex_1',
      connectionId: 'openai-codex',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      messages: [{ role: 'user', content: 'Read game.js.' }],
      onHarnessSessionBound,
    });

    expect(result).toMatchObject({
      text: 'codex complete',
      provider: 'opencode-go',
      model: 'deepseek-v4-flash-vision-exp',
      finish_reason: 'completed',
    });
    expect(codexSend).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request_codex_1',
        connection: expect.objectContaining({
          id: 'openai-codex',
          adapterId: 'codex-app-server',
          providerId: 'opencode-go',
        }),
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        prompt: 'Read game.js.',
        workingDirectory: 'C:\\workspace',
        interactionMode: 'ask',
      }),
    );
    expect(openCodeSend).not.toHaveBeenCalled();
    expect(onHarnessSessionBound).toHaveBeenCalledWith({ sessionId: 'thread_native_1' });
  });

  it('keeps an explicitly OpenCode-locked chat on the unchanged OpenCode executor', async () => {
    const result = await runAgent({
      backend: 'opencode',
      agent,
      chatId: 'chat_opencode_1',
      requestId: 'request_opencode_1',
      connectionId: 'opencode-cli',
      workingDirectory: 'C:\\workspace',
      messages: [{ role: 'user', content: 'Read game.js.' }],
    });

    expect(result.text).toBe('opencode complete');
    expect(openCodeSend).toHaveBeenCalledOnce();
    expect(codexSend).not.toHaveBeenCalled();
  });

  it('does not treat the legacy Codex subscription connection as Codex backend affinity', async () => {
    const legacySubscriptionAgent: Agent = {
      ...agent,
      model: { provider: 'openai', model: 'gpt-5.6-sol' },
    };
    const result = await runAgent({
      agent: legacySubscriptionAgent,
      chatId: 'chat_legacy_codex_1',
      requestId: 'request_legacy_codex_1',
      connectionId: 'openai-codex',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      messages: [{ role: 'user', content: 'Read game.js.' }],
    });

    expect(result.text).toBe('opencode complete');
    expect(openCodeSend).toHaveBeenCalledOnce();
    expect(codexSend).not.toHaveBeenCalled();
  });
});

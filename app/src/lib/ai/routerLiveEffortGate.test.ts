import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import { useAuthStore } from '@/stores/auth';

const { detect, probeAuth, send } = vi.hoisted(() => ({
  detect: vi.fn(),
  probeAuth: vi.fn(),
  send: vi.fn(),
}));

vi.mock('./adapters/opencodePersistent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters/opencodePersistent')>();
  return {
    ...actual,
    openCodePersistentAdapter: Object.freeze({
      ...actual.openCodePersistentAdapter,
      detect,
      probeAuth,
      send,
    }),
  };
});

import { runAgent } from './router';

const agent: Agent = {
  id: 'agent_openai' as Agent['id'],
  slug: 'jarvis',
  name: 'Jarvis',
  description: 'Jarvis',
  system_prompt: 'You are Jarvis.',
  model: { provider: 'openai', model: 'gpt-protected' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

describe('runAgent live OpenCode effort gate', () => {
  beforeEach(() => {
    detect.mockReset();
    detect.mockResolvedValue({ status: 'available', version: 'test' });
    probeAuth.mockReset();
    probeAuth.mockResolvedValue({ status: 'authenticated' });
    send.mockReset();
    send.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'usage' as const,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
        yield { type: 'done' as const, finishReason: 'stop' };
      })(),
    );
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'google',
      selectedModels: {},
      chatModelSelection: { mode: 'none' },
      offlineMode: false,
      defaultLocalModel: 'llama3.2',
      plan: 'free',
    });
  });

  it('sends an explicit reasoning effort through the persistent OpenCode boundary', async () => {
    const response = await runAgent({
      agent,
      chatId: 'chat-live-effort',
      messages: [{ role: 'user', content: 'verify deeply' }],
      provider_options: { reasoning_effort: 'xhigh' },
    });

    expect(response.text).toBe('');
    expect(detect).toHaveBeenCalledOnce();
    expect(probeAuth).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'openai/gpt-protected',
        reasoningEffort: 'xhigh',
        runtimeSettings: expect.objectContaining({ effort: 'ultra' }),
      }),
    );
  });

  it('rejects an invalid effort before persistent OpenCode send', async () => {
    await expect(
      runAgent({
        agent,
        messages: [{ role: 'user', content: 'unsafe option' }],
        provider_options: { reasoning_effort: 'arbitrary' },
      }),
    ).rejects.toThrow(/OpenCode reasoning effort is unsupported: arbitrary/);
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates a live-catalog rejection from the persistent adapter', async () => {
    send.mockImplementationOnce(() =>
      (async function* () {
        throw new Error('OpenCode model is not present in the live authenticated catalog.');
      })(),
    );
    await expect(
      runAgent({
        agent,
        messages: [{ role: 'user', content: 'hello' }],
        provider_options: { reasoning_effort: 'high' },
      }),
    ).rejects.toThrow(/live authenticated catalog/);
    expect(send).toHaveBeenCalledOnce();
  });
});

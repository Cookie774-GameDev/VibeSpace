import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { selectionFromOption } from './modelSelection';
import { LocalCloudEscalationRequiredError, writeLocalAgentPreferences } from './localAgentRuntime';

const { googleRun, ollamaRun } = vi.hoisted(() => ({
  googleRun: vi.fn(),
  ollamaRun: vi.fn(),
}));

vi.mock('./providers/google', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/google')>();
  return {
    ...actual,
    googleProvider: {
      ...actual.googleProvider,
      isAvailable: () => true,
      run: googleRun,
    },
  };
});

vi.mock('./providers/ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/ollama')>();
  return {
    ...actual,
    ollamaProvider: {
      ...actual.ollamaProvider,
      isAvailable: () => true,
      run: ollamaRun,
    },
  };
});

import { runAgent } from './router';

const localAgent: Agent = {
  id: 'agent_local' as Agent['id'],
  slug: 'local',
  name: 'Local',
  description: '',
  system_prompt: '',
  model: { provider: 'ollama', model: 'qwen3.5:4b' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  created_at: 1,
  updated_at: 1,
};

describe('local runtime cloud escalation boundary', () => {
  beforeEach(() => {
    window.localStorage.clear();
    googleRun.mockReset();
    ollamaRun.mockReset();
    ollamaRun.mockRejectedValue(new Error('local inference failed'));
    useAuthStore.setState({
      apiKeys: { google: 'test-key' },
      defaultProvider: 'google',
      selectedModels: { google: 'gemini-3.5-flash' },
      chatModelSelection: selectionFromOption('ollama', 'qwen3.5:4b'),
      offlineMode: false,
    });
  });

  it('returns a bounded approval disclosure after a clean local failure without calling cloud', async () => {
    writeLocalAgentPreferences({ mode: 'deep', cloudEscalationEnabled: true });

    const result = runAgent({
      agent: localAgent,
      messages: [{ role: 'user', content: 'private request' }],
    });

    await expect(result).rejects.toMatchObject({
      name: 'LocalCloudEscalationRequiredError',
      proposal: {
        status: 'approval_required',
        failure: 'inference_failed',
        providerId: 'google',
        modelId: 'gemini-3.5-flash',
        data: { messageChars: 15, contextChars: 0, categories: ['prompt'] },
      },
    } satisfies Partial<LocalCloudEscalationRequiredError>);
    expect(googleRun).not.toHaveBeenCalled();
  });

  it('preserves the local failure when escalation is not enabled', async () => {
    await expect(
      runAgent({
        agent: localAgent,
        messages: [{ role: 'user', content: 'private request' }],
      }),
    ).rejects.toThrow('local inference failed');
    expect(googleRun).not.toHaveBeenCalled();
  });

  it('refuses escalation in Fully Local Chat even when the preference is enabled', async () => {
    writeLocalAgentPreferences({ mode: 'deep', cloudEscalationEnabled: true });
    useAuthStore.setState({ offlineMode: true });

    await expect(
      runAgent({
        agent: localAgent,
        messages: [{ role: 'user', content: 'private request' }],
      }),
    ).rejects.toThrow('local inference failed');
    expect(googleRun).not.toHaveBeenCalled();
  });
});

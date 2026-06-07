import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { resolveProviderAndModel } from './router';

const jarvis: Agent = {
  id: 'agent_jarvis' as Agent['id'],
  slug: 'jarvis',
  name: 'Jarvis',
  description: 'Jarvis',
  system_prompt: 'You are Jarvis.',
  model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

describe('AI provider routing', () => {
  beforeEach(() => {
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'google',
      selectedModels: {},
      offlineMode: false,
      defaultLocalModel: 'llama3.2',
    });
  });

  it('uses the selected provider and model for built-in Jarvis', () => {
    useAuthStore.setState({
      apiKeys: { groq: 'gsk_test' },
      defaultProvider: 'groq',
      selectedModels: { groq: 'llama-3.1-8b-instant' },
    });

    const resolved = resolveProviderAndModel(jarvis);
    expect(resolved.provider.id).toBe('groq');
    expect(resolved.model).toBe('llama-3.1-8b-instant');
  });

  it('does not route unsupported advertised placeholders as real AI', () => {
    useAuthStore.setState({
      apiKeys: { openrouter: 'sk-test' },
      defaultProvider: 'openrouter',
    });

    const resolved = resolveProviderAndModel(jarvis);
    expect(resolved.provider.id).toBe('mock');
    expect(resolved.model).toBe('gemini-2.5-flash-lite');
  });

  it('forces every agent through the selected Ollama model in fully local mode', () => {
    useAuthStore.setState({
      apiKeys: { google: 'cloud-key-that-must-not-be-used' },
      defaultProvider: 'google',
      offlineMode: true,
      defaultLocalModel: 'qwen3:4b',
    });

    const resolved = resolveProviderAndModel(jarvis);
    expect(resolved.provider.id).toBe('ollama');
    expect(resolved.model).toBe('qwen3:4b');
  });
});

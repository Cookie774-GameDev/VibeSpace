import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { AGENT_DEFAULT_PROVIDER_MODEL } from './agentProviderOptions';
import { syncDiscoveredOllamaModels } from './models';
import { NoModelSelectedError, resolveProviderAndModel } from './router';

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

const defaultProviderAgent: Agent = {
  ...jarvis,
  id: 'agent_custom' as Agent['id'],
  slug: 'custom',
  builtin: false,
  model: { provider: 'mock', model: AGENT_DEFAULT_PROVIDER_MODEL },
};

describe('AI provider routing', () => {
  beforeEach(() => {
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'google',
      selectedModels: {},
      offlineMode: false,
      defaultLocalModel: 'llama3.2',
      plan: 'free',
    });
  });

  it('uses the pinned provider for built-in Jarvis when that key is available', () => {
    useAuthStore.setState({
      apiKeys: { google: 'AIza-test', groq: 'gsk_test' },
      defaultProvider: 'groq',
      selectedModels: { groq: 'llama-3.1-8b-instant' },
    });

    const resolved = resolveProviderAndModel(jarvis);
    expect(resolved.provider.id).toBe('google');
    expect(resolved.model).toBe('gemini-2.5-flash-lite');
  });

  it('falls back to local models when a pinned provider is unavailable', () => {
    syncDiscoveredOllamaModels(['qwen3:4b']);
    useAuthStore.setState({
      apiKeys: {},
      defaultProvider: 'google',
      defaultLocalModel: 'qwen3:4b',
    });

    const resolved = resolveProviderAndModel(jarvis);
    expect(resolved.provider.id).toBe('ollama');
    expect(resolved.model).toBe('qwen3:4b');
  });

  it('throws when no provider or local model is available', () => {
    expect(() => resolveProviderAndModel(jarvis)).toThrow(NoModelSelectedError);
  });

  it('routes default-provider agents through the configured default provider', () => {
    useAuthStore.setState({
      apiKeys: { groq: 'gsk_test' },
      defaultProvider: 'groq',
      selectedModels: { groq: 'llama-3.1-8b-instant' },
    });

    const resolved = resolveProviderAndModel(defaultProviderAgent);
    expect(resolved.provider.id).toBe('groq');
    expect(resolved.model).toBe('llama-3.1-8b-instant');
  });

  it('does not route unsupported advertised placeholders as real AI', () => {
    useAuthStore.setState({
      apiKeys: { perplexity: 'sk-test' },
      defaultProvider: 'perplexity',
    });

    expect(() => resolveProviderAndModel(defaultProviderAgent)).toThrow(NoModelSelectedError);
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

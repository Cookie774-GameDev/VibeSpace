import { describe, expect, it, beforeEach } from 'vitest';
import {
  REAL_CHAT_PROVIDERS,
  defaultModelForProvider,
  getAccessibleModelOptions,
  getAccessibleProviders,
  getModelOptions,
  isRealChatProvider,
  syncDiscoveredOllamaModels,
} from './models';

describe('chat model catalog', () => {
  beforeEach(() => {
    syncDiscoveredOllamaModels([]);
  });

  it('only advertises providers with working chat adapters', () => {
    expect(REAL_CHAT_PROVIDERS).toEqual([
      'google',
      'groq',
      'openai',
      'anthropic',
      'ollama',
      'local',
      'mock',
    ]);
    expect(isRealChatProvider('openrouter')).toBe(false);
  });

  it('filters chat models to installed local models and configured API keys', () => {
    const apiKeys = { google: 'test-key', mock: 'mock-skip-sentinel' };
    syncDiscoveredOllamaModels(['llama3.2']);

    expect(getAccessibleProviders(apiKeys, false)).toEqual([
      'google',
      'mock',
      'ollama',
      'local',
    ]);
    expect(getAccessibleModelOptions('ollama', apiKeys, false)).toEqual([
      { provider: 'ollama', id: 'llama3.2', label: 'llama3.2' },
    ]);
    expect(getAccessibleModelOptions('google', apiKeys, false).length).toBeGreaterThan(0);
    expect(getAccessibleModelOptions('openai', apiKeys, false)).toEqual([]);
  });

  it('uses the configured local model as the local default when installed', () => {
    syncDiscoveredOllamaModels(['qwen2.5:3b']);
    expect(defaultModelForProvider('ollama', 'qwen2.5:3b')).toBe('qwen2.5:3b');
  });

  it('returns empty ollama options until models are discovered', () => {
    expect(getModelOptions('ollama')).toEqual([]);
  });

  it('includes subscription-hosted providers when plan is paid', () => {
    const apiKeys = { mock: 'mock-skip-sentinel' };
    syncDiscoveredOllamaModels(['llama3.2']);

    expect(getAccessibleProviders(apiKeys, false, 'starter')).toEqual([
      'google',
      'deepseek',
      'mock',
      'ollama',
      'local',
    ]);
    expect(getAccessibleModelOptions('deepseek', apiKeys, false, 'llama3.2', 'starter')).toEqual([
      { provider: 'deepseek', id: 'deepseek-chat', label: 'DeepSeek V4 Flash' },
    ]);
  });
});

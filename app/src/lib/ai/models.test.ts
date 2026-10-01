import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from '@/stores/auth';
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
      'openrouter',
      'deepseek',
      'zai',
      'mistral',
      'together',
      'xai',
      'qwen',
      'ollama',
      'local',
    ]);
    expect(isRealChatProvider('openrouter')).toBe(true);
  });

  it('does not advertise retired DeepSeek, Gemini, Anthropic, or Groq picker IDs', () => {
    const ids = getModelOptions('google')
      .concat(getModelOptions('anthropic'))
      .concat(getModelOptions('groq'))
      .concat(getModelOptions('deepseek'))
      .map((model) => model.id);
    expect(ids).not.toEqual(expect.arrayContaining([
      'deepseek-chat',
      'deepseek-reasoner',
      'gemini-2.0-flash',
      'claude-3-5-haiku-20241022',
      'mixtral-8x7b-32768',
      'llama-3.1-8b-instant',
    ]));
    expect(defaultModelForProvider('deepseek')).toBe('deepseek-v4-flash');
    expect(defaultModelForProvider('zai')).toBe('glm-5.1');
    expect(defaultModelForProvider('groq')).toBe('openai/gpt-oss-20b');
  });

  it('ships the current Qwen catalog with Qwen 3.7 Plus as the safe default', () => {
    const apiKeys = { qwen: 'test-qwen-key' };
    const ids = getAccessibleModelOptions('qwen', apiKeys, false).map((model) => model.id);

    expect(defaultModelForProvider('qwen')).toBe('qwen3.7-plus');
    expect(ids).toEqual(
      expect.arrayContaining([
        'qwen3.7-max',
        'qwen3.7-max-2026-06-08',
        'qwen3.7-plus',
        'qwen3.7-plus-2026-05-26',
        'qwen3.6-plus',
        'qwen3.6-plus-2026-04-02',
        'qwen3.6-flash',
        'qwen3.6-flash-2026-04-16',
        'qwen3.6-27b',
        'qwen3-coder-next',
      ]),
    );
    expect(getAccessibleProviders(apiKeys, false)).toContain('qwen');
  });

  it('never exposes mock demo in accessible providers', () => {
    const apiKeys = { mock: 'mock-skip-sentinel', google: 'test-key' };
    syncDiscoveredOllamaModels(['llama3.2']);

    expect(getAccessibleProviders(apiKeys, false)).not.toContain('mock');
    expect(getAccessibleModelOptions('mock', apiKeys, false)).toEqual([]);
  });

  it('filters chat models to installed local models and configured API keys', () => {
    const apiKeys = { google: 'test-key', mock: 'mock-skip-sentinel' };
    syncDiscoveredOllamaModels(['llama3.2']);

    expect(getAccessibleProviders(apiKeys, false)).toEqual(['google', 'ollama', 'local']);
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

  it('does not advertise a configured fallback until Ollama verifies it is installed', () => {
    useAuthStore.setState({ defaultLocalModel: 'llama3.2' });
    expect(getAccessibleProviders({}, false, 'free', 'llama3.2')).toEqual([]);
    expect(getAccessibleModelOptions('ollama', {}, false, 'llama3.2')).toEqual([]);
    expect(getModelOptions('ollama')).toEqual([]);
  });

  it('makes every verified installed model available regardless of the local fallback', () => {
    syncDiscoveredOllamaModels(['qwen3.5:4b', 'llama3.2:3b']);

    expect(getAccessibleModelOptions('ollama', {}, false, 'stale:not-installed')).toEqual([
      { provider: 'ollama', id: 'qwen3.5:4b', label: 'qwen3.5:4b' },
      { provider: 'ollama', id: 'llama3.2:3b', label: 'llama3.2:3b' },
    ]);
  });

  it('includes subscription-hosted providers when plan is paid', () => {
    const apiKeys = { mock: 'mock-skip-sentinel' };
    syncDiscoveredOllamaModels(['llama3.2']);

    expect(getAccessibleProviders(apiKeys, false, 'starter')).toEqual([
      'google',
      'deepseek',
      'openai',
      'anthropic',
      'groq',
      'mistral',
      'openrouter',
      'xai',
      'ollama',
      'local',
    ]);
    expect(getAccessibleModelOptions('deepseek', apiKeys, false, 'llama3.2', 'starter')).toEqual([
      {
        provider: 'deepseek',
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        contextWindowTokens: 128_000,
      },
      {
        provider: 'deepseek',
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        contextWindowTokens: 128_000,
      },
    ]);
  });
});

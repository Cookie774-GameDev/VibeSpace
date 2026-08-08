import { describe, expect, it } from 'vitest';
import {
  TOKEN_BOSS_PROVIDERS,
  resolveTokenBossProvider,
  type CurrentModelContext,
} from './providers';

describe('Token Boss provider resolution', () => {
  it('keeps the exact 15-provider catalog from the approved reference', () => {
    expect(TOKEN_BOSS_PROVIDERS.map((provider) => provider.id)).toEqual([
      'codex',
      'gemini',
      'chatgpt',
      'claude',
      'grok',
      'deepseek',
      'qwen',
      'llama',
      'kimi',
      'mistral',
      'perplexity',
      'cohere',
      'minimax',
      'nemotron',
      'ollama',
    ]);
  });

  it.each<[CurrentModelContext, string]>([
    [{ providerId: 'openai', connectionId: 'openai-codex', modelId: 'gpt-5.6-sol' }, 'codex'],
    [{ providerName: 'Google AI', modelName: 'Gemini 2.5 Pro' }, 'gemini'],
    [{ providerId: 'openai', modelId: 'gpt-5.2' }, 'chatgpt'],
    [{ providerId: 'anthropic', modelId: 'claude-opus-4' }, 'claude'],
    [{ providerId: 'xai', modelId: 'grok-4' }, 'grok'],
    [{ providerId: 'deepsea', modelId: 'deepseek-r1' }, 'deepseek'],
    [{ providerId: 'dashscope', modelId: 'qwen3.5' }, 'qwen'],
    [{ providerId: 'meta', modelId: 'llama-4' }, 'llama'],
    [{ providerId: 'moonshot', modelId: 'kimi-k2' }, 'kimi'],
    [{ providerId: 'mistral', modelId: 'mixtral-8x7b' }, 'mistral'],
    [{ providerId: 'pplx', modelId: 'sonar-pro' }, 'perplexity'],
    [{ providerId: 'cohere', modelId: 'command-r-plus' }, 'cohere'],
    [{ providerId: 'mini-max', modelId: 'minimax-m2' }, 'minimax'],
    [{ providerId: 'nvidia', modelId: 'nemotron-ultra' }, 'nemotron'],
    [{ providerId: 'local', runtimeId: 'ollama', modelId: 'qwen3.5:4b' }, 'ollama'],
  ])('resolves %o to %s', (context, expected) => {
    expect(resolveTokenBossProvider(context)?.id).toBe(expected);
  });

  it('resolves Codex before generic OpenAI/ChatGPT matches', () => {
    expect(
      resolveTokenBossProvider({
        providerId: 'openai',
        providerName: 'OpenAI',
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
      })?.id,
    ).toBe('codex');
  });

  it('does not pretend an unknown or merely local-looking provider is Ollama', () => {
    expect(resolveTokenBossProvider({ providerId: 'unknown', modelId: 'custom' })).toBeNull();
    expect(resolveTokenBossProvider({ providerId: 'local', modelId: 'custom' })).toBeNull();
  });
});

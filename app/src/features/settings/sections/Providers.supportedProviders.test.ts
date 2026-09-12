import { describe, expect, it } from 'vitest';
import { PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import { getProviderRegistryEntry } from '@/lib/ai/providerRegistry';
import { BYOK_PROVIDERS } from './Providers';

describe('connectable chat provider truth', () => {
  it('shows only providers with a real registry entry and runnable connection', () => {
    const visibleIds = BYOK_PROVIDERS.map(({ id }) => id);

    expect(visibleIds).toEqual([
      'anthropic',
      'openai',
      'google',
      'qwen',
      'groq',
      'together',
      'xai',
      'deepseek',
      'mistral',
      'openrouter',
      'ollama',
    ]);
    for (const providerId of visibleIds) {
      expect(getProviderRegistryEntry(providerId)).toBeDefined();
      expect(
        PROVIDER_CONNECTIONS.some(
          (connection) =>
            connection.providerId === providerId &&
            (connection.mode === 'native-api' || connection.mode === 'local'),
        ),
      ).toBe(true);
    }
  });

  it('does not advertise unfinished provider integrations', () => {
    const visibleIds = new Set(BYOK_PROVIDERS.map(({ id }) => id));
    for (const unsupported of [
      'cerebras',
      'fireworks',
      'cohere',
      'perplexity',
      'replicate',
      'huggingface',
      'azure',
      'bedrock',
      'hyperbolic',
      'novita',
      'lambda',
    ]) {
      expect(visibleIds.has(unsupported as never)).toBe(false);
    }
  });
});

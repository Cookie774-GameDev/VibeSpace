import { describe, expect, it, vi } from 'vitest';

import type { ProviderTokenizer } from './contracts';
import { createTokenizerRegistry } from './tokenizerRegistry';

function tokenizer(
  patch: Partial<ProviderTokenizer> = {},
): ProviderTokenizer {
  return {
    id: 'local:test',
    providerId: 'provider',
    modelPattern: /^model$/,
    source: 'exact_local',
    transmitsContent: false,
    estimateText: async () => 2,
    ...patch,
  };
}

describe('tokenizer registry', () => {
  it('prefers exact local counting over an authorized provider-native port', async () => {
    const native = vi.fn(async () => 1);
    const registry = createTokenizerRegistry([
      tokenizer({
        id: 'native:test',
        source: 'provider_native',
        transmitsContent: true,
        estimateText: native,
      }),
      tokenizer(),
    ]);

    await expect(
      registry.estimateText('provider', 'model', 'hello', {
        allowProviderTransport: true,
      }),
    ).resolves.toEqual({
      tokens: 2,
      source: 'exact_local',
      tokenizerId: 'local:test',
    });
    expect(native).not.toHaveBeenCalled();
  });

  it('labels unavailable and unknown tokenizers as conservative estimates', async () => {
    const registry = createTokenizerRegistry([
      tokenizer({ estimateText: async () => Promise.reject(new Error('asset unavailable')) }),
    ]);

    await expect(registry.estimateText('provider', 'model', 'é')).resolves.toEqual({
      tokens: 2,
      source: 'conservative_estimate',
      tokenizerId: 'builtin:utf8-conservative-estimate',
    });
    await expect(registry.estimateText('other', 'unknown', 'abc')).resolves.toMatchObject({
      tokens: 3,
      source: 'conservative_estimate',
    });
  });

  it('does not call native transport unless explicitly authorized', async () => {
    const estimateText = vi.fn(async () => 1);
    const registry = createTokenizerRegistry([
      tokenizer({
        source: 'provider_native',
        transmitsContent: true,
        estimateText,
      }),
    ]);

    await expect(registry.estimateText('provider', 'model', 'private')).resolves.toMatchObject({
      source: 'conservative_estimate',
    });
    expect(estimateText).not.toHaveBeenCalled();
  });

  it('propagates cancellation instead of returning an estimate', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    const registry = createTokenizerRegistry([]);

    await expect(
      registry.estimateText('provider', 'model', 'hello', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

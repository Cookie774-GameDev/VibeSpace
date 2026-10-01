import { describe, expect, it, vi } from 'vitest';

import {
  createExactLocalProviderTokenizer,
  createProviderNativeTokenizer,
} from './tokenizerAdapters';

describe('tokenizer adapters', () => {
  it('preserves exact-local provider/model selection and never marks transport', async () => {
    const countText = vi.fn(async () => 3);
    const tokenizer = createExactLocalProviderTokenizer({
      id: 'local:test',
      providerId: 'openai',
      modelPattern: /^gpt-5$/,
      reviewed: true,
      countText,
    });

    await expect(
      tokenizer.estimateText({
        providerId: 'openai',
        modelId: 'gpt-5',
        text: 'secret',
        providerTransportAuthorized: false,
      }),
    ).resolves.toBe(3);
    expect(tokenizer).toMatchObject({ source: 'exact_local', transmitsContent: false });
    expect(countText).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', modelId: 'gpt-5', text: 'secret' }),
    );
  });

  it('requires explicit native transport and rejects provider model substitution', async () => {
    const countText = vi.fn(async () => ({
      tokens: 4,
      providerId: 'anthropic',
      modelId: 'different-model',
    }));
    const tokenizer = createProviderNativeTokenizer({
      id: 'native:anthropic',
      providerId: 'anthropic',
      modelPattern: /^claude-sonnet-4$/,
      countText,
    });
    const input = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      text: 'hello',
      providerTransportAuthorized: false,
    };

    await expect(tokenizer.estimateText(input)).rejects.toThrow(/not authorized/i);
    expect(countText).not.toHaveBeenCalled();
    await expect(
      tokenizer.estimateText({ ...input, providerTransportAuthorized: true }),
    ).rejects.toThrow(/substituted/i);
  });

  it('rejects invalid counts rather than fabricating exactness', async () => {
    const tokenizer = createExactLocalProviderTokenizer({
      id: 'local:test',
      providerId: 'local',
      modelPattern: /^model$/,
      reviewed: true,
      countText: async () => -1,
    });
    await expect(
      tokenizer.estimateText({
        providerId: 'local',
        modelId: 'model',
        text: 'hello',
        providerTransportAuthorized: false,
      }),
    ).rejects.toThrow(/invalid token count/i);
  });
});

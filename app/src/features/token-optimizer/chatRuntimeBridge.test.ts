import { describe, expect, it, vi } from 'vitest';

import { createChatTokenOptimizationRuntime } from './chatRuntimeBridge';

describe('chat token optimization runtime tokenizers', () => {
  it('uses the selected OpenAI family locally without changing provider or model', async () => {
    const encode = vi.fn((text: string) =>
      text.trim() ? text.trim().split(/\s+/u).map((_word, index) => index) : [],
    );
    const runtime = createChatTokenOptimizationRuntime({
      loadOpenAiO200k: async () => ({ encode }),
    });

    const result = await runtime.optimizeMessages({
      mode: 'normal',
      providerId: 'openai',
      modelId: 'gpt-5',
      modelContextLimit: 1_000,
      requestedOutputTokens: 100,
      messages: [{ role: 'user', content: 'count these words' }],
    });

    expect(result.receipt).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5',
      modelChanged: false,
      tokenizerSource: 'exact_local',
    });
    expect(encode).toHaveBeenCalled();
  });

  it('uses an injected native port only with explicit transport authorization', async () => {
    const countText = vi.fn(async ({ text }: { text: string }) => ({
      tokens: 2,
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      text,
    }));
    const runtime = createChatTokenOptimizationRuntime({
      providerNativePorts: [
        {
          id: 'native:anthropic',
          providerId: 'anthropic',
          modelPattern: /^claude-sonnet-4$/,
          countText,
        },
      ],
    });
    const base = {
      mode: 'normal' as const,
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      modelContextLimit: 1_000,
      requestedOutputTokens: 100,
      contextSegments: [
        {
          id: 'docs',
          kind: 'documentation' as const,
          text: 'public documentation',
          relevance: 0.8,
          protected: false,
          reason: 'Relevant docs',
        },
      ],
      messages: [{ role: 'user' as const, content: 'private latest user turn' }],
    };

    const localOnly = await runtime.optimizeMessages(base);
    expect(localOnly.receipt.tokenizerSource).toBe('conservative_estimate');
    expect(countText).not.toHaveBeenCalled();

    const authorized = await runtime.optimizeMessages({
      ...base,
      allowProviderTokenCountTransport: true,
    });
    expect(authorized.receipt.tokenizerSource).toBe('mixed');
    expect(countText).toHaveBeenCalledTimes(1);
    expect(countText.mock.calls[0]?.[0]).toMatchObject({
      text: 'public documentation',
      authorization: 'explicit_token_count_transport',
    });
    expect(countText.mock.calls[0]?.[0].text).not.toContain('private latest user turn');
  });

  it('keeps unknown models on the labeled conservative estimate path', async () => {
    const runtime = createChatTokenOptimizationRuntime();
    const result = await runtime.optimizeMessages({
      mode: 'saver',
      providerId: 'unknown-provider',
      modelId: 'unknown-model',
      modelContextLimit: 1_000,
      requestedOutputTokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.receipt).toMatchObject({
      modelChanged: false,
      tokenizerSource: 'conservative_estimate',
    });
    expect(result.receipt).toHaveProperty('estimatedInputTokensBefore');
    expect(result.receipt).not.toHaveProperty('actualInputTokens');
  });

  it('preserves the immediately previous exchange when protected context fills the budget', async () => {
    const runtime = createChatTokenOptimizationRuntime({
      loadOpenAiO200k: async () => ({
        encode: (text: string) =>
          text.trim() ? text.trim().split(/\s+/u).map((_word, index) => index) : [],
      }),
    });
    const protectedContext = Array.from({ length: 70 }, (_, index) => `rule-${index}`).join(' ');

    const result = await runtime.optimizeMessages({
      mode: 'normal',
      providerId: 'openai',
      modelId: 'gpt-5',
      modelContextLimit: 100,
      requestedOutputTokens: 20,
      contextSegments: [
        {
          id: 'authority',
          kind: 'system_instruction',
          text: protectedContext,
          relevance: 1,
          protected: true,
          reason: 'Protected authority',
        },
      ],
      messages: [
        { role: 'user', content: 'old unrelated question' },
        { role: 'assistant', content: 'old unrelated answer' },
        { role: 'user', content: 'remember exact codeword NEBULA COPPER 817 now' },
        { role: 'assistant', content: 'saved exact codeword NEBULA COPPER 817' },
        { role: 'user', content: 'what was the immediately previous codeword' },
      ],
    });

    expect(result.messages).toEqual([
      { role: 'user', content: 'remember exact codeword NEBULA COPPER 817 now' },
      { role: 'assistant', content: 'saved exact codeword NEBULA COPPER 817' },
      { role: 'user', content: 'what was the immediately previous codeword' },
    ]);
  });
});

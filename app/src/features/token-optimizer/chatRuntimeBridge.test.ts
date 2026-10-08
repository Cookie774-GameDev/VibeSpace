import { describe, expect, it, vi } from 'vitest';

import { createChatTokenOptimizationRuntime } from './chatRuntimeBridge';

describe('chat token optimization runtime tokenizers', () => {
  it('deduplicates optional context while preserving protected and conversation history', async () => {
    const runtime = createChatTokenOptimizationRuntime();
    const context = {
      kind: 'documentation' as const,
      text: 'same optional evidence',
      relevance: 0.8,
      protected: false,
      reason: 'retrieved',
    };
    const result = await runtime.optimizeMessages({
      mode: 'saver',
      providerId: 'unknown',
      modelId: 'selected-model',
      modelContextLimit: 4000,
      contextSegments: [
        { ...context, id: 'first' },
        { ...context, id: 'duplicate' },
        { ...context, id: 'explicit', protected: true },
      ],
      requestedOutputTokens: 777,
      messages: [
        { role: 'user', content: 'same historical question' },
        { role: 'assistant', content: 'same historical answer' },
        { role: 'user', content: 'same historical question' },
        { role: 'assistant', content: 'same historical answer' },
        { role: 'user', content: 'previous exchange' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'Keep this exact request.' },
      ],
    });
    expect(result.selectedContextIds).toEqual(['first', 'explicit']);
    expect(result.receipt.outputTokenLimit).toBe(777);
    expect(result.receipt.exclusions).toHaveLength(1);
    expect(result.receipt.exclusions[0]).toMatchObject({
      kind: 'documentation',
      reason: 'duplicate',
    });
    expect(result.messages).toHaveLength(7);
    expect(result.messages.at(-1)?.content).toBe('Keep this exact request.');
    expect(result.receipt.modelId).toBe('selected-model');
  });

  it('leaves an omitted output allowance uncapped while retaining the estimate reservation', async () => {
    const runtime = createChatTokenOptimizationRuntime();
    const result = await runtime.optimizeMessages({
      mode: 'normal',
      providerId: 'unknown-provider',
      modelId: 'unknown-model',
      modelContextLimit: 20_000,
      messages: [{ role: 'user', content: 'Use the provider default output allowance.' }],
    });

    expect(result.outputTokenLimit).toBeUndefined();
    expect(result.receipt.outputTokenLimit).toBeGreaterThan(0);
  });
  it('uses the selected OpenAI family locally without changing provider or model', async () => {
    const encode = vi.fn((text: string) =>
      text.trim()
        ? text
            .trim()
            .split(/\s+/u)
            .map((_word, index) => index)
        : [],
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

  it('fails closed when the context budget is small without trimming content', async () => {
    const runtime = createChatTokenOptimizationRuntime({
      loadOpenAiO200k: async () => ({
        encode: (text: string) =>
          text.trim()
            ? text
                .trim()
                .split(/\s+/u)
                .map((_word, index) => index)
            : [],
      }),
    });
    const protectedContext = Array.from({ length: 70 }, (_, index) => `rule-${index}`).join(' ');

    await expect(
      runtime.optimizeMessages({
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
      }),
    ).rejects.toMatchObject({
      name: 'TokenOptimizationOverflowError',
      receipt: expect.objectContaining({
        fitsContext: false,
        estimatedTokensSaved: 0,
        excludedCount: 0,
      }),
    });
  });
});

describe('Foundry actual output allowance in planning', () => {
  it.each([
    [undefined, 320], [1, 1], [64, 64], [320, 320], [512, 512], [8192, 512], [0, 1],
  ])('plans the existing native formula for requested %s', async (requestedOutputTokens, expected) => {
    const runtime = createChatTokenOptimizationRuntime();
    const result = await runtime.optimizeMessages({ mode: 'normal', providerId: 'foundry',
      modelId: 'artifact--job_budget', modelContextLimit: 8192, requestedOutputTokens,
      messages: [{ role: 'user', content: 'Public request.' }] });
    expect(result.outputTokenLimit).toBe(expected);
    expect(result.receipt.outputTokenLimit).toBe(expected);
    expect(result.receipt).not.toHaveProperty('nativeValidationPending');
  });

  it('does not defer after cancellation while conservative estimates are pending', async () => {
    const controller = new AbortController();
    const runtime = createChatTokenOptimizationRuntime();
    const pending = runtime.optimizeMessages({ mode: 'normal', providerId: 'foundry',
      modelId: 'artifact--job_budget', contextMetadataSource: 'foundry_catalog_ceiling',
      modelContextLimit: 8192, systemPrompt: 'Public policy. '.repeat(2000),
      messages: [{ role: 'user', content: 'Latest request stays exact.' }], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

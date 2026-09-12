import { describe, expect, it } from 'vitest';
import {
  createTokenOptimizerService,
  createTokenizerRegistry,
  reconcileTokenUsage,
  TokenOptimizationOverflowError,
  type ProviderTokenizer,
} from './index';

const exactTokenizer: ProviderTokenizer = {
  id: 'openai:test-exact',
  providerId: 'openai',
  modelPattern: /^gpt-test$/,
  source: 'exact_local',
  transmitsContent: false,
  estimateText: async ({ text }) => text.length,
};

describe('Token Optimizer service', () => {
  it('returns the selected provider and model unchanged with a transparent receipt', async () => {
    const service = createTokenOptimizerService(createTokenizerRegistry([exactTokenizer]));
    const result = await service.optimize({
      mode: 'saver',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 1_200,
      requestedOutputTokens: 500,
      segments: [
        {
          id: 'system',
          kind: 'system_instruction',
          text: 'system authority',
          relevance: 0,
          protected: true,
          reason: 'Protected system authority',
        },
        {
          id: 'latest',
          kind: 'latest_user_message',
          text: 'latest request',
          relevance: 1,
          protected: true,
          reason: 'Latest user request',
        },
        {
          id: 'relevant',
          kind: 'repository_symbol',
          text: 'important source',
          relevance: 0.9,
          protected: false,
          reason: 'Referenced symbol',
        },
        {
          id: 'irrelevant',
          kind: 'repository_file',
          text: 'x'.repeat(800),
          relevance: 0.1,
          protected: false,
          reason: 'Low relevance',
        },
      ],
    });

    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-test');
    expect(result.selectedSegments.map(({ id }) => id)).toEqual(['system', 'latest', 'relevant']);
    expect(result.receipt).toMatchObject({
      mode: 'saver',
      tokenizerSource: 'exact_local',
      outputTokenLimit: 500,
      selectedCount: 3,
      excludedCount: 1,
      estimatedTokensSaved: 800,
      modelChanged: false,
    });
    expect(result.receipt.exclusions).toEqual([
      {
        segmentRef: 'segment-4',
        kind: 'repository_file',
        reason: 'irrelevant',
        tokens: 800,
      },
    ]);
    expect(result.receipt.inclusions).toEqual([
      {
        segmentRef: 'segment-1',
        kind: 'system_instruction',
        reason: 'protected',
        tokens: 16,
      },
      {
        segmentRef: 'segment-2',
        kind: 'latest_user_message',
        reason: 'protected',
        tokens: 14,
      },
      {
        segmentRef: 'segment-3',
        kind: 'repository_symbol',
        reason: 'relevant',
        tokens: 16,
      },
    ]);
    expect(JSON.stringify(result.receipt)).not.toContain('"id":"system"');
    expect(JSON.stringify(result.receipt)).not.toContain('system authority');
    expect(JSON.stringify(result.receipt)).not.toContain('latest request');
    expect(JSON.stringify(result.receipt)).not.toContain('"id":"irrelevant"');
  });

  it('reconciles estimates with provider-reported usage without rewriting history', () => {
    expect(
      reconcileTokenUsage(
        {
          providerId: 'openai',
          modelId: 'gpt-test',
          requestId: 'request-1',
          attemptNumber: 1,
          estimatedInputTokens: 900,
          estimatedOutputTokens: 400,
          tokenizerSource: 'conservative_estimate',
        },
        {
          providerId: 'openai',
          modelId: 'gpt-test',
          requestId: 'request-1',
          attemptNumber: 1,
          inputTokens: 820,
          outputTokens: 360,
          reasoningTokens: 75,
          cachedInputTokens: 120,
        },
      ),
    ).toEqual({
      providerId: 'openai',
      modelId: 'gpt-test',
      requestId: 'request-1',
      attemptNumber: 1,
      estimatedInputTokens: 900,
      estimatedOutputTokens: 400,
      tokenizerSource: 'conservative_estimate',
      actualInputTokens: 820,
      actualOutputTokens: 360,
      actualReasoningTokens: 75,
      actualCachedInputTokens: 120,
      actualUsageSource: 'provider_reported',
    });
  });

  it('rejects provider usage that is not bound to the same attempt', () => {
    expect(() =>
      reconcileTokenUsage(
        {
          providerId: 'openai',
          modelId: 'gpt-test',
          requestId: 'request-1',
          attemptNumber: 1,
          estimatedInputTokens: 10,
          estimatedOutputTokens: 5,
          tokenizerSource: 'exact_local',
        },
        {
          providerId: 'openai',
          modelId: 'gpt-test',
          requestId: 'request-1',
          attemptNumber: 2,
          inputTokens: 9,
          outputTokens: 4,
        },
      ),
    ).toThrow(/usage binding mismatch/i);
  });

  it('never transports protected text for token counting', async () => {
    const transported: string[] = [];
    const remote: ProviderTokenizer = {
      id: 'openai:remote-counter',
      providerId: 'openai',
      modelPattern: /^gpt-test$/,
      source: 'provider_native',
      transmitsContent: true,
      estimateText: async ({ text }) => {
        transported.push(text);
        return text.length;
      },
    };
    const service = createTokenOptimizerService(createTokenizerRegistry([remote]));

    await service.optimize({
      mode: 'normal',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 1_000,
      requestedOutputTokens: 100,
      allowProviderTokenCountTransport: true,
      segments: [
        {
          id: 'protected',
          kind: 'system_instruction',
          text: 'never transmit me',
          relevance: 1,
          protected: false,
          reason: 'System authority',
        },
        {
          id: 'optional',
          kind: 'documentation',
          text: 'transport allowed',
          relevance: 1,
          protected: false,
          reason: 'Documentation',
        },
      ],
    });

    expect(transported).toEqual(['transport allowed']);
  });

  it('fails closed when protected content cannot fit the selected model context', async () => {
    const service = createTokenOptimizerService(createTokenizerRegistry([exactTokenizer]));
    await expect(
      service.optimize({
        mode: 'saver',
        providerId: 'openai',
        modelId: 'gpt-test',
        modelContextLimit: 10,
        requestedOutputTokens: 5,
        segments: [
          {
            id: 'protected',
            kind: 'latest_user_message',
            text: 'far too long for this model',
            relevance: 1,
            protected: true,
            reason: 'Latest request',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(TokenOptimizationOverflowError);
  });

  it('reports no tokenizer provenance for an empty request', async () => {
    const service = createTokenOptimizerService(createTokenizerRegistry([]));
    const result = await service.optimize({
      mode: 'normal',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 100,
      requestedOutputTokens: 10,
      segments: [],
    });
    expect(result.receipt.tokenizerSource).toBe('none');
  });
});

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
      modelContextLimit: 2_000,
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
    expect(result.selectedSegments.map(({ id }) => id)).toEqual([
      'system',
      'latest',
      'relevant',
      'irrelevant',
    ]);
    expect(result.receipt).toMatchObject({
      mode: 'saver',
      tokenizerSource: 'exact_local',
      outputTokenLimit: 500,
      selectedCount: 4,
      excludedCount: 0,
      estimatedTokensSaved: 0,
      modelChanged: false,
    });
    expect(result.receipt.exclusions).toEqual([]);
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
      {
        segmentRef: 'segment-4',
        kind: 'repository_file',
        reason: 'relevant',
        tokens: 800,
      },
    ]);
    expect(JSON.stringify(result.receipt)).not.toContain('"id":"system"');
    expect(JSON.stringify(result.receipt)).not.toContain('system authority');
    expect(JSON.stringify(result.receipt)).not.toContain('latest request');
  });

  it('deduplicates only optional exact matches while retaining protected and history content', async () => {
    const service = createTokenOptimizerService(createTokenizerRegistry([exactTokenizer]));
    const optionalText = 'optional evidence '.repeat(8);
    const historyText = 'same historical exchange';
    const result = await service.optimize({
      mode: 'saver',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 4_000,
      requestedOutputTokens: 777,
      segments: [
        {
          id: 'protected-a',
          kind: 'system_instruction',
          text: 'protected authority',
          relevance: 1,
          protected: true,
          reason: 'Protected authority',
        },
        {
          id: 'protected-b',
          kind: 'system_instruction',
          text: 'protected authority',
          relevance: 1,
          protected: true,
          reason: 'Protected authority duplicate',
        },
        {
          id: 'optional-a',
          kind: 'documentation',
          text: optionalText,
          relevance: 0.8,
          protected: false,
          reason: 'Retrieved documentation',
        },
        {
          id: 'optional-b',
          kind: 'documentation',
          text: optionalText,
          relevance: 0.2,
          protected: false,
          reason: 'Repeated retrieved documentation',
        },
        {
          id: 'history-a',
          kind: 'conversation_history',
          text: historyText,
          relevance: 0.3,
          protected: false,
          reason: 'Older conversation history',
        },
        {
          id: 'history-b',
          kind: 'conversation_history',
          text: historyText,
          relevance: 0.4,
          protected: false,
          reason: 'Repeated conversation history',
        },
        {
          id: 'superseded-a',
          kind: 'repository_file',
          text: 'older source text',
          relevance: 0.2,
          protected: false,
          reason: 'Older source',
          supersededBy: 'superseded-b',
        },
        {
          id: 'superseded-b',
          kind: 'repository_file',
          text: 'newer source text',
          relevance: 0.8,
          protected: false,
          reason: 'Newer source',
        },
      ],
    });

    expect(result.selectedSegments.map(({ id }) => id)).toEqual([
      'protected-a',
      'protected-b',
      'optional-a',
      'history-a',
      'history-b',
      'superseded-a',
      'superseded-b',
    ]);
    expect(result.receipt).toMatchObject({
      outputTokenLimit: 777,
      selectedCount: 7,
      excludedCount: 1,
      estimatedTokensSaved: optionalText.length,
    });
    expect(result.receipt.estimatedTokensSaved).toBeGreaterThanOrEqual(
      result.receipt.estimatedInputTokensBefore * 0.05,
    );
    expect(result.receipt.exclusions).toEqual([
      {
        segmentRef: 'segment-4',
        kind: 'documentation',
        reason: 'duplicate',
        tokens: optionalText.length,
      },
    ]);
  });

  it('leaves exact duplicates untouched in Off mode', async () => {
    const service = createTokenOptimizerService(createTokenizerRegistry([exactTokenizer]));
    const result = await service.optimize({
      mode: 'off',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 4_000,
      requestedOutputTokens: 777,
      segments: [
        {
          id: 'optional-a',
          kind: 'documentation',
          text: 'same evidence',
          relevance: 0.8,
          protected: false,
          reason: 'Retrieved documentation',
        },
        {
          id: 'optional-b',
          kind: 'documentation',
          text: 'same evidence',
          relevance: 0.2,
          protected: false,
          reason: 'Repeated retrieved documentation',
        },
      ],
    });

    expect(result.selectedSegments.map(({ id }) => id)).toEqual(['optional-a', 'optional-b']);
    expect(result.receipt).toMatchObject({
      outputTokenLimit: 777,
      estimatedTokensSaved: 0,
      selectedCount: 2,
      excludedCount: 0,
    });
    expect(result.receipt.exclusions).toEqual([]);
  });

  it.each([
    {
      name: 'missing duplicate target',
      segments: [
        {
          id: 'optional',
          kind: 'documentation' as const,
          text: 'evidence',
          relevance: 1,
          protected: false,
          reason: 'Evidence',
          duplicateOf: 'missing',
        },
      ],
    },
    {
      name: 'duplicate segment id',
      segments: [
        {
          id: 'same',
          kind: 'documentation' as const,
          text: 'one',
          relevance: 1,
          protected: false,
          reason: 'Evidence',
        },
        {
          id: 'same',
          kind: 'documentation' as const,
          text: 'two',
          relevance: 1,
          protected: false,
          reason: 'Evidence',
        },
      ],
    },
    {
      name: 'duplicate reference cycle',
      segments: [
        {
          id: 'a',
          kind: 'documentation' as const,
          text: 'same',
          relevance: 1,
          protected: false,
          reason: 'Evidence',
          duplicateOf: 'b',
        },
        {
          id: 'b',
          kind: 'documentation' as const,
          text: 'same',
          relevance: 1,
          protected: false,
          reason: 'Evidence',
          duplicateOf: 'a',
        },
      ],
    },
  ])('fails closed for malformed $name references', async ({ segments }) => {
    const service = createTokenOptimizerService(createTokenizerRegistry([exactTokenizer]));

    await expect(
      service.optimize({
        mode: 'saver',
        providerId: 'openai',
        modelId: 'gpt-test',
        modelContextLimit: 4_000,
        requestedOutputTokens: 100,
        segments,
      }),
    ).rejects.toThrow(/token optimization/i);
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

  it('fails closed on overflow without dropping protected or optional content', async () => {
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
    ).rejects.toMatchObject({
      name: 'TokenOptimizationOverflowError',
      receipt: expect.objectContaining({
        fitsContext: false,
        estimatedTokensSaved: 0,
        excludedCount: 0,
      }),
    });
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

describe('native Foundry conservative estimate admission', () => {
  const request = {
    mode: 'normal' as const, providerId: 'foundry', modelId: 'artifact--job_registered',
    contextMetadataSource: 'foundry_catalog_ceiling' as const,
    modelContextLimit: 8192, requestedOutputTokens: 320,
    segments: [{ id: 'policy', kind: 'system_instruction' as const,
      text: 'Public required policy. '.repeat(2000), relevance: 1, protected: true,
      reason: 'Required policy remains complete.' }],
  };
  const conservative = () => createTokenOptimizerService(createTokenizerRegistry([]));

  it('retains conservative overflow and exact optional-dedup accounting without claiming fit', async () => {
    const optional = { id: 'first', kind: 'documentation' as const, text: 'Public optional reference.',
      relevance: 0.5, protected: false, reason: 'Public context.' };
    const result = await conservative().optimize({ ...request,
      segments: [...request.segments, optional, { ...optional, id: 'duplicate' }] });
    expect(result.selectedSegments).toEqual([...request.segments, optional]);
    expect(result.receipt).toMatchObject({ nativeValidationPending: true, fitsContext: false,
      tokenizerSource: 'conservative_estimate', selectedCount: 2, excludedCount: 1,
      estimatedTokensSaved: new TextEncoder().encode(optional.text).byteLength });
    expect(result.receipt.overflowTokens).toBeGreaterThan(0);
    expect(JSON.stringify(result.receipt)).not.toContain('Public required policy.');
    expect(JSON.stringify(result.receipt)).not.toContain('Public optional reference.');
  });

  it.each([
    { label: 'missing provenance', patch: { contextMetadataSource: undefined } },
    { label: 'other provider', patch: { providerId: 'openai' } },
    { label: 'legacy adapter', patch: { modelId: 'project--job_registered' } },
    { label: 'knowledge route', patch: { modelId: 'foundry:job_registered' } },
    { label: 'unsafe native ID', patch: { modelId: 'artifact--../escape' } },
    { label: 'oversized native ID', patch: { modelId: 'artifact--' + 'x'.repeat(65) } },
    { label: 'unusable capacity', patch: { modelContextLimit: 1 } },
    { label: 'uncapped capacity', patch: { modelContextLimit: 32768 } },
  ])('keeps $label overflow strict', async ({ patch }) => {
    await expect(conservative().optimize({ ...request, ...patch })).rejects.toMatchObject({
      name: 'TokenOptimizationOverflowError', receipt: expect.objectContaining({ fitsContext: false }),
    });
  });

  it.each(['exact_local', 'provider_native', 'mixed'] as const)(
    'keeps %s overflows strict even for registered native artifacts', async (source) => {
      let call = 0;
      const service = createTokenOptimizerService({ async estimateText() {
        call += 1;
        return { tokens: 10000, source: source === 'mixed'
          ? call === 1 ? 'exact_local' as const : 'conservative_estimate' as const
          : source, tokenizerId: 'public-test-counter' };
      } });
      await expect(service.optimize({ ...request,
        segments: [...request.segments, { ...request.segments[0]!, id: 'latest', kind: 'latest_user_message' }] }))
        .rejects.toMatchObject({ name: 'TokenOptimizationOverflowError',
          receipt: expect.objectContaining({ tokenizerSource: source, fitsContext: false }) });
    },
  );

  it('does not qualify an empty/none estimate set for native deferral', async () => {
    await expect(conservative().optimize({ ...request, segments: [], modelContextLimit: 2 }))
      .rejects.toMatchObject({ name: 'TokenOptimizationOverflowError',
        receipt: expect.objectContaining({ tokenizerSource: 'none', fitsContext: false }) });
  });

  it.each([NaN, Infinity, -1, 1.5])('retains invalid-limit rejection for %s', async (modelContextLimit) => {
    await expect(conservative().optimize({ ...request, modelContextLimit })).rejects.toThrow();
  });

  it('preserves Off and aborted semantics', async () => {
    const result = await conservative().optimize({ ...request, mode: 'off' });
    expect(result.selectedSegments).toEqual(request.segments);
    expect(result.receipt).not.toHaveProperty('nativeValidationPending');
    await expect(conservative().optimize({ ...request, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

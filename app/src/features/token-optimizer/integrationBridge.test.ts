import { describe, expect, it, vi } from 'vitest';
import {
  createExactLocalProviderTokenizer,
  createProviderNativeTokenizer,
  createTokenOptimizationPreflightCompiler,
  createTokenOptimizerService,
  createTokenizerRegistry,
  mapContextToTokenOptimizationSegments,
  reconcileTokenUsage,
  tokenOptimizationReceiptToTelemetry,
  tokenUsageReceiptToTelemetry,
  type ContextSegmentBridgeInput,
  type ProviderNativeTokenCountPort,
} from './index';

const bridgeInput: ContextSegmentBridgeInput = {
  systemInstructions: ['Keep system authority exact.'],
  latestUserContent: 'Fix the selected function.',
  explicitAttachments: ['attachment bytes'],
  pinnedContext: ['pinned decision'],
  toolSchemas: ['{"name":"read_file"}'],
  contextMapItems: [
    { exactExcerpt: 'Context Map result', ranking: { score: 0.8 } },
    { exactExcerpt: 'Low Context Map result', ranking: { score: 0.05 } },
  ],
  repositoryCandidates: [
    { text: 'export function selected() {}', kind: 'symbol', relevance: 0.9 },
    { text: 'obsolete duplicate', kind: 'file', relevance: 0.4, duplicateOfIndex: 0 },
  ],
};

describe('Token Optimize integration bridge', () => {
  it('adapts exact-local and explicitly authorized provider-native counters without substitution', async () => {
    const localCount = vi.fn(async ({ text }: { text: string }) => text.length);
    const nativeCount = vi.fn(
      async (input: { providerId: string; modelId: string; text: string }) => ({
        tokens: input.text.length + 1,
        providerId: input.providerId,
        modelId: input.modelId,
      }),
    );
    const registry = createTokenizerRegistry([
      createExactLocalProviderTokenizer({
        id: 'local:gpt-test',
        providerId: 'openai',
        modelPattern: /^gpt-test$/,
        reviewed: true,
        countText: localCount,
      }),
      createProviderNativeTokenizer({
        id: 'native:gpt-other',
        providerId: 'openai',
        modelPattern: /^gpt-other$/,
        countText: nativeCount,
      }),
    ]);

    await expect(registry.estimateText('openai', 'gpt-test', 'hello')).resolves.toMatchObject({
      tokens: 5,
      source: 'exact_local',
    });
    await expect(registry.estimateText('openai', 'gpt-other', 'hello')).resolves.toMatchObject({
      source: 'conservative_estimate',
    });
    expect(nativeCount).not.toHaveBeenCalled();

    await expect(
      registry.estimateText('openai', 'gpt-other', 'hello', {
        allowProviderTransport: true,
      }),
    ).resolves.toMatchObject({
      tokens: 6,
      source: 'provider_native',
    });
    expect(nativeCount).toHaveBeenCalledWith({
      providerId: 'openai',
      modelId: 'gpt-other',
      text: 'hello',
      authorization: 'explicit_token_count_transport',
    });
  });

  it('rejects a provider-native counter that reports a substituted model', async () => {
    const port: ProviderNativeTokenCountPort = {
      id: 'native:mismatch',
      providerId: 'openai',
      modelPattern: /^gpt-test$/,
      countText: async () => ({
        tokens: 3,
        providerId: 'openai',
        modelId: 'different-model',
      }),
    };
    const registry = createTokenizerRegistry([createProviderNativeTokenizer(port)]);
    await expect(
      registry.estimateText('openai', 'gpt-test', 'abc', {
        allowProviderTransport: true,
      }),
    ).resolves.toMatchObject({
      tokens: 3,
      source: 'conservative_estimate',
        tokenizerId: 'builtin:utf8-conservative-estimate',
    });
  });

  it('maps live context inputs to deterministic safe segments with protected boundaries', () => {
    const first = mapContextToTokenOptimizationSegments(bridgeInput);
    const second = mapContextToTokenOptimizationSegments(bridgeInput);

    expect(first).toEqual(second);
    expect(first.map(({ id }) => id)).toEqual([
      'system-001',
      'latest-user-001',
      'attachment-001',
      'pin-001',
      'tool-schema-001',
      'context-map-001',
      'context-map-002',
      'repository-001',
      'repository-002',
    ]);
    expect(first.slice(0, 5).every((segment) => segment.protected)).toBe(true);
    expect(first.at(-1)).toMatchObject({
      duplicateOf: 'repository-001',
      protected: false,
    });
    expect(first.map(({ id }) => id).join(' ')).not.toContain('selected function');
  });

  it('compiles an off-mode preflight without changing content, provider, model, or output', async () => {
    const compiler = createTokenOptimizationPreflightCompiler(
      createTokenOptimizerService(createTokenizerRegistry([])),
    );
    const mapped = mapContextToTokenOptimizationSegments(bridgeInput);
    const result = await compiler.compile({
      mode: 'off',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 10_000,
      requestedOutputTokens: 777,
      context: bridgeInput,
    });

    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-test');
    expect(result.outputTokenLimit).toBe(777);
    expect(result.selectedContent.map(({ text }) => text)).toEqual(mapped.map(({ text }) => text));
    expect(result.receipt.modelChanged).toBe(false);
    expect(result.receipt.excludedCount).toBe(0);
  });

  it('keeps protected bridge content away from an authorized remote counter', async () => {
    const transported: string[] = [];
    const compiler = createTokenOptimizationPreflightCompiler(
      createTokenOptimizerService(
        createTokenizerRegistry([
          createProviderNativeTokenizer({
            id: 'native:gpt-test',
            providerId: 'openai',
            modelPattern: /^gpt-test$/,
            countText: async (input) => {
              transported.push(input.text);
              return {
                tokens: input.text.length,
                providerId: input.providerId,
                modelId: input.modelId,
              };
            },
          }),
        ]),
      ),
    );

    const result = await compiler.compile({
      mode: 'normal',
      providerId: 'openai',
      modelId: 'gpt-test',
      modelContextLimit: 1_000,
      requestedOutputTokens: 100,
      allowProviderTokenCountTransport: true,
      context: {
        latestUserContent: 'protected user content',
        contextMapItems: [{ exactExcerpt: 'optional evidence', ranking: { score: 0.9 } }],
      },
    });

    expect(transported).toEqual(['optional evidence']);
    expect(result.receipt.tokenizerSource).toBe('mixed');
  });

  it('fails the preflight closed when protected content cannot fit', async () => {
    const compiler = createTokenOptimizationPreflightCompiler(
      createTokenOptimizerService(createTokenizerRegistry([])),
    );
    await expect(
      compiler.compile({
        mode: 'saver',
        providerId: 'openai',
        modelId: 'gpt-test',
        modelContextLimit: 4,
        requestedOutputTokens: 2,
        context: { latestUserContent: 'protected content is too large' },
      }),
    ).rejects.toThrow(/protected context exceeds/i);
  });

  it('maps safe optimization and bound usage metrics into intelligence telemetry', () => {
    const compilerReceipt = {
      mode: 'saver' as const,
      providerId: 'openai',
      modelId: 'gpt-test',
      modelChanged: false as const,
      tokenizerSource: 'exact_local' as const,
      outputTokenLimit: 512,
      estimatedInputTokensBefore: 900,
      estimatedInputTokensAfter: 500,
      estimatedTokensSaved: 400,
      selectedCount: 3,
      excludedCount: 2,
      fitsContext: true,
      overflowTokens: 0,
      inclusions: [],
      exclusions: [],
    };
    const envelope = {
      eventId: 'evt-1',
      requestId: 'req-1',
      attemptNumber: 1,
      accountScopeHash: 'acct_hash_1',
      projectScopeHash: 'project_hash_1',
      observedAt: 123,
    };
    const optimizationEvent = tokenOptimizationReceiptToTelemetry(compilerReceipt, envelope);
    const usage = reconcileTokenUsage(
      {
        providerId: 'openai',
        modelId: 'gpt-test',
        requestId: 'req-1',
        attemptNumber: 1,
        estimatedInputTokens: 500,
        estimatedOutputTokens: 200,
        tokenizerSource: 'exact_local',
      },
      {
        providerId: 'openai',
        modelId: 'gpt-test',
        requestId: 'req-1',
        attemptNumber: 1,
        inputTokens: 480,
        outputTokens: 180,
        reasoningTokens: 20,
        cachedInputTokens: 40,
      },
    );
    const usageEvent = tokenUsageReceiptToTelemetry(usage, {
      ...envelope,
      eventId: 'evt-2',
    });

    expect(optimizationEvent).toMatchObject({
      schemaVersion: 1,
      kind: 'token_optimization',
      metrics: {
        estimatedInputTokensBefore: 900,
        estimatedInputTokensAfter: 500,
        estimatedTokensSaved: 400,
        selectedSourceCount: 3,
        excludedSourceCount: 2,
      },
      attributes: {
        mode: 'saver',
        tokenizerSource: 'exact_local',
        resultState: 'fits_context',
      },
    });
    expect(usageEvent).toMatchObject({
      kind: 'provider_request',
      metrics: {
        actualInputTokens: 480,
        actualOutputTokens: 180,
        actualReasoningTokens: 20,
        cachedInputTokens: 40,
      },
    });
    expect(Object.keys(optimizationEvent).sort()).toEqual(
      [
        'accountScopeHash',
        'attemptNumber',
        'attributes',
        'eventId',
        'kind',
        'metrics',
        'modelId',
        'observedAt',
        'projectScopeHash',
        'providerId',
        'requestId',
        'schemaVersion',
      ].sort(),
    );
    expect(JSON.stringify([optimizationEvent, usageEvent])).not.toContain('raw private');
    expect(() =>
      tokenOptimizationReceiptToTelemetry(compilerReceipt, {
        ...envelope,
        accountScopeHash: 'C:\\private\\user',
      }),
    ).toThrow(/invalid telemetry account scope hash/i);
  });
});

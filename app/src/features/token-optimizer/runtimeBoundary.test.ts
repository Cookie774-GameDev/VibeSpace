import { describe, expect, it, vi } from 'vitest';
import {
  createDurableTokenOptimizationPreferenceRepository,
  createProviderNativeTokenizer,
  createTokenOptimizationRuntime,
  createTokenOptimizerService,
  createTokenizerRegistry,
  mapContextToTokenOptimizationSegments,
  type DurablePreferenceValue,
  type DurableTokenOptimizationPreferenceStorage,
} from './index';

function durableMemoryStorage(): DurableTokenOptimizationPreferenceStorage & {
  failNextWrite: boolean;
  raw: string | null;
} {
  let storageRevision = 0;
  return {
    raw: null,
    failNextWrite: false,
    async read(): Promise<DurablePreferenceValue> {
      return {
        value: this.raw,
        storageRevision: this.raw === null ? null : String(storageRevision),
      };
    },
    async compareAndSet(_key, expectedStorageRevision, value) {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        return { applied: false, storageRevision: String(storageRevision) };
      }
      const currentRevision = this.raw === null ? null : String(storageRevision);
      if (currentRevision !== expectedStorageRevision) {
        return { applied: false, storageRevision: String(storageRevision) };
      }
      storageRevision += 1;
      this.raw = value;
      return { applied: true, storageRevision: String(storageRevision) };
    },
  };
}

const context = {
  systemInstructions: ['system authority'],
  latestUserContent: 'latest private request',
  contextMapItems: [
    { exactExcerpt: 'high-value optional evidence', ranking: { score: 0.9 } },
    { exactExcerpt: 'low-value optional evidence', ranking: { score: 0.01 } },
  ],
} as const;

describe('Token Optimize runtime and durable preference boundary', () => {
  it('persists isolated global/chat preferences with optimistic, restart-safe idempotent writes', async () => {
    const storage = durableMemoryStorage();
    storage.failNextWrite = true;
    const first = createDurableTokenOptimizationPreferenceRepository(storage);

    expect((await first.setGlobalMode('saver', 'mutation-global-1')).revision).toBe(1);
    expect((await first.setChatOverride('chat-a', 'final_boss', 'mutation-chat-1')).revision).toBe(
      2,
    );
    expect((await first.setChatOverride('chat-a', 'final_boss', 'mutation-chat-1')).revision).toBe(
      2,
    );

    const restarted = createDurableTokenOptimizationPreferenceRepository(storage);
    expect(await restarted.resolveMode('chat-a')).toBe('final_boss');
    expect(await restarted.resolveMode('chat-b')).toBe('saver');
    await expect(restarted.setChatOverride('chat-b', 'off', 'mutation-chat-1')).rejects.toThrow(
      /reused for a different write/i,
    );
    expect(storage.raw).not.toContain('latest private request');
  });

  it('gates to exact Off behavior and preserves provider, model, content, and output', async () => {
    const resolveMode = vi.fn(async () => 'final_boss' as const);
    const runtime = createTokenOptimizationRuntime({
      service: createTokenOptimizerService(createTokenizerRegistry([])),
      preferences: { resolveMode },
      featureGate: { isEnabled: () => false },
    });

    const result = await runtime.prepare({
      chatKey: 'chat-a',
      providerId: 'openai',
      modelId: 'gpt-fixed',
      modelContextLimit: 10_000,
      requestedOutputTokens: 777,
      context,
    });

    expect(resolveMode).not.toHaveBeenCalled();
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Expected ready preflight.');
    expect(result.mode).toBe('off');
    expect(result.preflight.providerId).toBe('openai');
    expect(result.preflight.modelId).toBe('gpt-fixed');
    expect(result.preflight.outputTokenLimit).toBe(777);
    expect(result.preflight.selectedContent).toEqual(
      mapContextToTokenOptimizationSegments(context).map(({ kind, text }) => ({ kind, text })),
    );
    expect(result.preflight.receipt).toMatchObject({
      mode: 'off',
      modelChanged: false,
      excludedCount: 0,
      fitsContext: true,
    });
  });

  it('resolves chat preference, emits only safe receipt telemetry, and reports overflow truthfully', async () => {
    const events: unknown[] = [];
    const preferences = {
      resolveMode: vi.fn(async (chatKey?: string | null) =>
        chatKey === 'chat-final' ? ('final_boss' as const) : ('saver' as const),
      ),
    };
    const runtime = createTokenOptimizationRuntime({
      service: createTokenOptimizerService(createTokenizerRegistry([])),
      preferences,
      featureGate: { isEnabled: () => true },
      telemetry: {
        emit: (event) => {
          events.push(event);
        },
      },
    });
    const envelope = {
      eventId: 'evt-runtime-1',
      requestId: 'req-runtime-1',
      attemptNumber: 1,
      accountScopeHash: 'account_hash',
      projectScopeHash: 'project_hash',
      observedAt: 123,
    };

    const ready = await runtime.prepare({
      chatKey: 'chat-final',
      providerId: 'openai',
      modelId: 'gpt-fixed',
      modelContextLimit: 10_000,
      requestedOutputTokens: 900,
      context,
      telemetryEnvelope: envelope,
    });
    expect(ready).toMatchObject({
      state: 'ready',
      mode: 'final_boss',
      preflight: { providerId: 'openai', modelId: 'gpt-fixed' },
    });
    expect(JSON.stringify(events)).not.toContain('private request');
    expect(JSON.stringify(events)).not.toContain('optional evidence');

    const overflow = await runtime.prepare({
      chatKey: 'chat-other',
      providerId: 'openai',
      modelId: 'gpt-fixed',
      modelContextLimit: 4,
      requestedOutputTokens: 2,
      context: { latestUserContent: 'protected content cannot fit' },
      telemetryEnvelope: { ...envelope, eventId: 'evt-runtime-2' },
    });
    expect(overflow).toMatchObject({
      state: 'overflow',
      mode: 'saver',
      receipt: {
        providerId: 'openai',
        modelId: 'gpt-fixed',
        modelChanged: false,
        fitsContext: false,
      },
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      attributes: { resultState: 'protected_overflow' },
    });
  });

  it('propagates cancellation through provider-bound token counting without a completion event', async () => {
    const controller = new AbortController();
    let nativeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nativeStarted = resolve;
    });
    const telemetry = { emit: vi.fn() };
    const runtime = createTokenOptimizationRuntime({
      service: createTokenOptimizerService(
        createTokenizerRegistry([
          createProviderNativeTokenizer({
            id: 'native:gpt-fixed',
            providerId: 'openai',
            modelPattern: /^gpt-fixed$/,
            countText: async ({ signal }) => {
              nativeStarted();
              await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
              return { tokens: 1, providerId: 'openai', modelId: 'gpt-fixed' };
            },
          }),
        ]),
      ),
      preferences: { resolveMode: async () => 'normal' },
      featureGate: { isEnabled: () => true },
      telemetry,
    });

    const pending = runtime.prepare({
      providerId: 'openai',
      modelId: 'gpt-fixed',
      modelContextLimit: 1_000,
      requestedOutputTokens: 100,
      context: {
        latestUserContent: 'protected',
        contextMapItems: [{ exactExcerpt: 'remote optional', ranking: { score: 1 } }],
      },
      allowProviderTokenCountTransport: true,
      telemetryEnvelope: {
        eventId: 'evt-cancel-1',
        requestId: 'req-cancel-1',
        attemptNumber: 1,
        accountScopeHash: 'account_hash',
        projectScopeHash: 'project_hash',
        observedAt: 124,
      },
      signal: controller.signal,
    });
    await started;
    controller.abort(new DOMException('Cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(telemetry.emit).not.toHaveBeenCalled();
  });

  it('fails closed if an injected optimizer substitutes the selected model', async () => {
    const runtime = createTokenOptimizationRuntime({
      service: {
        optimize: async (request) => ({
          providerId: request.providerId,
          modelId: 'substituted-model',
          selectedSegments: request.segments,
          receipt: {
            mode: request.mode,
            providerId: request.providerId,
            modelId: 'substituted-model',
            modelChanged: false,
            tokenizerSource: 'none',
            outputTokenLimit: request.requestedOutputTokens,
            estimatedInputTokensBefore: 1,
            estimatedInputTokensAfter: 1,
            estimatedTokensSaved: 0,
            selectedCount: request.segments.length,
            excludedCount: 0,
            fitsContext: true,
            overflowTokens: 0,
            inclusions: [],
            exclusions: [],
          },
        }),
      },
      preferences: { resolveMode: async () => 'normal' },
      featureGate: { isEnabled: () => true },
    });

    await expect(
      runtime.prepare({
        providerId: 'openai',
        modelId: 'gpt-fixed',
        modelContextLimit: 1_000,
        requestedOutputTokens: 100,
        context: { latestUserContent: 'private request' },
      }),
    ).rejects.toThrow(/changed the selected provider or model/i);
  });
});

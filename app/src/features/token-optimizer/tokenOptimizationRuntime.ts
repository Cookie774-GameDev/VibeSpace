import type { IntelligenceTelemetryEvent } from '@/lib/ai/intelligenceTelemetry';
import type { TokenOptimizationMode } from './contracts';
import type { ContextSegmentBridgeInput } from './contextSegmentMapper';
import {
  tokenOptimizationReceiptToTelemetry,
  type IntelligenceTelemetryEnvelope,
} from './intelligenceTelemetryBridge';
import type { TokenOptimizationReceipt } from './optimizationReport';
import {
  TokenOptimizationOverflowError,
  type TokenOptimizerService,
} from './tokenOptimizerService';
import {
  createTokenOptimizationPreflightCompiler,
  type TokenOptimizationPreflightResult,
} from './tokenOptimizerPreflight';

export interface TokenOptimizationRuntimePreferences {
  resolveMode(chatKey?: string | null): Promise<TokenOptimizationMode>;
}

export interface TokenOptimizationFeatureGate {
  isEnabled(): boolean | Promise<boolean>;
}

export interface TokenOptimizationTelemetryEmitter {
  emit(event: IntelligenceTelemetryEvent): void | Promise<void>;
}

export interface TokenOptimizationRuntimeRequest {
  readonly chatKey?: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelContextLimit: number;
  readonly requestedOutputTokens: number;
  readonly context: ContextSegmentBridgeInput;
  readonly allowProviderTokenCountTransport?: boolean;
  readonly telemetryEnvelope?: IntelligenceTelemetryEnvelope;
  readonly signal?: AbortSignal;
}

export type TokenOptimizationRuntimeResult =
  | Readonly<{
      state: 'ready';
      mode: TokenOptimizationMode;
      preflight: TokenOptimizationPreflightResult;
    }>
  | Readonly<{
      state: 'overflow';
      mode: TokenOptimizationMode;
      receipt: TokenOptimizationReceipt;
    }>;

export interface TokenOptimizationRuntime {
  prepare(request: TokenOptimizationRuntimeRequest): Promise<TokenOptimizationRuntimeResult>;
}

export function createTokenOptimizationRuntime(input: {
  readonly service: TokenOptimizerService;
  readonly preferences: TokenOptimizationRuntimePreferences;
  readonly featureGate: TokenOptimizationFeatureGate;
  readonly telemetry?: TokenOptimizationTelemetryEmitter;
}): TokenOptimizationRuntime {
  const compiler = createTokenOptimizationPreflightCompiler(input.service);

  return {
    async prepare(request) {
      throwIfAborted(request.signal);
      const enabled = await input.featureGate.isEnabled();
      throwIfAborted(request.signal);
      const mode = enabled ? await input.preferences.resolveMode(request.chatKey) : 'off';
      throwIfAborted(request.signal);

      try {
        const preflight = await compiler.compile({
          mode,
          providerId: request.providerId,
          modelId: request.modelId,
          modelContextLimit: request.modelContextLimit,
          requestedOutputTokens: request.requestedOutputTokens,
          context: request.context,
          ...(request.allowProviderTokenCountTransport === undefined
            ? {}
            : {
                allowProviderTokenCountTransport: request.allowProviderTokenCountTransport,
              }),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        throwIfAborted(request.signal);
        assertSelectionUnchanged(request, preflight.providerId, preflight.modelId);
        await emitReceipt(input.telemetry, request.telemetryEnvelope, preflight.receipt);
        throwIfAborted(request.signal);
        return Object.freeze({ state: 'ready' as const, mode, preflight });
      } catch (error) {
        throwIfAborted(request.signal);
        if (error instanceof TokenOptimizationOverflowError) {
          assertSelectionUnchanged(request, error.receipt.providerId, error.receipt.modelId);
          await emitReceipt(input.telemetry, request.telemetryEnvelope, error.receipt);
          throwIfAborted(request.signal);
          return Object.freeze({ state: 'overflow' as const, mode, receipt: error.receipt });
        }
        throw error;
      }
    },
  };
}

function assertSelectionUnchanged(
  request: TokenOptimizationRuntimeRequest,
  providerId: string,
  modelId: string,
): void {
  if (providerId !== request.providerId || modelId !== request.modelId) {
    throw new Error('Token optimization runtime changed the selected provider or model.');
  }
}

async function emitReceipt(
  emitter: TokenOptimizationTelemetryEmitter | undefined,
  envelope: IntelligenceTelemetryEnvelope | undefined,
  receipt: TokenOptimizationReceipt,
): Promise<void> {
  if (!emitter || !envelope) return;
  await emitter.emit(tokenOptimizationReceiptToTelemetry(receipt, envelope));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Token optimization was cancelled.');
  error.name = 'AbortError';
  throw error;
}

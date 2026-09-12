import type { ContextBudgetKind, TokenOptimizationMode } from './contracts';
import {
  mapContextToTokenOptimizationSegments,
  type ContextSegmentBridgeInput,
} from './contextSegmentMapper';
import type { TokenOptimizationReceipt } from './optimizationReport';
import type { TokenOptimizerService } from './tokenOptimizerService';

export interface TokenOptimizationPreflightRequest {
  readonly mode: TokenOptimizationMode;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelContextLimit: number;
  readonly requestedOutputTokens: number;
  readonly context: ContextSegmentBridgeInput;
  readonly allowProviderTokenCountTransport?: boolean;
  readonly signal?: AbortSignal;
}

export interface TokenOptimizationPreflightResult {
  readonly providerId: string;
  readonly modelId: string;
  readonly outputTokenLimit: number;
  readonly selectedContent: readonly Readonly<{
    kind: ContextBudgetKind;
    text: string;
  }>[];
  readonly receipt: TokenOptimizationReceipt;
}

export interface TokenOptimizationPreflightCompiler {
  compile(request: TokenOptimizationPreflightRequest): Promise<TokenOptimizationPreflightResult>;
}

export function createTokenOptimizationPreflightCompiler(
  service: TokenOptimizerService,
): TokenOptimizationPreflightCompiler {
  return {
    async compile(request) {
      throwIfAborted(request.signal);
      const segments = mapContextToTokenOptimizationSegments(request.context);
      const optimized = await service.optimize({
        mode: request.mode,
        providerId: request.providerId,
        modelId: request.modelId,
        modelContextLimit: request.modelContextLimit,
        requestedOutputTokens: request.requestedOutputTokens,
        segments,
        ...(request.allowProviderTokenCountTransport === undefined
          ? {}
          : {
              allowProviderTokenCountTransport: request.allowProviderTokenCountTransport,
            }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      throwIfAborted(request.signal);
      if (
        optimized.providerId !== request.providerId ||
        optimized.modelId !== request.modelId ||
        optimized.receipt.modelChanged
      ) {
        throw new Error('Token optimization changed the selected provider or model.');
      }
      if (!optimized.receipt.fitsContext) {
        throw new Error('Token optimization produced an invalid overflowing preflight.');
      }
      return Object.freeze({
        providerId: optimized.providerId,
        modelId: optimized.modelId,
        outputTokenLimit: optimized.receipt.outputTokenLimit,
        selectedContent: Object.freeze(
          optimized.selectedSegments.map(({ kind, text }) => Object.freeze({ kind, text })),
        ),
        receipt: optimized.receipt,
      });
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Token optimization was cancelled.');
  error.name = 'AbortError';
  throw error;
}

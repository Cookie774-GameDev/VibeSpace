import type {
  ContextBudgetKind,
  TokenEstimateSource,
  TokenizerRegistry,
  TokenOptimizationMode,
} from './contracts';
import type { TokenOptimizationReceipt, TokenizerSourceSummary } from './optimizationReport';
import { isProtectedContext } from './protectedContent';

export interface TokenOptimizationSegment {
  id: string;
  kind: ContextBudgetKind;
  text: string;
  relevance: number;
  protected: boolean;
  reason: string;
  duplicateOf?: string;
  supersededBy?: string;
}

export interface TokenOptimizerRequest {
  mode: TokenOptimizationMode;
  providerId: string;
  modelId: string;
  modelContextLimit: number;
  requestedOutputTokens: number;
  segments: readonly TokenOptimizationSegment[];
  allowProviderTokenCountTransport?: boolean;
  signal?: AbortSignal;
}

export interface TokenOptimizerResult {
  providerId: string;
  modelId: string;
  selectedSegments: readonly TokenOptimizationSegment[];
  receipt: TokenOptimizationReceipt;
}

export interface TokenOptimizerService {
  optimize(request: TokenOptimizerRequest): Promise<TokenOptimizerResult>;
}

export class TokenOptimizationOverflowError extends Error {
  readonly receipt: TokenOptimizationReceipt;

  constructor(receipt: TokenOptimizationReceipt) {
    super(
      `Estimated context exceeds the selected model context limit by ${receipt.overflowTokens} tokens.`,
    );
    this.name = 'TokenOptimizationOverflowError';
    this.receipt = receipt;
  }
}

function combinedSource(sources: readonly TokenEstimateSource[]): TokenizerSourceSummary {
  if (sources.length === 0) return 'none';
  const unique = new Set(sources);
  return unique.size === 1 ? sources[0]! : 'mixed';
}

function assertSafeSelectionIdentity(label: string, value: string): void {
  if (
    !value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new Error(`Invalid selected ${label}.`);
  }
}

export function createTokenOptimizerService(tokenizers: TokenizerRegistry): TokenOptimizerService {
  return {
    async optimize(request) {
      throwIfAborted(request.signal);
      assertSafeSelectionIdentity('provider', request.providerId);
      assertSafeSelectionIdentity('model', request.modelId);

      const estimated = await Promise.all(
        request.segments.map(async (segment) => ({
          segment,
          estimate: await tokenizers.estimateText(
            request.providerId,
            request.modelId,
            segment.text,
            {
              allowProviderTransport:
                request.allowProviderTokenCountTransport === true &&
                !segment.protected &&
                !isProtectedContext(segment.kind),
              ...(request.signal ? { signal: request.signal } : {}),
            },
          ),
        })),
      );
      throwIfAborted(request.signal);
      const estimatedInputTokens = estimated.reduce(
        (total, { estimate }) => checkedTokenAdd(total, estimate.tokens),
        0,
      );
      const outputTokenLimit = safeNonNegativeInteger(request.requestedOutputTokens);
      const modelContextLimit = safeNonNegativeInteger(request.modelContextLimit);
      const overflowTokens = Math.max(
        0,
        checkedTokenAdd(estimatedInputTokens, outputTokenLimit) - modelContextLimit,
      );
      const fitsContext = overflowTokens === 0;
      const segmentRefs = new Map(
        request.segments.map((segment, index) => [segment.id, `segment-${index + 1}` as const]),
      );
      const receipt: TokenOptimizationReceipt = Object.freeze({
        mode: request.mode,
        providerId: request.providerId,
        modelId: request.modelId,
        modelChanged: false,
        tokenizerSource: combinedSource(estimated.map(({ estimate }) => estimate.source)),
        outputTokenLimit,
        estimatedInputTokensBefore: estimatedInputTokens,
        estimatedInputTokensAfter: estimatedInputTokens,
        estimatedTokensSaved: 0,
        selectedCount: request.segments.length,
        excludedCount: 0,
        fitsContext,
        overflowTokens,
        inclusions: Object.freeze(
          estimated.map(({ segment, estimate }) =>
            Object.freeze({
              segmentRef: segmentRefs.get(segment.id)!,
              kind: segment.kind,
              reason:
                segment.protected || isProtectedContext(segment.kind)
                  ? ('protected' as const)
                  : ('relevant' as const),
              tokens: estimate.tokens,
            }),
          ),
        ),
        exclusions: Object.freeze([]),
      });

      if (!fitsContext && request.mode !== 'off') {
        throw new TokenOptimizationOverflowError(receipt);
      }

      return {
        providerId: request.providerId,
        modelId: request.modelId,
        selectedSegments: request.segments,
        receipt,
      };
    },
  };
}

function safeNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Token optimization limits must be non-negative safe integers.');
  }
  return value;
}

function checkedTokenAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error('Token count exceeds safe integer range.');
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Token optimization was cancelled.');
  error.name = 'AbortError';
  throw error;
}

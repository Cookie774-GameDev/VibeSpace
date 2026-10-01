import type {
  ContextBudgetCandidate,
  ContextBudgetKind,
  TokenEstimateSource,
  TokenizerRegistry,
  TokenOptimizationMode,
} from './contracts';
import type { TokenOptimizationReceipt, TokenizerSourceSummary } from './optimizationReport';
import { isProtectedContext } from './protectedContent';
import { buildTokenBudgetPlan } from './tokenBudget';

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
    super('Protected context exceeds the selected model context limit.');
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
      const candidates: ContextBudgetCandidate[] = estimated.map(({ segment, estimate }) => ({
        id: segment.id,
        kind: segment.kind,
        estimatedTokens: estimate.tokens,
        relevance: segment.relevance,
        protected: segment.protected,
        reason: segment.reason,
        ...(segment.duplicateOf ? { duplicateOf: segment.duplicateOf } : {}),
        ...(segment.supersededBy ? { supersededBy: segment.supersededBy } : {}),
      }));
      const plan = buildTokenBudgetPlan({
        mode: request.mode,
        modelContextLimit: request.modelContextLimit,
        requestedOutputTokens: request.requestedOutputTokens,
        fixedInputTokens: 0,
        candidates,
      });
      const selectedIds = new Set(plan.selected.map(({ id }) => id));
      const segmentRefs = new Map(
        request.segments.map((segment, index) => [segment.id, `segment-${index + 1}` as const]),
      );
      const receipt: TokenOptimizationReceipt = Object.freeze({
        mode: request.mode,
        providerId: request.providerId,
        modelId: request.modelId,
        modelChanged: false,
        tokenizerSource: combinedSource(estimated.map(({ estimate }) => estimate.source)),
        outputTokenLimit: plan.outputTokenLimit,
        estimatedInputTokensBefore: plan.estimatedInputTokensBefore,
        estimatedInputTokensAfter: plan.estimatedInputTokensAfter,
        estimatedTokensSaved: plan.estimatedTokensSaved,
        selectedCount: plan.selected.length,
        excludedCount: plan.excluded.length,
        fitsContext: plan.fitsContext,
        overflowTokens: plan.overflowTokens,
        inclusions: Object.freeze(
          plan.selected.map((candidate) =>
            Object.freeze({
              segmentRef: segmentRefs.get(candidate.id)!,
              kind: candidate.kind,
              reason:
                candidate.protected || isProtectedContext(candidate.kind)
                  ? ('protected' as const)
                  : ('relevant' as const),
              tokens: candidate.estimatedTokens,
            }),
          ),
        ),
        exclusions: Object.freeze(
          plan.excluded.map((candidate) =>
            Object.freeze({
              segmentRef: segmentRefs.get(candidate.id)!,
              kind: candidate.kind,
              reason: candidate.exclusionReason,
              tokens: candidate.estimatedTokens,
            }),
          ),
        ),
      });

      if (!plan.fitsContext) {
        throw new TokenOptimizationOverflowError(receipt);
      }

      return {
        providerId: request.providerId,
        modelId: request.modelId,
        selectedSegments: request.segments.filter(({ id }) => selectedIds.has(id)),
        receipt,
      };
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

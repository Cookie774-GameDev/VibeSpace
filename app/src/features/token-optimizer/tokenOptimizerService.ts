import type {
  ContextBudgetKind,
  TokenEstimateSource,
  TokenizerRegistry,
  TokenOptimizationMode,
} from './contracts';
import type { TokenOptimizationReceipt, TokenizerSourceSummary } from './optimizationReport';
import { isProtectedContext } from './protectedContent';
import { hasNativeFoundryContextValidation } from '@/lib/ai/providers/foundryRequestLimits';

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
  contextMetadataSource?: 'foundry_catalog_ceiling';
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
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new Error(`Invalid selected ${label}.`);
  }
}

function validateSegmentReferences(segments: readonly TokenOptimizationSegment[]): void {
  const indexesById = new Map<string, number>();
  for (const [index, segment] of segments.entries()) {
    if (!segment || typeof segment !== 'object') {
      throw new Error('Invalid token optimization segment.');
    }
    assertSafeSelectionIdentity('segment', segment.id);
    if (indexesById.has(segment.id)) {
      throw new Error('Duplicate token optimization segment id.');
    }
    indexesById.set(segment.id, index);
  }

  for (const [index, segment] of segments.entries()) {
    for (const field of ['duplicateOf', 'supersededBy'] as const) {
      const targetId = segment[field];
      if (targetId === undefined) continue;
      assertSafeSelectionIdentity(`${field} target`, targetId);
      const targetIndex = indexesById.get(targetId);
      if (targetIndex === undefined || targetIndex === index) {
        throw new Error(`Invalid token optimization ${field} reference.`);
      }
    }
  }

  for (const field of ['duplicateOf', 'supersededBy'] as const) {
    const visiting = new Set<number>();
    const visited = new Set<number>();
    const visit = (index: number): void => {
      if (visiting.has(index)) {
        throw new Error(`Cyclic token optimization ${field} references.`);
      }
      if (visited.has(index)) return;
      visiting.add(index);
      const targetId = segments[index]![field];
      if (targetId !== undefined) visit(indexesById.get(targetId)!);
      visiting.delete(index);
      visited.add(index);
    };
    for (let index = 0; index < segments.length; index += 1) visit(index);
  }
}

function canDeduplicate(segment: TokenOptimizationSegment): boolean {
  return !segment.protected && !isProtectedContext(segment.kind) && segment.kind !== 'conversation_history';
}

function segmentKey(segment: TokenOptimizationSegment): string {
  return JSON.stringify([segment.kind, segment.text]);
}

export function createTokenOptimizerService(tokenizers: TokenizerRegistry): TokenOptimizerService {
  return {
    async optimize(request) {
      throwIfAborted(request.signal);
      assertSafeSelectionIdentity('provider', request.providerId);
      assertSafeSelectionIdentity('model', request.modelId);
      validateSegmentReferences(request.segments);

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
      const canonicalByKey = new Map<string, number>();
      const selectedIndexes: number[] = [];
      const excludedIndexes: number[] = [];
      for (const [index, segment] of request.segments.entries()) {
        const key = segmentKey(segment);
        if (
          request.mode !== 'off' &&
          canDeduplicate(segment) &&
          canonicalByKey.has(key)
        ) {
          excludedIndexes.push(index);
          continue;
        }
        selectedIndexes.push(index);
        if (request.mode !== 'off' && canDeduplicate(segment)) {
          canonicalByKey.set(key, index);
        }
      }
      const estimatedInputTokensAfter = selectedIndexes.reduce(
        (total, index) => checkedTokenAdd(total, estimated[index]!.estimate.tokens),
        0,
      );
      const outputTokenLimit = safeNonNegativeInteger(request.requestedOutputTokens);
      const modelContextLimit = safeNonNegativeInteger(request.modelContextLimit);
      const overflowTokens = Math.max(
        0,
        checkedTokenAdd(estimatedInputTokensAfter, outputTokenLimit) - modelContextLimit,
      );
      const fitsContext = overflowTokens === 0;
      // A UTF-8 upper bound is not a measured model-token count. Only a
      // registered native weight route has the exact, no-truncation guard.
      const nativeValidationPending = !fitsContext && request.mode !== 'off' &&
        estimated.length > 0 && estimated.every(({ estimate }) => estimate.source === 'conservative_estimate') &&
        hasNativeFoundryContextValidation({
          providerId: request.providerId, modelId: request.modelId, modelContextLimit,
          contextMetadataSource: request.contextMetadataSource,
        });
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
        estimatedInputTokensAfter,
        estimatedTokensSaved: estimatedInputTokens - estimatedInputTokensAfter,
        selectedCount: selectedIndexes.length,
        excludedCount: excludedIndexes.length,
        fitsContext,
        overflowTokens,
        ...(nativeValidationPending ? { nativeValidationPending: true as const } : {}),
        inclusions: Object.freeze(
          selectedIndexes.map((index) => {
            const { segment, estimate } = estimated[index]!;
            return Object.freeze({
              segmentRef: segmentRefs.get(segment.id)!,
              kind: segment.kind,
              reason:
                segment.protected || isProtectedContext(segment.kind)
                  ? ('protected' as const)
                  : ('relevant' as const),
              tokens: estimate.tokens,
            });
          }),
        ),
        exclusions: Object.freeze(
          excludedIndexes.map((index) => {
            const { segment, estimate } = estimated[index]!;
            return Object.freeze({
              segmentRef: segmentRefs.get(segment.id)!,
              kind: segment.kind,
              reason: 'duplicate' as const,
              tokens: estimate.tokens,
            });
          }),
        ),
      });

      if (!fitsContext && request.mode !== 'off' && !nativeValidationPending) {
        throw new TokenOptimizationOverflowError(receipt);
      }

      return {
        providerId: request.providerId,
        modelId: request.modelId,
        selectedSegments: Object.freeze(selectedIndexes.map((index) => request.segments[index]!)),
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

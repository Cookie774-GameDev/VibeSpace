import type {
  ContextBudgetKind,
  ContextExclusionReason,
  TokenEstimateSource,
  TokenOptimizationMode,
} from './contracts';

export type TokenizerSourceSummary = TokenEstimateSource | 'mixed' | 'none';
export type ContextInclusionReason = 'protected' | 'relevant';

export interface SafeContextReceiptItem {
  segmentRef: `segment-${number}`;
  kind: ContextBudgetKind;
  tokens: number;
}

export interface TokenOptimizationReceipt {
  mode: TokenOptimizationMode;
  providerId: string;
  modelId: string;
  modelChanged: false;
  tokenizerSource: TokenizerSourceSummary;
  outputTokenLimit: number;
  estimatedInputTokensBefore: number;
  estimatedInputTokensAfter: number;
  estimatedTokensSaved: number;
  selectedCount: number;
  excludedCount: number;
  fitsContext: boolean;
  overflowTokens: number;
  inclusions: readonly Readonly<
    SafeContextReceiptItem & {
      reason: ContextInclusionReason;
    }
  >[];
  exclusions: readonly Readonly<
    SafeContextReceiptItem & {
      reason: ContextExclusionReason;
    }
  >[];
}

export interface TokenUsageBinding {
  providerId: string;
  modelId: string;
  requestId: string;
  attemptNumber: number;
}

export interface EstimatedUsage extends TokenUsageBinding {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  tokenizerSource: TokenizerSourceSummary;
}

export interface ProviderReportedUsage extends TokenUsageBinding {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface ReconciledTokenUsage extends EstimatedUsage {
  actualInputTokens: number;
  actualOutputTokens: number;
  actualReasoningTokens?: number;
  actualCachedInputTokens?: number;
  actualUsageSource: 'provider_reported';
}

function assertUsageValue(label: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function assertUsageBinding(binding: TokenUsageBinding): void {
  for (const [label, value] of [
    ['provider id', binding.providerId],
    ['model id', binding.modelId],
    ['request id', binding.requestId],
  ] as const) {
    if (!value.trim() || value.length > 256) {
      throw new Error(`Invalid usage ${label}.`);
    }
  }
  if (!Number.isSafeInteger(binding.attemptNumber) || binding.attemptNumber < 1) {
    throw new Error('Invalid usage attempt number.');
  }
}

export function reconcileTokenUsage(
  estimated: EstimatedUsage,
  actual: ProviderReportedUsage,
): ReconciledTokenUsage {
  assertUsageBinding(estimated);
  assertUsageBinding(actual);
  if (
    estimated.providerId !== actual.providerId ||
    estimated.modelId !== actual.modelId ||
    estimated.requestId !== actual.requestId ||
    estimated.attemptNumber !== actual.attemptNumber
  ) {
    throw new Error('Usage binding mismatch.');
  }
  assertUsageValue('estimated input token count', estimated.estimatedInputTokens);
  assertUsageValue('estimated output token count', estimated.estimatedOutputTokens);
  assertUsageValue('actual input token count', actual.inputTokens);
  assertUsageValue('actual output token count', actual.outputTokens);
  assertUsageValue('actual reasoning token count', actual.reasoningTokens);
  assertUsageValue('actual cached input token count', actual.cachedInputTokens);

  return {
    ...estimated,
    actualInputTokens: actual.inputTokens,
    actualOutputTokens: actual.outputTokens,
    ...(actual.reasoningTokens === undefined
      ? {}
      : { actualReasoningTokens: actual.reasoningTokens }),
    ...(actual.cachedInputTokens === undefined
      ? {}
      : { actualCachedInputTokens: actual.cachedInputTokens }),
    actualUsageSource: 'provider_reported',
  };
}

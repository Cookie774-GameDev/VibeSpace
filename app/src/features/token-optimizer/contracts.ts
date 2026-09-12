export const TOKEN_OPTIMIZATION_MODES = ['off', 'saver', 'normal', 'final_boss'] as const;

export type TokenOptimizationMode = (typeof TOKEN_OPTIMIZATION_MODES)[number];

export const CONTEXT_BUDGET_KINDS = [
  'system_instruction',
  'latest_user_message',
  'explicit_attachment',
  'pinned_context_node',
  'tool_schema',
  'approval_requirement',
  'quoted_preserved_text',
  'exact_patch',
  'structured_tool_data',
  'secret_detection_warning',
  'repository_file',
  'repository_symbol',
  'memory',
  'context_map_node',
  'conversation_history',
  'documentation',
] as const;

export type ContextBudgetKind = (typeof CONTEXT_BUDGET_KINDS)[number];

export type TokenEstimateSource = 'exact_local' | 'provider_native' | 'conservative_estimate';

export interface TokenEstimate {
  tokens: number;
  source: TokenEstimateSource;
  tokenizerId: string;
}

export interface ProviderTokenizerEstimateInput {
  providerId: string;
  modelId: string;
  text: string;
  providerTransportAuthorized: boolean;
  signal?: AbortSignal;
}

export interface ProviderTokenizer {
  id: string;
  providerId: string;
  modelPattern: RegExp;
  source: Exclude<TokenEstimateSource, 'conservative_estimate'>;
  transmitsContent: boolean;
  estimateText(input: Readonly<ProviderTokenizerEstimateInput>): Promise<number>;
}

export interface TokenizerRegistry {
  estimateText(
    providerId: string,
    modelId: string,
    text: string,
    options?: Readonly<{ allowProviderTransport?: boolean; signal?: AbortSignal }>,
  ): Promise<TokenEstimate>;
}

export interface ContextBudgetCandidate {
  id: string;
  kind: ContextBudgetKind;
  estimatedTokens: number;
  relevance: number;
  protected: boolean;
  reason: string;
  duplicateOf?: string;
  supersededBy?: string;
}

export type ContextExclusionReason = 'duplicate' | 'superseded' | 'irrelevant' | 'over_budget';

export interface ExcludedContextCandidate extends ContextBudgetCandidate {
  exclusionReason: ContextExclusionReason;
}

export interface TokenBudgetRequest {
  mode: TokenOptimizationMode;
  modelContextLimit: number;
  requestedOutputTokens: number;
  fixedInputTokens: number;
  candidates: readonly ContextBudgetCandidate[];
}

export interface TokenBudgetPlan {
  mode: TokenOptimizationMode;
  optimizationApplied: boolean;
  outputTokenLimit: number;
  inputTokenBudget: number;
  selected: readonly ContextBudgetCandidate[];
  excluded: readonly ExcludedContextCandidate[];
  estimatedInputTokensBefore: number;
  estimatedInputTokensAfter: number;
  estimatedTokensSaved: number;
  fitsContext: boolean;
  overflowTokens: number;
}

export interface TokenOptimizationModePolicy {
  readonly mode: TokenOptimizationMode;
  readonly outputTokenCeiling: number | null;
  readonly relevanceFloor: number;
  readonly reasoning:
    | 'unchanged'
    | 'lower_when_supported'
    | 'provider_default'
    | 'highest_appropriate';
  readonly allowModelSwitch: false;
}

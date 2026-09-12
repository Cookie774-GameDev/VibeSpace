export type ContextExecutionMode = 'direct' | 'retrieval' | 'rlm';

export interface ContextModeSignals {
  question: string;
  estimatedCorpusTokens: number;
  modelWindowTokens: number;
  sourceFamilyCount: number;
  ambiguity: number;
  activeWorkingSetSufficient?: boolean;
  smallBoundedTask?: boolean;
  exactIdentifierLookup?: boolean;
  historicalLookup?: boolean;
  explicitRlm?: boolean;
  explicitInfiniteContextTest?: boolean;
  crossSessionSynthesis?: boolean;
  entireProjectHistory?: boolean;
  largeExternalCorpus?: boolean;
  firstStageRetrievalConfidence?: number;
  rlmAvailable?: boolean;
}

export interface ContextModeDecision {
  mode: ContextExecutionMode;
  reasons: string[];
  recursiveChildCallsAllowed: boolean;
  broadContextScanAllowed: boolean;
  trace: Readonly<{
    mode: ContextExecutionMode;
    reasons: readonly string[];
    estimatedCorpusTokens: number;
    modelWindowTokens: number;
    corpusToWindowRatio: number;
    sourceFamilyCount: number;
    ambiguity: number;
    firstStageRetrievalConfidence?: number;
  }>;
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function routeDefaultContextQuery(
  question: string,
  extra: Partial<ContextModeSignals> = {},
): ContextModeDecision {
  const trimmed = question.trim();
  const looksLikeOrdinaryChat =
    trimmed.length > 0 &&
    trimmed.length <= 240 &&
    !/\b(?:search|investigate|corpus|entire project|infinite context|rlm)\b/iu.test(trimmed);
  return decideContextMode({
    estimatedCorpusTokens: extra.estimatedCorpusTokens ?? 0,
    modelWindowTokens: extra.modelWindowTokens ?? 128_000,
    sourceFamilyCount: extra.sourceFamilyCount ?? 0,
    ambiguity: extra.ambiguity ?? 0,
    rlmAvailable: extra.rlmAvailable ?? true,
    smallBoundedTask: extra.smallBoundedTask ?? looksLikeOrdinaryChat,
    entireProjectHistory:
      extra.entireProjectHistory ?? /\bentire project history\b/iu.test(trimmed),
    explicitRlm: extra.explicitRlm ?? /\brlm\b/iu.test(trimmed),
    ...extra,
    question: extra.question ?? trimmed,
  });
}

export function decideContextMode(input: ContextModeSignals): ContextModeDecision {
  const estimatedCorpusTokens = finiteNonNegative(input.estimatedCorpusTokens);
  const modelWindowTokens = Math.max(1, finiteNonNegative(input.modelWindowTokens, 1));
  const sourceFamilyCount = Math.floor(finiteNonNegative(input.sourceFamilyCount));
  const ambiguity = Math.min(1, finiteNonNegative(input.ambiguity));
  const corpusToWindowRatio = estimatedCorpusTokens / modelWindowTokens;
  const reasons: string[] = [];

  if (input.explicitRlm) reasons.push('explicit_rlm_request');
  if (input.explicitInfiniteContextTest) reasons.push('explicit_infinite_context_test');
  if (corpusToWindowRatio >= 2) reasons.push('corpus_exceeds_model_window');
  if (input.crossSessionSynthesis && sourceFamilyCount >= 3) {
    reasons.push('cross_session_multi_source_synthesis');
  }
  if (input.entireProjectHistory) reasons.push('entire_project_history');
  if (input.largeExternalCorpus) reasons.push('large_external_corpus');
  if (
    input.historicalLookup &&
    input.firstStageRetrievalConfidence !== undefined &&
    input.firstStageRetrievalConfidence < 0.45
  ) {
    reasons.push('retrieval_confidence_insufficient');
  }
  if (ambiguity >= 0.75 && sourceFamilyCount >= 3) reasons.push('high_multi_source_ambiguity');

  let mode: ContextExecutionMode;
  if (reasons.length > 0 && input.rlmAvailable === false) {
    mode = 'retrieval';
    reasons.push('rlm_unavailable_fallback');
  } else if (reasons.length > 0) {
    mode = 'rlm';
  } else if (input.smallBoundedTask) {
    mode = 'direct';
    if (input.activeWorkingSetSufficient) reasons.push('active_working_set_sufficient');
    reasons.push('small_bounded_task');
  } else {
    mode = 'retrieval';
    if (input.exactIdentifierLookup && input.historicalLookup) {
      reasons.push('exact_historical_lookup');
    } else if (input.historicalLookup) {
      reasons.push('bounded_historical_lookup');
    } else {
      reasons.push('bounded_retrieval_default');
    }
  }

  const trace = Object.freeze({
    mode,
    reasons: Object.freeze([...reasons]),
    estimatedCorpusTokens,
    modelWindowTokens,
    corpusToWindowRatio,
    sourceFamilyCount,
    ambiguity,
    ...(input.firstStageRetrievalConfidence === undefined
      ? {}
      : { firstStageRetrievalConfidence: input.firstStageRetrievalConfidence }),
  });
  return Object.freeze({
    mode,
    reasons,
    recursiveChildCallsAllowed: mode === 'rlm',
    broadContextScanAllowed: mode === 'rlm',
    trace,
  });
}

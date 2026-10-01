import type { PerformanceProfile } from '../../chat/runtime/performanceProfile';
import { performancePolicy } from '../../chat/runtime/performanceProfile';
import type { RlmRoute } from '../../chat/runtime/rlmPreference';

export interface ContextRouteInput {
  rlmEnabled: boolean;
  requestedRoute?: 'auto' | RlmRoute;
  question: string;
  activeFileTask: boolean;
  answerPresentInCurrentTurn: boolean;
  estimatedScopeBytes: number;
  sourceFamilies: readonly string[];
  retrievalConfidence?: number;
  modelContextWindowTokens?: number;
  explicitHistoricalLookup?: boolean;
  explicitWholeProjectRequest?: boolean;
  performanceProfile: PerformanceProfile;
}

export interface RlmBudget {
  maxDepth: number;
  maxSubcalls: number;
  maxConcurrentSubcalls: number;
  maxToolCalls: number;
  maxOpenBytes: number;
  maxTotalEvidenceBytes: number;
  maxWallTimeMs: number;
}

export interface ContextRouteDecision {
  route: RlmRoute;
  reasons: readonly string[];
  estimatedScopeBytes: number;
  sourceFamilies: readonly string[];
  confidence?: number;
  budget: RlmBudget;
}

function budgetFor(profile: PerformanceProfile, route: RlmRoute): RlmBudget {
  const policy = performancePolicy(profile);
  return {
    maxDepth: route === 'rlm' ? 1 : 0,
    maxSubcalls: route === 'rlm' ? policy.maxSubcalls : 0,
    maxConcurrentSubcalls: route === 'rlm' ? policy.maxConcurrentChildren : 0,
    maxToolCalls: route === 'direct' ? 0 : route === 'retrieval' ? 8 : 24,
    maxOpenBytes: route === 'direct'
      ? 0
      : Math.min(policy.maxEvidenceBytes, route === 'retrieval' ? 64 * 1024 : 128 * 1024),
    maxTotalEvidenceBytes: route === 'direct' ? 0 : policy.maxEvidenceBytes,
    maxWallTimeMs: route === 'direct' ? 30_000 : route === 'retrieval' ? 90_000 : 300_000,
  };
}

function containsBroadHistoricalLanguage(question: string): boolean {
  return /\b(entire|whole|all|archive|history|across|root cause|everything|every file|every chat)\b/iu.test(question);
}

function containsLookupLanguage(question: string): boolean {
  return /\b(find|look up|check|where|when|which file|what was|previous|old|decision|revision|source)\b/iu.test(question);
}

function routeThresholds(profile: PerformanceProfile): {
  confidence: number;
  sourceFamilies: number;
  nativeWindowMultiplier: number;
} {
  switch (profile) {
    case 'responsive': return { confidence: 0.35, sourceFamilies: 4, nativeWindowMultiplier: 8 };
    case 'balanced': return { confidence: 0.5, sourceFamilies: 3, nativeWindowMultiplier: 4 };
    case 'quality': return { confidence: 0.65, sourceFamilies: 2, nativeWindowMultiplier: 2 };
  }
}

/** RLM is default-eligible, not default-recursive. Simple turns remain Direct. */
export function decideContextRoute(input: ContextRouteInput): ContextRouteDecision {
  const sourceFamilies = [...new Set(input.sourceFamilies.map((item) => item.trim()).filter(Boolean))];
  const requested = input.requestedRoute ?? 'auto';
  const reasons: string[] = [];

  let route: RlmRoute;
  if (!input.rlmEnabled) {
    route = 'direct';
    reasons.push('rlm-disabled');
  } else if (requested !== 'auto') {
    route = requested;
    reasons.push(`explicit-${requested}`);
  } else if (input.answerPresentInCurrentTurn) {
    route = 'direct';
    reasons.push('answer-in-current-turn');
  } else if (input.activeFileTask && !input.explicitHistoricalLookup && sourceFamilies.length <= 1) {
    route = 'direct';
    reasons.push('small-active-working-set');
  } else {
    const thresholds = routeThresholds(input.performanceProfile);
    const broad = input.explicitWholeProjectRequest || containsBroadHistoricalLanguage(input.question);
    const lookup = input.explicitHistoricalLookup || containsLookupLanguage(input.question);
    const lowConfidence = typeof input.retrievalConfidence === 'number'
      && input.retrievalConfidence < thresholds.confidence;
    const approximateNativeBytes = Math.max(1, input.modelContextWindowTokens ?? 128_000) * 4;
    const farBeyondWindow = input.estimatedScopeBytes
      > approximateNativeBytes * thresholds.nativeWindowMultiplier;
    const crossSource = sourceFamilies.length >= thresholds.sourceFamilies;

    if (broad || lowConfidence || (farBeyondWindow && crossSource)) {
      route = 'rlm';
      if (broad) reasons.push('broad-history-request');
      if (lowConfidence) reasons.push('retrieval-confidence-low');
      if (farBeyondWindow) reasons.push('scope-far-beyond-model-window');
      if (crossSource) reasons.push('multiple-source-families');
    } else if (lookup || input.estimatedScopeBytes > 0 || sourceFamilies.length > 0) {
      route = 'retrieval';
      reasons.push(lookup ? 'bounded-historical-lookup' : 'bounded-context-available');
    } else {
      route = 'direct';
      reasons.push('no-context-lookup-needed');
    }
  }

  return {
    route,
    reasons,
    estimatedScopeBytes: Math.max(0, input.estimatedScopeBytes),
    sourceFamilies,
    ...(typeof input.retrievalConfidence === 'number' ? { confidence: input.retrievalConfidence } : {}),
    budget: budgetFor(input.performanceProfile, route),
  };
}

/** Compatibility adapter for the existing PR-31 RLM coordinator contract. */
export interface RlmRouteSignals {
  enabled: boolean;
  requestedRoute?: 'auto' | RlmRoute;
  question?: string;
  activeFileOnly?: boolean;
  answerPresentInCurrentTurn?: boolean;
  historicalLookup?: boolean;
  userRequestsWholeProject?: boolean;
  crossSourceSynthesis?: boolean;
  estimatedCorpusTokens?: number;
  estimatedScopeBytes?: number;
  modelContextTokens?: number;
  sourceFamilies?: readonly string[];
  retrievalConfidence?: number;
  performanceProfile?: PerformanceProfile;
}

export function decideRlmRoute(signals: Readonly<RlmRouteSignals>): ContextRouteDecision {
  const sourceFamilies = signals.sourceFamilies
    ?? (signals.crossSourceSynthesis ? ['file', 'chat'] : []);
  return decideContextRoute({
    rlmEnabled: signals.enabled,
    requestedRoute: signals.requestedRoute,
    question: signals.question
      ?? (signals.userRequestsWholeProject
        ? 'Check the entire project history across all sources.'
        : signals.historicalLookup
          ? 'What was the previous decision?'
          : 'Complete the current task.'),
    activeFileTask: signals.activeFileOnly ?? false,
    answerPresentInCurrentTurn: signals.answerPresentInCurrentTurn ?? false,
    estimatedScopeBytes: signals.estimatedScopeBytes
      ?? Math.max(0, signals.estimatedCorpusTokens ?? 0) * 4,
    sourceFamilies,
    retrievalConfidence: signals.retrievalConfidence,
    modelContextWindowTokens: signals.modelContextTokens,
    explicitHistoricalLookup: signals.historicalLookup,
    explicitWholeProjectRequest: signals.userRequestsWholeProject,
    performanceProfile: signals.performanceProfile ?? 'quality',
  });
}

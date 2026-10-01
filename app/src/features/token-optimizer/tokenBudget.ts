import type {
  ContextBudgetCandidate,
  ContextExclusionReason,
  ExcludedContextCandidate,
  TokenBudgetPlan,
  TokenBudgetRequest,
  TokenOptimizationMode,
  TokenOptimizationModePolicy,
} from './contracts';
import { isProtectedContext } from './protectedContent';

const MODE_POLICIES: Readonly<
  Record<TokenOptimizationMode, Readonly<TokenOptimizationModePolicy>>
> = Object.freeze({
  off: Object.freeze({
    mode: 'off',
    outputTokenCeiling: null,
    relevanceFloor: 0,
    reasoning: 'unchanged',
    allowModelSwitch: false,
  }),
  saver: Object.freeze({
    mode: 'saver',
    outputTokenCeiling: 512,
    relevanceFloor: 0.2,
    reasoning: 'lower_when_supported',
    allowModelSwitch: false,
  }),
  normal: Object.freeze({
    mode: 'normal',
    outputTokenCeiling: 2_000,
    relevanceFloor: 0.1,
    reasoning: 'provider_default',
    allowModelSwitch: false,
  }),
  final_boss: Object.freeze({
    mode: 'final_boss',
    outputTokenCeiling: 8_192,
    relevanceFloor: 0.05,
    reasoning: 'highest_appropriate',
    allowModelSwitch: false,
  }),
});

export function optimizationModePolicy(
  mode: TokenOptimizationMode,
): Readonly<TokenOptimizationModePolicy> {
  return MODE_POLICIES[mode];
}

function assertRequest(request: TokenBudgetRequest): void {
  for (const [label, value] of [
    ['model context limit', request.modelContextLimit],
    ['requested output tokens', request.requestedOutputTokens],
    ['fixed input tokens', request.fixedInputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${label}.`);
    }
  }
  const candidateIds = new Set<string>();
  for (const candidate of request.candidates) {
    if (
      !candidate.id ||
      !Number.isSafeInteger(candidate.estimatedTokens) ||
      candidate.estimatedTokens < 0 ||
      !Number.isFinite(candidate.relevance) ||
      candidate.relevance < 0 ||
      candidate.relevance > 1
    ) {
      throw new Error(`Invalid context candidate ${candidate.id || '<missing-id>'}.`);
    }
    if (candidateIds.has(candidate.id)) {
      throw new Error(`Duplicate candidate id ${candidate.id}.`);
    }
    candidateIds.add(candidate.id);
  }

  const references = new Map<string, string>();
  for (const candidate of request.candidates) {
    for (const [label, target] of [
      ['duplicate', candidate.duplicateOf],
      ['superseded', candidate.supersededBy],
    ] as const) {
      if (target === undefined) continue;
      if (!target || target === candidate.id || !candidateIds.has(target)) {
        throw new Error(`Invalid ${label} reference for ${candidate.id}.`);
      }
      if (references.has(candidate.id)) {
        throw new Error(`Context candidate ${candidate.id} has conflicting references.`);
      }
      references.set(candidate.id, target);
    }
  }

  for (const start of references.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (visited.has(current)) {
        throw new Error(`Cyclic context reference involving ${start}.`);
      }
      visited.add(current);
      current = references.get(current);
    }
  }
}

function checkedTokenAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new Error('Token total exceeds safe integer range.');
  }
  return total;
}

function sumCandidateTokens(
  initial: number,
  candidates: readonly Pick<ContextBudgetCandidate, 'estimatedTokens'>[],
): number {
  return candidates.reduce(
    (total, candidate) => checkedTokenAdd(total, candidate.estimatedTokens),
    initial,
  );
}

function exclude(
  candidate: ContextBudgetCandidate,
  exclusionReason: ContextExclusionReason,
): ExcludedContextCandidate {
  return { ...candidate, exclusionReason };
}

export function buildTokenBudgetPlan(request: TokenBudgetRequest): TokenBudgetPlan {
  assertRequest(request);
  const policy = optimizationModePolicy(request.mode);
  const estimatedInputTokensBefore = sumCandidateTokens(
    request.fixedInputTokens,
    request.candidates,
  );

  if (request.mode === 'off') {
    const overflowTokens = Math.max(
      0,
      checkedTokenAdd(estimatedInputTokensBefore, request.requestedOutputTokens) -
        request.modelContextLimit,
    );
    return {
      mode: request.mode,
      optimizationApplied: false,
      outputTokenLimit: request.requestedOutputTokens,
      inputTokenBudget: Math.max(0, request.modelContextLimit - request.requestedOutputTokens),
      selected: [...request.candidates],
      excluded: [],
      estimatedInputTokensBefore,
      estimatedInputTokensAfter: estimatedInputTokensBefore,
      estimatedTokensSaved: 0,
      fitsContext: overflowTokens === 0,
      overflowTokens,
    };
  }

  const desiredOutputTokenLimit = Math.min(
    request.requestedOutputTokens,
    policy.outputTokenCeiling ?? request.requestedOutputTokens,
  );
  const protectedCandidates = request.candidates.filter(
    (candidate) => candidate.protected || isProtectedContext(candidate.kind),
  );
  const protectedInputTokens = sumCandidateTokens(request.fixedInputTokens, protectedCandidates);
  const outputTokenLimit = Math.min(
    desiredOutputTokenLimit,
    Math.max(0, request.modelContextLimit - protectedInputTokens),
  );
  const inputTokenBudget = Math.max(0, request.modelContextLimit - outputTokenLimit);
  const selectedIds = new Set(protectedCandidates.map(({ id }) => id));
  const excluded: ExcludedContextCandidate[] = [];
  let selectedTokens = protectedInputTokens;

  const optionalCandidates = request.candidates
    .filter((candidate) => !protectedCandidates.includes(candidate))
    .sort((left, right) => {
      const relevance = right.relevance - left.relevance;
      if (relevance !== 0) return relevance;
      const tokenCost = left.estimatedTokens - right.estimatedTokens;
      if (tokenCost !== 0) return tokenCost;
      return left.id.localeCompare(right.id);
    });

  for (const candidate of optionalCandidates) {
    if (candidate.duplicateOf) {
      excluded.push(exclude(candidate, 'duplicate'));
      continue;
    }
    if (candidate.supersededBy) {
      excluded.push(exclude(candidate, 'superseded'));
      continue;
    }
    if (candidate.relevance < policy.relevanceFloor) {
      excluded.push(exclude(candidate, 'irrelevant'));
      continue;
    }
    const nextSelectedTokens = checkedTokenAdd(selectedTokens, candidate.estimatedTokens);
    if (nextSelectedTokens > inputTokenBudget) {
      excluded.push(exclude(candidate, 'over_budget'));
      continue;
    }
    selectedIds.add(candidate.id);
    selectedTokens = nextSelectedTokens;
  }

  const selected = request.candidates.filter((candidate) => selectedIds.has(candidate.id));
  const estimatedTokensSaved = sumCandidateTokens(0, excluded);
  const overflowTokens = Math.max(0, protectedInputTokens - request.modelContextLimit);
  return {
    mode: request.mode,
    optimizationApplied: excluded.length > 0 || outputTokenLimit !== request.requestedOutputTokens,
    outputTokenLimit,
    inputTokenBudget,
    selected,
    excluded,
    estimatedInputTokensBefore,
    estimatedInputTokensAfter: estimatedInputTokensBefore - estimatedTokensSaved,
    estimatedTokensSaved,
    fitsContext: overflowTokens === 0,
    overflowTokens,
  };
}

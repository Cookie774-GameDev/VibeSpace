import { describe, expect, it } from 'vitest';
import { decideContextRoute } from './routeDecision';

const base = {
  rlmEnabled: true,
  question: 'Do the task.',
  activeFileTask: false,
  answerPresentInCurrentTurn: false,
  estimatedScopeBytes: 0,
  sourceFamilies: [] as string[],
  performanceProfile: 'quality' as const,
};

describe('adaptive context route', () => {
  it('keeps simple current-turn and active-file work direct', () => {
    expect(decideContextRoute({ ...base, answerPresentInCurrentTurn: true }).route).toBe('direct');
    expect(decideContextRoute({ ...base, activeFileTask: true, sourceFamilies: ['file'] }).route).toBe('direct');
  });

  it('uses bounded retrieval for ordinary historical lookup', () => {
    expect(decideContextRoute({
      ...base,
      question: 'What was the previous decision?',
      explicitHistoricalLookup: true,
      estimatedScopeBytes: 10_000,
      sourceFamilies: ['chat'],
    }).route).toBe('retrieval');
  });

  it('uses real RLM for a 30M-token cross-source investigation', () => {
    const decision = decideContextRoute({
      ...base,
      question: 'Check the entire project archive and explain the root cause across all sources.',
      explicitWholeProjectRequest: true,
      estimatedScopeBytes: 159_141_294,
      modelContextWindowTokens: 1_000_000,
      sourceFamilies: ['file', 'chat', 'terminal'],
    });
    expect(decision.route).toBe('rlm');
    expect(decision.budget.maxDepth).toBe(1);
    expect(decision.budget.maxConcurrentSubcalls).toBe(2);
  });

  it('never performs background retrieval when RLM is off', () => {
    expect(decideContextRoute({
      ...base,
      rlmEnabled: false,
      requestedRoute: 'rlm',
      estimatedScopeBytes: 999_999_999,
      sourceFamilies: ['file', 'chat', 'terminal'],
    })).toMatchObject({ route: 'direct', reasons: ['rlm-disabled'] });
  });

  it('uses a stricter escalation threshold in responsive profile', () => {
    const quality = decideContextRoute({
      ...base,
      retrievalConfidence: 0.5,
      sourceFamilies: ['file', 'chat'],
    });
    const responsive = decideContextRoute({
      ...base,
      performanceProfile: 'responsive',
      retrievalConfidence: 0.5,
      sourceFamilies: ['file', 'chat'],
    });
    expect(quality.route).toBe('rlm');
    expect(responsive.route).toBe('retrieval');
  });
});

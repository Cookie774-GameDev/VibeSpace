import { describe, expect, it } from 'vitest';
import { decideContextMode, routeDefaultContextQuery } from './adaptiveContextRouter';

describe('adaptive direct/retrieval/RLM router', () => {
  it('keeps default-on RLM lazy so an ordinary short chat is Direct, not recursive search', () => {
    const decision = routeDefaultContextQuery('Hi Jarvis, what time is it?');
    expect(decision.mode).toBe('direct');
    expect(decision.recursiveChildCallsAllowed).toBe(false);
    expect(decision.reasons).toContain('small_bounded_task');
  });

  it('escalates default query to RLM only when investigation signals are present', () => {
    const decision = routeDefaultContextQuery('Investigate the entire project history for the leak', {
      entireProjectHistory: true,
      estimatedCorpusTokens: 4_000_000,
    });
    expect(decision.mode).toBe('rlm');
    expect(decision.recursiveChildCallsAllowed).toBe(true);
  });

  it('chooses direct mode for a short greeting with no corpus work', () => {
    expect(
      decideContextMode({
        question: 'Hi there, GPT-5.3 Spark',
        estimatedCorpusTokens: 0,
        modelWindowTokens: 128_000,
        smallBoundedTask: true,
        sourceFamilyCount: 0,
        ambiguity: 0,
      }),
    ).toMatchObject({
      mode: 'direct',
      recursiveChildCallsAllowed: false,
      broadContextScanAllowed: false,
      reasons: ['small_bounded_task'],
    });
  });

  it('chooses direct mode for a small active working-set edit', () => {
    expect(
      decideContextMode({
        question: 'Rename the current button label',
        estimatedCorpusTokens: 2_000,
        modelWindowTokens: 128_000,
        activeWorkingSetSufficient: true,
        smallBoundedTask: true,
        sourceFamilyCount: 1,
        ambiguity: 0.05,
      }),
    ).toMatchObject({
      mode: 'direct',
      recursiveChildCallsAllowed: false,
      broadContextScanAllowed: false,
    });
  });

  it('chooses retrieval for an exact historical identifier lookup', () => {
    const decision = decideContextMode({
      question: 'What commit introduced request jreq_83b?',
      estimatedCorpusTokens: 80_000,
      modelWindowTokens: 128_000,
      exactIdentifierLookup: true,
      historicalLookup: true,
      sourceFamilyCount: 2,
      ambiguity: 0.1,
    });
    expect(decision.mode).toBe('retrieval');
    expect(decision.reasons).toContain('exact_historical_lookup');
    expect(decision.recursiveChildCallsAllowed).toBe(false);
  });

  it.each([
    { explicitRlm: true },
    { explicitInfiniteContextTest: true },
    { estimatedCorpusTokens: 10_000_000, modelWindowTokens: 128_000 },
    { crossSessionSynthesis: true, sourceFamilyCount: 5 },
    { entireProjectHistory: true },
    { largeExternalCorpus: true },
    { firstStageRetrievalConfidence: 0.2, historicalLookup: true },
    { ambiguity: 0.9, sourceFamilyCount: 6 },
  ])('chooses visible RLM investigation mode for measurable signal %o', (signal) => {
    const decision = decideContextMode({
      question: 'Investigate the evidence',
      estimatedCorpusTokens: 100_000,
      modelWindowTokens: 128_000,
      sourceFamilyCount: 1,
      ambiguity: 0.1,
      ...signal,
    });
    expect(decision.mode).toBe('rlm');
    expect(decision.trace.mode).toBe('rlm');
    expect(decision.recursiveChildCallsAllowed).toBe(true);
  });

  it('does not let a direct-mode hint override an explicit RLM acceptance test', () => {
    expect(
      decideContextMode({
        question: 'Run the exact-recall test',
        estimatedCorpusTokens: 100,
        modelWindowTokens: 128_000,
        activeWorkingSetSufficient: true,
        smallBoundedTask: true,
        explicitRlm: true,
        sourceFamilyCount: 1,
        ambiguity: 0,
      }).mode,
    ).toBe('rlm');
  });

  it('falls back to bounded retrieval when recursive runtime is unavailable', () => {
    expect(
      decideContextMode({
        question: 'Search everything',
        estimatedCorpusTokens: 10_000_000,
        modelWindowTokens: 128_000,
        sourceFamilyCount: 8,
        ambiguity: 0.9,
        rlmAvailable: false,
      }),
    ).toMatchObject({
      mode: 'retrieval',
      recursiveChildCallsAllowed: false,
      reasons: expect.arrayContaining(['rlm_unavailable_fallback']),
    });
  });
});

import type { CorpusScaleMetadata } from './corpusScale';
import { createCorpusScaleMetadata } from './corpusScale';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_QUERY_CHARS = 4_096;
const MAX_EVIDENCE_CHARS = 32_768;

export const RECURSIVE_CONTEXT_LIMITS = Object.freeze({
  maxIterations: 16,
  maxContextTokens: 32_768,
  maxItems: 256,
  maxQueriesPerIteration: 8,
  maxTotalQueries: 64,
});

export interface RecursiveContextBudgets {
  maxIterations: number;
  maxContextTokens: number;
  maxItems: number;
  maxQueriesPerIteration: number;
  maxTotalQueries: number;
}

export interface RecursiveContextEvidenceProvenance {
  sourceId: string;
  sourceRevision: string;
  contentDigest: `sha256:${string}`;
  indexedAt: number;
  locator?: string;
}

export interface RecursiveContextEvidence {
  id: string;
  exactExcerpt: string;
  estimatedTokens: number;
  provenance: RecursiveContextEvidenceProvenance;
}

export interface RecursiveContextRoundRequest {
  queries: readonly string[];
  excludedEvidenceIds: readonly string[];
  iteration: number;
  maxTokens: number;
  maxItems: number;
  signal?: AbortSignal;
}

export interface RecursiveContextRoundResult {
  evidence: readonly RecursiveContextEvidence[];
  nextQueries: readonly string[];
  complete: boolean;
}

export interface RecursiveContextRequest {
  query: string;
  corpus: Readonly<CorpusScaleMetadata>;
  budgets: Readonly<RecursiveContextBudgets>;
  signal?: AbortSignal;
}

export interface RecursiveContextDependencies {
  retrieveRound(request: RecursiveContextRoundRequest): Promise<RecursiveContextRoundResult>;
}

export type RecursiveContextStopReason =
  | 'complete'
  | 'cancelled'
  | 'context_budget_exhausted'
  | 'item_budget_exhausted'
  | 'iteration_limit'
  | 'query_budget_exhausted'
  | 'query_loop'
  | 'retrieval_exhausted';

export interface RecursiveContextResult {
  status: 'complete' | 'incomplete';
  stopReason: RecursiveContextStopReason;
  iterations: number;
  queriesIssued: number;
  contextTokens: number;
  fullyIndexed: boolean;
  corpus: Readonly<CorpusScaleMetadata>;
  evidence: readonly RecursiveContextEvidence[];
}

export class RecursiveContextError extends Error {
  constructor(readonly detail: string) {
    super(`recursive_context_error:${detail}`);
    this.name = 'RecursiveContextError';
  }
}

function boundedInteger(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function safeText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function validateBudgets(budgets: Readonly<RecursiveContextBudgets>): void {
  for (const [value, maximum, detail] of [
    [budgets.maxIterations, RECURSIVE_CONTEXT_LIMITS.maxIterations, 'max_iterations'],
    [budgets.maxContextTokens, RECURSIVE_CONTEXT_LIMITS.maxContextTokens, 'max_context_tokens'],
    [budgets.maxItems, RECURSIVE_CONTEXT_LIMITS.maxItems, 'max_items'],
    [
      budgets.maxQueriesPerIteration,
      RECURSIVE_CONTEXT_LIMITS.maxQueriesPerIteration,
      'max_queries_per_iteration',
    ],
    [budgets.maxTotalQueries, RECURSIVE_CONTEXT_LIMITS.maxTotalQueries, 'max_total_queries'],
  ] as const) {
    if (!boundedInteger(value, 1, maximum)) throw new RecursiveContextError(detail);
  }
  if (budgets.maxQueriesPerIteration > budgets.maxTotalQueries) {
    throw new RecursiveContextError('query_budgets');
  }
}

function validateEvidence(evidence: RecursiveContextEvidence): void {
  if (
    !SAFE_ID.test(evidence.id) ||
    !safeText(evidence.exactExcerpt, MAX_EVIDENCE_CHARS) ||
    !boundedInteger(evidence.estimatedTokens, 1, RECURSIVE_CONTEXT_LIMITS.maxContextTokens) ||
    !SAFE_ID.test(evidence.provenance.sourceId) ||
    !safeText(evidence.provenance.sourceRevision, 512) ||
    !SHA256_DIGEST.test(evidence.provenance.contentDigest) ||
    !boundedInteger(evidence.provenance.indexedAt, 0, 8_640_000_000_000_000) ||
    (evidence.provenance.locator !== undefined && !safeText(evidence.provenance.locator, 4_096))
  ) {
    throw new RecursiveContextError('invalid_evidence');
  }
}

function abortError(): DOMException {
  return new DOMException('Recursive context retrieval was aborted.', 'AbortError');
}

async function awaitRound(
  promise: Promise<RecursiveContextRoundResult>,
  signal: AbortSignal | undefined,
): Promise<RecursiveContextRoundResult> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<RecursiveContextRoundResult>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function stop(
  reason: Exclude<RecursiveContextStopReason, 'cancelled'>,
  state: {
    iterations: number;
    queriesIssued: number;
    contextTokens: number;
    corpus: Readonly<CorpusScaleMetadata>;
    evidence: readonly RecursiveContextEvidence[];
  },
): Readonly<RecursiveContextResult> {
  return Object.freeze({
    status: reason === 'complete' ? 'complete' : 'incomplete',
    stopReason: reason,
    iterations: state.iterations,
    queriesIssued: state.queriesIssued,
    contextTokens: state.contextTokens,
    fullyIndexed: state.corpus.indexedTokens === state.corpus.totalTokens,
    corpus: state.corpus,
    evidence: Object.freeze([...state.evidence]),
  });
}

export function createRecursiveContextPlanner(dependencies: RecursiveContextDependencies) {
  return Object.freeze({
    async retrieve(request: RecursiveContextRequest): Promise<Readonly<RecursiveContextResult>> {
      if (!safeText(request.query, MAX_QUERY_CHARS)) throw new RecursiveContextError('query');
      validateBudgets(request.budgets);
      const corpus = createCorpusScaleMetadata(request.corpus);
      if (request.signal?.aborted) throw abortError();

      const evidence: RecursiveContextEvidence[] = [];
      const evidenceIds = new Set<string>();
      const seenQueries = new Set<string>();
      let pendingQueries = [request.query.trim()];
      let contextTokens = 0;
      let queriesIssued = 0;

      for (let iteration = 1; iteration <= request.budgets.maxIterations; iteration += 1) {
        if (request.signal?.aborted) throw abortError();
        const freshQueries: string[] = [];
        for (const query of pendingQueries) {
          if (!safeText(query, MAX_QUERY_CHARS)) {
            throw new RecursiveContextError('invalid_dependency_query');
          }
          const normalized = normalizeQuery(query);
          if (seenQueries.has(normalized)) continue;
          seenQueries.add(normalized);
          freshQueries.push(query.trim());
        }
        if (freshQueries.length === 0) {
          return stop('query_loop', {
            iterations: iteration - 1,
            queriesIssued,
            contextTokens,
            corpus,
            evidence,
          });
        }
        if (freshQueries.length > request.budgets.maxQueriesPerIteration) {
          throw new RecursiveContextError('too_many_dependency_queries');
        }
        if (queriesIssued + freshQueries.length > request.budgets.maxTotalQueries) {
          return stop('query_budget_exhausted', {
            iterations: iteration - 1,
            queriesIssued,
            contextTokens,
            corpus,
            evidence,
          });
        }
        const remainingTokens = request.budgets.maxContextTokens - contextTokens;
        const remainingItems = request.budgets.maxItems - evidence.length;
        if (remainingTokens <= 0) {
          return stop('context_budget_exhausted', {
            iterations: iteration - 1,
            queriesIssued,
            contextTokens,
            corpus,
            evidence,
          });
        }
        if (remainingItems <= 0) {
          return stop('item_budget_exhausted', {
            iterations: iteration - 1,
            queriesIssued,
            contextTokens,
            corpus,
            evidence,
          });
        }

        queriesIssued += freshQueries.length;
        const round = await awaitRound(
          dependencies.retrieveRound({
            queries: Object.freeze(freshQueries),
            excludedEvidenceIds: Object.freeze([...evidenceIds]),
            iteration,
            maxTokens: remainingTokens,
            maxItems: remainingItems,
            ...(request.signal ? { signal: request.signal } : {}),
          }),
          request.signal,
        );
        if (request.signal?.aborted) throw abortError();
        if (!round || typeof round !== 'object' || typeof round.complete !== 'boolean') {
          throw new RecursiveContextError('invalid_dependency_result');
        }
        if (!Array.isArray(round.evidence) || round.evidence.length > remainingItems) {
          throw new RecursiveContextError('invalid_dependency_evidence_count');
        }
        if (
          !Array.isArray(round.nextQueries) ||
          round.nextQueries.length > request.budgets.maxQueriesPerIteration
        ) {
          throw new RecursiveContextError('invalid_dependency_query_count');
        }

        let roundTokens = 0;
        for (const item of round.evidence) {
          validateEvidence(item);
          if (evidenceIds.has(item.id)) throw new RecursiveContextError('duplicate_evidence');
          roundTokens += item.estimatedTokens;
          if (roundTokens > remainingTokens) {
            throw new RecursiveContextError('dependency_exceeded_context_budget');
          }
          evidenceIds.add(item.id);
          evidence.push(
            Object.freeze({ ...item, provenance: Object.freeze({ ...item.provenance }) }),
          );
        }
        contextTokens += roundTokens;
        if (round.complete) {
          if (evidence.length === 0) throw new RecursiveContextError('complete_without_evidence');
          return stop('complete', {
            iterations: iteration,
            queriesIssued,
            contextTokens,
            corpus,
            evidence,
          });
        }
        if (round.nextQueries.length === 0) {
          return stop('retrieval_exhausted', {
            iterations: iteration,
            queriesIssued,
            contextTokens,
            corpus,
            evidence,
          });
        }
        pendingQueries = [...round.nextQueries];
      }

      return stop('iteration_limit', {
        iterations: request.budgets.maxIterations,
        queriesIssued,
        contextTokens,
        corpus,
        evidence,
      });
    },
  });
}

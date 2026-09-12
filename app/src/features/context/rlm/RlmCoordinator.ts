import { performancePolicy, type PerformanceProfile } from '@/features/chat/runtime/performanceProfile';
import type { ContextPointer, ContextScope } from './pointerAuthority';
import { decideRlmRoute, type RlmRouteSignals } from './routeDecision';

export interface ContextSearchHit {
  pointer: ContextPointer;
  preview: string;
  score?: number;
}

export interface EvidenceSpan {
  pointer: ContextPointer;
  text: string;
  truncated: boolean;
}

export interface ContextQueryService {
  search(input: {
    question: string;
    scope: ContextScope;
    limit: number;
    signal?: AbortSignal;
  }): Promise<readonly ContextSearchHit[]>;
  open(input: {
    pointer: ContextPointer;
    scope: ContextScope;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<EvidenceSpan>;
}

export interface RlmWorkerResult {
  evidence: readonly EvidenceSpan[];
  unresolved: readonly string[];
  childCalls: number;
  maxDepth: number;
}

export interface RlmInvestigationWorker {
  investigate(input: {
    question: string;
    scope: ContextScope;
    maxSubcalls: number;
    maxConcurrentSubcalls: number;
    maxEvidenceBytes: number;
    signal?: AbortSignal;
  }): Promise<RlmWorkerResult>;
}

export interface RlmTraceEvent {
  type: 'route' | 'search' | 'open' | 'worker' | 'cancelled' | 'complete';
  detail: Readonly<Record<string, unknown>>;
}

export interface RlmTraceSink {
  record(event: RlmTraceEvent): void;
}

export interface ContextQueryInput {
  question: string;
  scope: ContextScope;
  signals: RlmRouteSignals;
  performance: PerformanceProfile;
  signal?: AbortSignal;
}

export interface ContextQueryResult {
  route: 'direct' | 'retrieval' | 'rlm';
  answerSupport: readonly EvidenceSpan[];
  unresolved: readonly string[];
  childCalls: number;
  maxDepth: number;
  truncated: boolean;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('RLM request cancelled.', 'AbortError');
}

function boundedPerHit(totalBytes: number, hitCount: number): number {
  if (hitCount <= 0) return 0;
  return Math.max(1_024, Math.floor(totalBytes / hitCount));
}

/**
 * High-level `vibespace_context.query` implementation. Ordinary chat asks one
 * structured question; VibeSpace owns routing, bounds, provenance and child
 * orchestration instead of requiring fragile prompt-mandated tool counts.
 */
export class RlmCoordinator {
  constructor(
    private readonly context: ContextQueryService,
    private readonly worker: RlmInvestigationWorker,
    private readonly trace?: RlmTraceSink,
  ) {}

  async query(input: Readonly<ContextQueryInput>): Promise<ContextQueryResult> {
    const question = input.question.trim();
    if (!question) throw new Error('RLM question cannot be empty.');
    throwIfCancelled(input.signal);

    const decision = decideRlmRoute(input.signals);
    const policy = performancePolicy(input.performance);
    this.trace?.record({
      type: 'route',
      detail: { route: decision.route, reasons: decision.reasons, performance: input.performance },
    });

    if (decision.route === 'direct') {
      return {
        route: 'direct',
        answerSupport: [],
        unresolved: [],
        childCalls: 0,
        maxDepth: 0,
        truncated: false,
      };
    }

    if (decision.route === 'rlm') {
      try {
        const result = await this.worker.investigate({
          question,
          scope: input.scope,
          maxSubcalls: policy.maxSubcalls,
          maxConcurrentSubcalls: policy.maxConcurrentChildren,
          maxEvidenceBytes: policy.maxEvidenceBytes,
          signal: input.signal,
        });
        throwIfCancelled(input.signal);
        const totalBytes = result.evidence.reduce(
          (sum, evidence) => sum + new TextEncoder().encode(evidence.text).byteLength,
          0,
        );
        if (totalBytes > policy.maxEvidenceBytes) {
          throw new Error('RLM_BUDGET_EXHAUSTED: worker returned evidence above the approved byte budget.');
        }
        this.trace?.record({
          type: 'worker',
          detail: {
            childCalls: result.childCalls,
            maxDepth: result.maxDepth,
            evidenceCount: result.evidence.length,
            evidenceBytes: totalBytes,
          },
        });
        return {
          route: 'rlm',
          answerSupport: result.evidence,
          unresolved: result.unresolved,
          childCalls: result.childCalls,
          maxDepth: result.maxDepth,
          truncated: result.evidence.some((evidence) => evidence.truncated),
        };
      } catch (error) {
        if (input.signal?.aborted) {
          this.trace?.record({ type: 'cancelled', detail: { route: 'rlm' } });
        }
        throw error;
      }
    }

    const hits = await this.context.search({
      question,
      scope: input.scope,
      limit: 5,
      signal: input.signal,
    });
    throwIfCancelled(input.signal);
    this.trace?.record({ type: 'search', detail: { hitCount: hits.length } });

    const maxBytes = boundedPerHit(policy.maxEvidenceBytes, hits.length);
    const evidence: EvidenceSpan[] = [];
    let openedBytes = 0;
    for (const hit of hits) {
      throwIfCancelled(input.signal);
      const remaining = policy.maxEvidenceBytes - openedBytes;
      if (remaining <= 0) break;
      const span = await this.context.open({
        pointer: hit.pointer,
        scope: input.scope,
        maxBytes: Math.min(maxBytes, remaining),
        signal: input.signal,
      });
      const bytes = new TextEncoder().encode(span.text).byteLength;
      if (bytes > remaining) {
        throw new Error('RLM_BUDGET_EXHAUSTED: context.open exceeded the remaining evidence budget.');
      }
      openedBytes += bytes;
      evidence.push(span);
      this.trace?.record({
        type: 'open',
        detail: { pointerId: span.pointer.pointerId, bytes, truncated: span.truncated },
      });
    }

    this.trace?.record({
      type: 'complete',
      detail: { route: 'retrieval', evidenceCount: evidence.length, evidenceBytes: openedBytes },
    });
    return {
      route: 'retrieval',
      answerSupport: evidence,
      unresolved: evidence.length > 0 ? [] : ['No permitted supporting context was found.'],
      childCalls: 0,
      maxDepth: 0,
      truncated: evidence.some((span) => span.truncated),
    };
  }
}

import { describe, expect, it, vi } from 'vitest';
import {
  createContextQueryService,
  type ContextQueryRepository,
  type ContextScope,
} from './contextQueryService';
import { createCorpusScaleMetadata } from './corpusScale';
import { createContextPointer, createContextRecord } from './losslessContext';
import {
  RECURSIVE_CONTEXT_LIMITS,
  RecursiveContextError,
  createRecursiveContextPlanner,
  type RecursiveContextBudgets,
  type RecursiveContextEvidence,
} from './recursiveContextPlanner';
import { createRecursiveContextQueryAdapter } from './recursiveContextQueryAdapter';

const corpus = createCorpusScaleMetadata({
  corpusId: 'corpus-100b',
  totalTokens: 100_000_000_000n,
  indexedTokens: 100_000_000_000n,
  chunkCount: 48_828_125n,
  shardCount: 100_000n,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  generatedAt: 1_700_000_000_000,
});

const budgets: RecursiveContextBudgets = {
  maxIterations: 4,
  maxContextTokens: 1_000,
  maxItems: 10,
  maxQueriesPerIteration: 2,
  maxTotalQueries: 6,
};

function evidence(id: string, estimatedTokens = 100): RecursiveContextEvidence {
  return {
    id,
    exactExcerpt: `Evidence ${id}`,
    estimatedTokens,
    provenance: {
      sourceId: `source-${id}`,
      sourceRevision: 'revision-1',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      indexedAt: 1_700_000_000_000,
      locator: `sparse://corpus-100b/${id}`,
    },
  };
}

describe('recursive context planner', () => {
  it('composes exact logical routing through ContextQueryService with derived provenance', async () => {
    const logicalCorpus = createCorpusScaleMetadata({
      corpusId: 'composed-10b',
      totalTokens: 10_000_000_002n,
      indexedTokens: 10_000_000_002n,
      chunkCount: 4_882_813n,
      shardCount: 10_001n,
      contentDigest: `sha256:${'c'.repeat(64)}`,
      generatedAt: 1_700_000_000_000,
    });
    const scope: ContextScope = { accountId: 'account-1', projectId: 'project-1' };
    const content = 'boundary=10000000001 answer=amber-quartz';
    const digest = 'd'.repeat(64);
    const record = createContextRecord({
      id: 'composed-record',
      accountId: scope.accountId,
      projectId: scope.projectId,
      sourceKind: 'file_version',
      sourceId: 'composed-source',
      createdAt: 1,
      contentHash: digest,
      contentRef: 'sparse://physical/shard-10000',
      trustLevel: 'app_verified',
    });
    const pointer = createContextPointer({
      id: 'composed-pointer',
      recordId: record.id,
      byteStart: 0,
      byteEnd: new TextEncoder().encode(content).length,
      sourceVersion: 'revision-1',
      contentHash: digest,
    });
    const repository: ContextQueryRepository = {
      listRecords: vi.fn(async () => [record]),
      getRecord: vi.fn(async () => record),
      search: vi.fn(async (_scope, query) =>
        query === 'token:10000000001;shard:10000;offset:1'
          ? [{ recordId: record.id, pointer, preview: content, score: 1 }]
          : [],
      ),
      readSource: vi.fn(async () => ({
        bytes: new TextEncoder().encode(content),
        contentHash: digest,
        sourceVersion: pointer.sourceVersion,
      })),
      canOpen: vi.fn(async () => true),
    };
    const adapter = createRecursiveContextQueryAdapter({
      queryService: createContextQueryService({ repository }),
      scope,
      logicalAddressing: { corpus: logicalCorpus, shardSize: 1_000_000n },
    });
    const planner = createRecursiveContextPlanner({ retrieveRound: adapter.retrieveRound });

    const result = await planner.retrieve({
      query: 'token:10000000001',
      corpus: logicalCorpus,
      budgets,
    });

    expect(result.status).toBe('complete');
    expect(result.evidence[0]?.provenance).toEqual({
      sourceId: record.sourceId,
      sourceRevision: pointer.sourceVersion,
      contentDigest: `sha256:${digest}`,
      indexedAt: record.createdAt,
      locator: 'sparse://physical/shard-10000#token=10000000001&shard=10000&offset=1',
    });
    expect(repository.search).toHaveBeenCalledWith(
      scope,
      'token:10000000001;shard:10000;offset:1',
      undefined,
    );
  });

  it('detects a recursive query loop without issuing another retrieval', async () => {
    const retrieveRound = vi.fn().mockResolvedValue({
      evidence: [evidence('one')],
      nextQueries: ['  HOW   DOES context retrieval WORK? '],
      complete: false,
    });
    const result = await createRecursiveContextPlanner({ retrieveRound }).retrieve({
      query: 'How does context retrieval work?',
      corpus,
      budgets,
    });
    expect(result.stopReason).toBe('query_loop');
    expect(retrieveRound).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a dependency exceeds the evidence budget', async () => {
    const planner = createRecursiveContextPlanner({
      retrieveRound: vi.fn(async () => ({
        evidence: [evidence('too-large', 1_001)],
        nextQueries: [],
        complete: true,
      })),
    });
    await expect(planner.retrieve({ query: 'start', corpus, budgets })).rejects.toThrowError(
      'recursive_context_error:dependency_exceeded_context_budget',
    );
  });

  it('cancels during retrieval and never returns partial success', async () => {
    const controller = new AbortController();
    const retrieveRound = vi.fn(() => new Promise<never>(() => undefined));
    const pending = createRecursiveContextPlanner({ retrieveRound }).retrieve({
      query: 'start',
      corpus,
      budgets,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails closed on unsupported budgets', async () => {
    const planner = createRecursiveContextPlanner({
      retrieveRound: vi.fn(async () => ({ evidence: [], nextQueries: [], complete: true })),
    });
    await expect(
      planner.retrieve({
        query: 'start',
        corpus,
        budgets: { ...budgets, maxContextTokens: 32_769 },
      }),
    ).rejects.toBeInstanceOf(RecursiveContextError);
  });

  it('accepts every exact planner ceiling and rejects each value above it', async () => {
    const complete = vi.fn(async () => ({
      evidence: [evidence('bounded', RECURSIVE_CONTEXT_LIMITS.maxContextTokens)],
      nextQueries: [],
      complete: true,
    }));
    const atLimits: RecursiveContextBudgets = {
      maxIterations: RECURSIVE_CONTEXT_LIMITS.maxIterations,
      maxContextTokens: RECURSIVE_CONTEXT_LIMITS.maxContextTokens,
      maxItems: RECURSIVE_CONTEXT_LIMITS.maxItems,
      maxQueriesPerIteration: RECURSIVE_CONTEXT_LIMITS.maxQueriesPerIteration,
      maxTotalQueries: RECURSIVE_CONTEXT_LIMITS.maxTotalQueries,
    };
    await expect(
      createRecursiveContextPlanner({ retrieveRound: complete }).retrieve({
        query: 'bounded',
        corpus,
        budgets: atLimits,
      }),
    ).resolves.toMatchObject({
      status: 'complete',
      iterations: 1,
      queriesIssued: 1,
      contextTokens: RECURSIVE_CONTEXT_LIMITS.maxContextTokens,
    });

    for (const field of Object.keys(atLimits) as Array<keyof RecursiveContextBudgets>) {
      await expect(
        createRecursiveContextPlanner({ retrieveRound: complete }).retrieve({
          query: 'bounded',
          corpus,
          budgets: { ...atLimits, [field]: atLimits[field] + 1 },
        }),
      ).rejects.toBeInstanceOf(RecursiveContextError);
    }
  });
});

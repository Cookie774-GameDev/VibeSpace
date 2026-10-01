import { describe, expect, it, vi } from 'vitest';
import {
  createContextQueryService,
  type ContextQueryRepository,
  type ContextScope,
} from './contextQueryService';
import { createContextPointer, createContextRecord } from './losslessContext';
import { MAX_ADDRESSABLE_CORPUS_TOKENS, createCorpusScaleMetadata } from './corpusScale';
import { createRecursiveContextQueryAdapter } from './recursiveContextQueryAdapter';

const encoder = new TextEncoder();
const hash = 'c'.repeat(64);
const scope: ContextScope = { accountId: 'account-1', projectId: 'project-1' };
const corpus = createCorpusScaleMetadata({
  corpusId: 'sparse-10b-plus',
  totalTokens: 10_000_000_002n,
  indexedTokens: 10_000_000_002n,
  chunkCount: 4_882_813n,
  shardCount: 10_001n,
  contentDigest: `sha256:${'d'.repeat(64)}`,
  generatedAt: 1_700_000_000_000,
});

describe('recursive context production query adapter', () => {
  it('retrieves bounded evidence through ContextQueryService search and open authority', async () => {
    const content = 'boundary-token=10000000001; answer=amber-quartz';
    const record = createContextRecord({
      id: 'sparse-10000-1',
      accountId: scope.accountId,
      projectId: scope.projectId,
      sourceKind: 'file_version',
      sourceId: 'sparse://10b-plus-one',
      createdAt: 1_700_000_000_000,
      contentHash: hash,
      contentRef: 'sparse://corpus/shard/10000/offset/1',
      trustLevel: 'app_verified',
    });
    const pointer = createContextPointer({
      id: 'sparse-pointer-10000-1',
      recordId: record.id,
      byteStart: 0,
      byteEnd: encoder.encode(content).length,
      sourceVersion: 'revision-10b-plus-one',
      contentHash: hash,
    });
    const repository: ContextQueryRepository = {
      listRecords: vi.fn(async () => [record]),
      getRecord: vi.fn(async (id) => (id === record.id ? record : undefined)),
      search: vi.fn(async (_scope, query) =>
        query === 'token:10000000001;shard:10000;offset:1'
          ? [{ recordId: record.id, pointer, preview: content, score: 1 }]
          : [],
      ),
      readSource: vi.fn(async () => ({
        bytes: encoder.encode(content),
        contentHash: hash,
        sourceVersion: pointer.sourceVersion,
      })),
      canOpen: vi.fn(async () => true),
    };
    const queryService = createContextQueryService({ repository });
    const adapter = createRecursiveContextQueryAdapter({
      queryService,
      scope,
      logicalAddressing: { corpus, shardSize: 1_000_000n },
    });

    const round = await adapter.retrieveRound({
      queries: ['token:10000000001'],
      excludedEvidenceIds: [],
      iteration: 1,
      maxTokens: 64,
      maxItems: 1,
    });

    expect(round.complete).toBe(true);
    expect(round.evidence).toEqual([
      expect.objectContaining({
        id: pointer.id,
        exactExcerpt: content,
        provenance: {
          sourceId: record.sourceId,
          sourceRevision: pointer.sourceVersion,
          contentDigest: `sha256:${hash}`,
          indexedAt: record.createdAt,
          locator: 'sparse://corpus/shard/10000/offset/1#token=10000000001&shard=10000&offset=1',
        },
      }),
    ]);
    expect(repository.search).toHaveBeenCalledWith(
      scope,
      'token:10000000001;shard:10000;offset:1',
      undefined,
    );
    expect(repository.readSource).toHaveBeenCalled();
  });

  it('returns identical derived routes and evidence twice', async () => {
    const content = 'logical-address=10000000001';
    const record = createContextRecord({
      id: 'repeat-record',
      accountId: scope.accountId,
      projectId: scope.projectId,
      sourceKind: 'file_version',
      sourceId: 'repeat-source',
      createdAt: 1,
      contentHash: hash,
      contentRef: 'sparse://physical/repeat',
      trustLevel: 'app_verified',
    });
    const pointer = createContextPointer({
      id: 'repeat-pointer',
      recordId: record.id,
      byteStart: 0,
      byteEnd: encoder.encode(content).length,
      sourceVersion: 'repeat-revision',
      contentHash: hash,
    });
    const repository: ContextQueryRepository = {
      listRecords: vi.fn(async () => [record]),
      getRecord: vi.fn(async () => record),
      search: vi.fn(async () => [{ recordId: record.id, pointer, preview: content, score: 1 }]),
      readSource: vi.fn(async () => ({
        bytes: encoder.encode(content),
        contentHash: hash,
        sourceVersion: pointer.sourceVersion,
      })),
      canOpen: vi.fn(async () => true),
    };
    const adapter = createRecursiveContextQueryAdapter({
      queryService: createContextQueryService({ repository }),
      scope,
      logicalAddressing: { corpus, shardSize: '1000000' },
    });
    const request = {
      queries: ['token:10000000001'],
      excludedEvidenceIds: [],
      iteration: 1,
      maxTokens: 64,
      maxItems: 1,
    };

    const first = await adapter.retrieveRound(request);
    const second = await adapter.retrieveRound(request);

    expect(second).toEqual(first);
    expect(repository.search).toHaveBeenNthCalledWith(
      1,
      scope,
      'token:10000000001;shard:10000;offset:1',
      undefined,
    );
    expect(repository.search).toHaveBeenNthCalledWith(
      2,
      scope,
      'token:10000000001;shard:10000;offset:1',
      undefined,
    );
  });

  it.each([
    [1_000_000_002n, 999_999_999n, 'token:999999999;shard:999;offset:999999'],
    [1_000_000_002n, 1_000_000_000n, 'token:1000000000;shard:1000;offset:0'],
    [1_000_000_002n, 1_000_000_001n, 'token:1000000001;shard:1000;offset:1'],
    [10_000_000_002n, 9_999_999_999n, 'token:9999999999;shard:9999;offset:999999'],
    [10_000_000_002n, 10_000_000_000n, 'token:10000000000;shard:10000;offset:0'],
    [10_000_000_002n, 10_000_000_001n, 'token:10000000001;shard:10000;offset:1'],
    [100_000_000_002n, 99_999_999_999n, 'token:99999999999;shard:99999;offset:999999'],
    [100_000_000_002n, 100_000_000_000n, 'token:100000000000;shard:100000;offset:0'],
    [100_000_000_002n, 100_000_000_001n, 'token:100000000001;shard:100000;offset:1'],
    [
      MAX_ADDRESSABLE_CORPUS_TOKENS,
      9_007_199_254_740_991n,
      'token:9007199254740991;shard:9007199254;offset:740991',
    ],
    [
      MAX_ADDRESSABLE_CORPUS_TOKENS,
      9_007_199_254_740_992n,
      'token:9007199254740992;shard:9007199254;offset:740992',
    ],
    [
      MAX_ADDRESSABLE_CORPUS_TOKENS,
      9_007_199_254_740_993n,
      'token:9007199254740993;shard:9007199254;offset:740993',
    ],
  ])(
    'routes boundary address %s/%s through the typed production adapter',
    async (size, position, route) => {
      const queryService = {
        search: vi.fn(async () => ({
          items: [],
          truncated: false,
          indexAvailable: true,
          stale: false,
        })),
        open: vi.fn(),
      };
      const boundaryCorpus = createCorpusScaleMetadata({
        corpusId: 'boundary-corpus',
        totalTokens: size,
        indexedTokens: size,
        chunkCount: size / 2_048n + 1n,
        shardCount: size / 1_000_000n + 1n,
        contentDigest: `sha256:${'e'.repeat(64)}`,
        generatedAt: 1,
      });
      const adapter = createRecursiveContextQueryAdapter({
        queryService,
        scope,
        logicalAddressing: { corpus: boundaryCorpus, shardSize: 1_000_000n },
      });

      await adapter.retrieveRound({
        queries: [`token:${position.toString(10)}`],
        excludedEvidenceIds: [],
        iteration: 1,
        maxTokens: 64,
        maxItems: 1,
      });

      expect(queryService.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: route, scope }),
      );
      expect(queryService.open).not.toHaveBeenCalled();
    },
  );

  it.each(['token:10000000002', 'token:01', 'token:1e10', 'token:+1', 'token:1.0'])(
    'rejects invalid logical address %s before any query service call',
    async (query) => {
      const queryService = {
        search: vi.fn(),
        open: vi.fn(),
      };
      const adapter = createRecursiveContextQueryAdapter({
        queryService,
        scope,
        logicalAddressing: { corpus, shardSize: 1_000_000n },
      });

      await expect(
        adapter.retrieveRound({
          queries: [query],
          excludedEvidenceIds: [],
          iteration: 1,
          maxTokens: 64,
          maxItems: 1,
        }),
      ).rejects.toBeDefined();
      expect(queryService.search).not.toHaveBeenCalled();
      expect(queryService.open).not.toHaveBeenCalled();
    },
  );

  it('cancels after search without opening or publishing evidence', async () => {
    const controller = new AbortController();
    const queryService = {
      search: vi.fn(async () => {
        controller.abort();
        return { items: [], truncated: false, indexAvailable: true, stale: false };
      }),
      open: vi.fn(),
    };
    const adapter = createRecursiveContextQueryAdapter({
      queryService,
      scope,
      logicalAddressing: { corpus, shardSize: 1_000_000n },
    });

    await expect(
      adapter.retrieveRound({
        queries: ['token:10000000001'],
        excludedEvidenceIds: [],
        iteration: 1,
        maxTokens: 64,
        maxItems: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(queryService.open).not.toHaveBeenCalled();
  });

  it('honors cancellation and excluded evidence without bypassing query authority', async () => {
    const controller = new AbortController();
    controller.abort();
    const queryService = createContextQueryService({
      repository: {
        listRecords: vi.fn(),
        getRecord: vi.fn(),
        search: vi.fn(),
        readSource: vi.fn(),
        canOpen: vi.fn(),
      },
    });
    await expect(
      createRecursiveContextQueryAdapter({ queryService, scope }).retrieveRound({
        queries: ['token:1'],
        excludedEvidenceIds: [],
        iteration: 1,
        maxTokens: 64,
        maxItems: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

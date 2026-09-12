import { describe, expect, it, vi } from 'vitest';
import {
  ContextQueryError,
  createContextQueryService,
  type ContextQueryRepository,
  type ContextSearchItem,
  type ContextScope,
} from './contextQueryService';
import {
  createContextPointer,
  createContextRecord,
  type ContextPointer,
  type ContextRecord,
} from './losslessContext';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const encoder = new TextEncoder();

function record(id: string, overrides: Partial<ContextRecord> = {}): ContextRecord {
  return createContextRecord({
    id,
    accountId: 'account-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    sourceKind: 'file_version',
    sourceId: `source-${id}`,
    createdAt: 1_700_000_000_000,
    contentHash: HASH_A,
    contentRef: `asset://${id}`,
    title: `${id}.txt`,
    trustLevel: 'app_verified',
    ...overrides,
  });
}

function pointer(recordId: string, start = 0, end = 12): ContextPointer {
  return createContextPointer({
    id: `pointer-${recordId}-${start}-${end}`,
    recordId,
    byteStart: start,
    byteEnd: end,
    sourceVersion: 'sha256:aaaaaaaa',
    contentHash: HASH_A,
  });
}

const scope: ContextScope = {
  accountId: 'account-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

function repository(
  records: readonly ContextRecord[],
  content = 'alpha\nbeta\ngamma\ndelta\n',
): ContextQueryRepository {
  return {
    listRecords: vi.fn(async () => records),
    getRecord: vi.fn(async (recordId) => records.find((item) => item.id === recordId)),
    search: vi.fn(async () =>
      records.map((item, index) => ({
        recordId: item.id,
        pointer: pointer(item.id),
        preview: `${item.title} ${'match '.repeat(80)}`,
        score: 1 - index / 10,
      })),
    ),
    readSource: vi.fn(async () => ({
      bytes: encoder.encode(content),
      contentHash: HASH_A,
      sourceVersion: 'sha256:aaaaaaaa',
    })),
    canOpen: vi.fn(async () => true),
    relatedRecordIds: vi.fn(async (recordId) =>
      records.filter((item) => item.id !== recordId).map((item) => item.id),
    ),
  };
}

describe('context query service', () => {
  it('exposes the complete bounded query surface', () => {
    const service = createContextQueryService({ repository: repository([]) });
    expect(Object.keys(service).sort()).toEqual(
      [
        'checkpoint',
        'describe',
        'expand',
        'investigate',
        'open',
        'related',
        'search',
        'sources',
        'timeline',
      ].sort(),
    );
  });

  it('bounds search previews and paginates with opaque continuation handles', async () => {
    const repo = repository([record('one'), record('two'), record('three')]);
    const service = createContextQueryService({
      repository: repo,
      limits: { maxSearchResults: 2, maxPreviewCharacters: 48 },
    });

    const first = await service.search({ scope, query: 'match', limit: 99 });
    expect(first.items).toHaveLength(2);
    expect(first.items.every((item) => item.preview.length <= 48)).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.continuation).toMatch(/^ctxc_/);

    const second = await service.search({
      scope,
      query: 'match',
      limit: 99,
      continuation: first.continuation,
    });
    expect(second.items.map((item) => item.record.id)).toEqual(['three']);
    expect(second.truncated).toBe(false);
  });

  it('issues only the exact visible search page and authorizes continuation rows when emitted', async () => {
    const records = Array.from({ length: 20 }, (_, index) => record(`row-${index + 1}`));
    const issued = new Set<string>();
    const issuePointers = vi.fn((items: readonly ContextSearchItem[]) => {
      for (const item of items) issued.add(item.pointer.id);
      return true;
    });
    const repo = {
      ...repository(records),
      issuePointers,
      validatePointer: vi.fn((candidate: ContextPointer) => issued.has(candidate.id)),
    } as ContextQueryRepository;
    const service = createContextQueryService({
      repository: repo,
      limits: { maxSearchResults: 3 },
    });

    const first = await service.search({ scope, query: 'match', limit: 3 });

    expect(first.items.map((item) => item.record.id)).toEqual(['row-1', 'row-2', 'row-3']);
    expect(issuePointers).toHaveBeenCalledTimes(1);
    expect(issuePointers.mock.calls[0]![0].map((item) => item.record.id)).toEqual([
      'row-1',
      'row-2',
      'row-3',
    ]);
    await Promise.all(
      first.items.map(async (item) => {
        await expect(service.open({ scope, pointer: item.pointer })).resolves.toMatchObject({
          status: 'current',
        });
      }),
    );
    await expect(service.open({ scope, pointer: pointer('row-4') })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });

    const second = await service.search({
      scope,
      query: 'match',
      limit: 3,
      continuation: first.continuation,
    });
    expect(second.items.map((item) => item.record.id)).toEqual(['row-4', 'row-5', 'row-6']);
    expect(issuePointers).toHaveBeenCalledTimes(2);
    await expect(service.open({ scope, pointer: pointer('row-4') })).resolves.toMatchObject({
      status: 'current',
    });
  });

  it('issues no pointers when cancellation arrives after repository search and before emission', async () => {
    const controller = new AbortController();
    const issuePointers = vi.fn(() => true);
    const repo = {
      ...repository([record('one')]),
      search: vi.fn(async () => {
        controller.abort('owner_cancelled');
        return [
          {
            recordId: 'one',
            pointer: pointer('one'),
            preview: 'one',
            score: 1,
          },
        ];
      }),
      issuePointers,
    } as ContextQueryRepository;
    const service = createContextQueryService({ repository: repo });

    await expect(
      service.search({ scope, query: 'match', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(issuePointers).not.toHaveBeenCalled();
  });

  it('re-checks scope and permission at open time and returns exact bounded bytes', async () => {
    const repo = repository([record('one')], '0123456789abcdefghijklmnop');
    const service = createContextQueryService({
      repository: repo,
      limits: { maxOpenBytes: 5 },
    });
    const exact = pointer('one', 2, 14);

    const first = await service.open({ scope, pointer: exact });
    expect(first).toMatchObject({
      status: 'current',
      text: '23456',
      byteStart: 2,
      byteEnd: 7,
      truncated: true,
    });
    expect(first.continuation).toMatch(/^ctxc_/);

    const second = await service.open({
      scope,
      pointer: exact,
      continuation: first.continuation,
    });
    expect(second.text).toBe('789ab');
    expect(repo.canOpen).toHaveBeenCalledTimes(2);
  });

  it('rejects byte pointers outside the current physical source instead of clamping them', async () => {
    const repo = repository([record('one')], '0123456789');
    const service = createContextQueryService({ repository: repo });

    await expect(service.open({ scope, pointer: pointer('one', 8, 12) })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });
    await expect(
      service.expand({
        scope,
        pointer: pointer('one', 10, 11),
        beforeBytes: 2,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });
  });

  it('fails closed when repository pointer correlation rejects a hybrid pointer', async () => {
    const validatePointer = vi.fn(
      async (candidate: ContextPointer) =>
        candidate.id === `ptr:${candidate.recordId}:${candidate.byteStart}:${candidate.byteEnd}`,
    );
    const repo = {
      ...repository([record('one')], '0123456789'),
      validatePointer,
    } as ContextQueryRepository;
    const service = createContextQueryService({ repository: repo });
    const exact = createContextPointer({
      ...pointer('one', 2, 8),
      id: 'ptr:one:2:8',
    });
    const hybrid = createContextPointer({
      ...exact,
      id: 'ptr:other:2:8',
    });

    await expect(service.open({ scope, pointer: exact })).resolves.toMatchObject({
      text: '234567',
    });
    await expect(service.open({ scope, pointer: hybrid })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });
    await expect(service.expand({ scope, pointer: hybrid, beforeBytes: 1 })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });
    expect(validatePointer).toHaveBeenCalledTimes(3);
  });

  it('derives exact one-based line provenance from LF, CRLF, and multibyte source bytes', async () => {
    const content = 'α\r\nβ\n終';
    const repo = repository([record('one')], content);
    const service = createContextQueryService({ repository: repo });

    const result = await service.open({
      scope,
      pointer: pointer('one', encoder.encode('α\r\n').length, encoder.encode(content).length),
    });

    expect(result).toMatchObject({
      text: 'β\n終',
      byteStart: 4,
      byteEnd: 10,
      lineStart: 2,
      lineEnd: 3,
    });
  });

  it('reports the exact line range for each bounded open continuation', async () => {
    const content = 'aa\nbb\ncc';
    const service = createContextQueryService({
      repository: repository([record('one')], content),
      limits: { maxOpenBytes: 4 },
    });
    const exact = pointer('one', 0, encoder.encode(content).length);

    const first = await service.open({ scope, pointer: exact });
    const second = await service.open({
      scope,
      pointer: exact,
      continuation: first.continuation,
    });

    expect(first).toMatchObject({
      text: 'aa\nb',
      byteStart: 0,
      byteEnd: 4,
      lineStart: 1,
      lineEnd: 2,
    });
    expect(second).toMatchObject({
      text: 'b\ncc',
      byteStart: 4,
      byteEnd: 8,
      lineStart: 2,
      lineEnd: 3,
    });
  });

  it('keeps newline provenance deterministic and rejects an empty past-end byte span', async () => {
    const content = 'a\n';
    const service = createContextQueryService({
      repository: repository([record('one')], content),
    });

    await expect(service.open({ scope, pointer: pointer('one', 0, 2) })).resolves.toMatchObject({
      text: 'a\n',
      lineStart: 1,
      lineEnd: 1,
    });
    await expect(service.open({ scope, pointer: pointer('one', 2, 3) })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });
  });

  it('rehydrates persisted record authority before opening a pointer after restart', async () => {
    const persisted = record('one');
    let hydrated = false;
    const repo = repository([persisted], '0123456789abcdefghijklmnop');
    vi.mocked(repo.getRecord).mockImplementation(async (recordId) =>
      hydrated && recordId === persisted.id ? persisted : undefined,
    );
    vi.mocked(repo.listRecords).mockImplementation(async () => {
      hydrated = true;
      return [persisted];
    });
    const service = createContextQueryService({ repository: repo });

    await expect(service.open({ scope, pointer: pointer('one', 2, 8) })).resolves.toMatchObject({
      text: '234567',
      byteStart: 2,
      byteEnd: 8,
    });
    expect(repo.listRecords).toHaveBeenCalledWith(scope, undefined);
    expect(repo.getRecord).toHaveBeenCalledTimes(2);
  });

  it('refuses cross-scope records even when a repository accidentally returns them', async () => {
    const repo = repository([record('foreign', { projectId: 'project-2' })]);
    const service = createContextQueryService({ repository: repo });

    await expect(service.open({ scope, pointer: pointer('foreign') })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    expect(repo.canOpen).not.toHaveBeenCalled();
  });

  it('reports missing, stale, and hash-mismatched authority without retargeting', async () => {
    const repo = repository([record('one')]);
    const service = createContextQueryService({ repository: repo });
    vi.mocked(repo.readSource)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        bytes: encoder.encode('changed'),
        contentHash: HASH_B,
        sourceVersion: 'sha256:bbbbbbbb',
      });

    await expect(service.open({ scope, pointer: pointer('one') })).rejects.toMatchObject({
      code: 'source_missing',
    });
    await expect(service.open({ scope, pointer: pointer('one') })).rejects.toMatchObject({
      code: 'source_stale',
    });
  });

  it('invalidates deleted authority even when a repository still returns a stale pointer', async () => {
    const repo = repository([record('deleted', { deletedAt: 1_700_000_000_001 })]);
    const service = createContextQueryService({ repository: repo });
    await expect(service.open({ scope, pointer: pointer('deleted') })).rejects.toMatchObject({
      code: 'scope_denied',
    });
  });

  it('never crosses account, project, or worktree boundaries in cached continuations', async () => {
    const repo = repository([record('one'), record('two')]);
    const service = createContextQueryService({
      repository: repo,
      limits: { maxSearchResults: 1 },
    });
    const first = await service.search({ scope, query: 'match' });
    await expect(
      service.search({
        scope: { ...scope, worktreeId: 'worktree-attacker' },
        query: 'match',
        continuation: first.continuation,
      }),
    ).rejects.toMatchObject({ code: 'continuation_invalid' });
  });

  it('expands neighboring bytes but never exceeds the configured open budget', async () => {
    const validatePointer = vi.fn(async () => true);
    const service = createContextQueryService({
      repository: {
        ...repository([record('one')], '0123456789abcdefghijklmnop'),
        validatePointer,
      } as ContextQueryRepository,
      limits: { maxOpenBytes: 10 },
    });
    const result = await service.expand({
      scope,
      pointer: pointer('one', 10, 14),
      beforeBytes: 4,
      afterBytes: 7,
    });

    expect(result.text).toBe('6789abcdef');
    expect(result.byteStart).toBe(6);
    expect(result.byteEnd).toBe(16);
    expect(result.lineStart).toBe(1);
    expect(result.lineEnd).toBe(1);
    expect(result.truncated).toBe(true);
    expect(validatePointer).toHaveBeenCalledTimes(1);
  });

  it('derives expanded line provenance from the exact bounded expanded byte range', async () => {
    const content = 'zero\none\ntwo\n';
    const service = createContextQueryService({
      repository: repository([record('one')], content),
      limits: { maxOpenBytes: 13 },
    });
    const result = await service.expand({
      scope,
      pointer: pointer('one', 5, 8),
      beforeBytes: 5,
      afterBytes: 4,
    });

    expect(result).toMatchObject({
      text: 'zero\none\ntwo',
      byteStart: 0,
      byteEnd: 12,
      lineStart: 1,
      lineEnd: 3,
    });
  });

  it('propagates cancellation before repository work starts', async () => {
    const repo = repository([record('one')]);
    const service = createContextQueryService({ repository: repo });
    const controller = new AbortController();
    controller.abort('owner_cancelled');

    await expect(
      service.search({ scope, query: 'alpha', signal: controller.signal }),
    ).rejects.toBeInstanceOf(ContextQueryError);
    expect(repo.search).not.toHaveBeenCalled();
  });

  it('returns no open provenance when cancellation arrives during the physical source read', async () => {
    const repo = repository([record('one')]);
    const controller = new AbortController();
    vi.mocked(repo.readSource).mockImplementation(async () => {
      controller.abort('owner_cancelled');
      return {
        bytes: encoder.encode('alpha\nbeta'),
        contentHash: HASH_A,
        sourceVersion: 'sha256:aaaaaaaa',
      };
    });
    const service = createContextQueryService({ repository: repo });

    await expect(
      service.open({ scope, pointer: pointer('one'), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('preserves cancellation truth when cancellation arrives during pointer validation', async () => {
    const controller = new AbortController();
    const repo = {
      ...repository([record('one')]),
      validatePointer: vi.fn(async () => {
        controller.abort('owner_cancelled');
        return false;
      }),
    } as ContextQueryRepository;
    const service = createContextQueryService({ repository: repo });

    await expect(
      service.open({ scope, pointer: pointer('one'), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('returns scoped sources, timeline, related pointers, checkpoints, and investigation packs', async () => {
    const one = record('one', { createdAt: 10 });
    const two = record('two', { createdAt: 20 });
    const service = createContextQueryService({
      repository: repository([two, one, record('foreign', { accountId: 'account-2' })]),
      limits: { maxSearchResults: 2, maxPreviewCharacters: 80, maxOpenBytes: 20 },
    });

    expect((await service.sources({ scope })).items.map((item) => item.id)).toEqual(['two', 'one']);
    expect((await service.timeline({ scope })).items.map((item) => item.id)).toEqual([
      'one',
      'two',
    ]);
    expect((await service.related({ scope, recordId: 'one' })).items[0]?.id).toBe('two');
    expect(await service.checkpoint({ scope })).toMatchObject({
      recordCount: 2,
      contentHashes: [HASH_A, HASH_A],
    });
    expect((await service.investigate({ scope, query: 'match' })).evidence.length).toBeGreaterThan(
      0,
    );
  });
});

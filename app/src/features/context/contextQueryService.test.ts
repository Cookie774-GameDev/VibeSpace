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
  it('uses scoped repository metadata for describe without hydrating every source', async () => {
    const repo = repository([record('one')]);
    repo.describeSummary = vi.fn(async () => ({
      recordCount: 5_734,
      sourceKinds: ['file_version' as const],
    }));
    const service = createContextQueryService({ repository: repo });

    await expect(service.describe({ scope })).resolves.toMatchObject({
      scope, recordCount: 5_734, sourceKinds: ['file_version'],
      indexAvailable: true, stale: false,
    });
    expect(repo.describeSummary).toHaveBeenCalledWith(scope, undefined);
    expect(repo.listRecords).not.toHaveBeenCalled();
  });

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

  it.each([
    'one\r\ntwo three',
    'AéBαC',
    '甲乙丙丁終',
    'a🚀b🌍c',
    'Cafe\u0301 e\u0301',
    '\uFEFFalpha\uFEFFomega',
    'α\r\n🚀終e\u0301\nlast',
  ])('round-trips exact UTF-8 source bytes across bounded pages: %s', async (content) => {
    const bytes = encoder.encode(content);
    for (const maxOpenBytes of [4, 5, 7, 11]) {
      const service = createContextQueryService({
        repository: repository([record('one')], content),
        limits: { maxOpenBytes },
      });
      const exact = pointer('one', 0, bytes.length);
      let continuation: string | undefined;
      let joined = '';
      let end = 0;
      let pages = 0;
      do {
        const page = await service.open({ scope, pointer: exact, continuation });
        expect(page.byteStart).toBe(end);
        expect(page.byteEnd).toBeGreaterThan(end);
        expect(page.byteEnd - page.byteStart).toBeLessThanOrEqual(maxOpenBytes);
        expect(encoder.encode(page.text)).toEqual(bytes.slice(page.byteStart, page.byteEnd));
        expect(page.pointer.byteStart).toBe(page.byteStart);
        expect(page.pointer.byteEnd).toBe(page.byteEnd);
        expect(Boolean(page.continuation)).toBe(page.truncated);
        joined += page.text;
        end = page.byteEnd;
        continuation = page.continuation;
        expect(++pages).toBeLessThan(100);
      } while (continuation);
      expect(joined).toBe(content);
      expect(end).toBe(bytes.length);
    }
  });

  it('rejects a byte budget too small for one whole character', async () => {
    const service = createContextQueryService({ repository: repository([record('one')], '🚀x') });
    await expect(service.open({ scope, pointer: pointer('one', 0, 5), maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'query_invalid' });
  });

  it.each([{ start: 1, end: 5 }, { start: 0, end: 2 }])(
    'rejects partial-character pointer $start-$end instead of widening authority', async ({ start, end }) => {
      const service = createContextQueryService({ repository: repository([record('one')], '🚀x') });
      await expect(service.open({ scope, pointer: pointer('one', start, end) }))
        .rejects.toMatchObject({ code: 'pointer_invalid' });
    },
  );

  it('expands only complete UTF-8 neighbors inside the requested byte limits', async () => {
    const service = createContextQueryService({
      repository: repository([record('one')], 'αSTART🚀END終'),
    });
    const exact = pointer('one', 2, 7);
    expect(await service.expand({ scope, pointer: exact, beforeBytes: 1, afterBytes: 2 }))
      .toMatchObject({ text: 'START', byteStart: 2, byteEnd: 7 });
    expect(await service.expand({ scope, pointer: exact, beforeBytes: 2, afterBytes: 4 }))
      .toMatchObject({ text: 'αSTART🚀', byteStart: 0, byteEnd: 11 });
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

  it('uses targeted missing-record rehydration when the repository provides it', async () => {
    const repo = repository([]);
    const rehydrate = vi.fn(async () => undefined);
    repo.rehydrateMissingRecord = rehydrate;
    const service = createContextQueryService({ repository: repo });

    await expect(service.open({ scope, pointer: pointer('missing') })).rejects.toMatchObject({
      code: 'record_missing',
    });
    expect(rehydrate).toHaveBeenCalledWith('missing', scope, undefined);
    expect(repo.listRecords).not.toHaveBeenCalled();
    expect(repo.getRecord).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched mapped-file pointer before rehydration or source I/O', async () => {
    const repo = repository([]);
    const rehydrate = vi.fn(async () => undefined);
    repo.rehydrateMissingRecord = rehydrate;
    const service = createContextQueryService({ repository: repo });
    const legitimateRecordId = `rlm:${'a'.repeat(64)}`;
    const mismatchedRecordId = `rlm:${'b'.repeat(64)}`;
    const malformed = createContextPointer({
      id: `ptr:${legitimateRecordId}:0:12`,
      recordId: mismatchedRecordId,
      byteStart: 0,
      byteEnd: 12,
      sourceVersion: `sha256:${HASH_A}`,
      contentHash: HASH_A,
    });

    await expect(service.open({ scope, pointer: malformed })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });
    expect(repo.getRecord).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();
    expect(repo.listRecords).not.toHaveBeenCalled();
    expect(repo.readSource).not.toHaveBeenCalled();
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

  it('rejects an unissued pointer before canOpen or source reads', async () => {
    const repo = repository([record('one')]);
    repo.authorizePointer = vi.fn(async () => false);
    const service = createContextQueryService({ repository: repo });

    await expect(service.open({ scope, pointer: pointer('one') })).rejects.toMatchObject({
      code: 'pointer_invalid',
    });
    expect(repo.authorizePointer).toHaveBeenCalledWith(pointer('one'), record('one'), scope, undefined);
    expect(repo.canOpen).not.toHaveBeenCalled();
    expect(repo.readSource).not.toHaveBeenCalled();
  });

  it('preauthorizes a valid pointer before canOpen and retains post-read validation', async () => {
    const order: string[] = [];
    const repo = repository([record('one')]);
    repo.authorizePointer = vi.fn(async () => { order.push('authorize'); return true; });
    vi.mocked(repo.canOpen).mockImplementation(async () => { order.push('canOpen'); return true; });
    vi.mocked(repo.readSource).mockImplementation(async () => {
      order.push('readSource');
      return { bytes: encoder.encode('alpha\nbeta\ngamma\ndelta\n'), contentHash: HASH_A, sourceVersion: 'sha256:aaaaaaaa' };
    });
    repo.validatePointer = vi.fn(async () => { order.push('validate'); return true; });
    const service = createContextQueryService({ repository: repo });

    await expect(service.open({ scope, pointer: pointer('one') })).resolves.toMatchObject({
      status: 'current',
    });
    expect(order).toEqual(['authorize', 'canOpen', 'readSource', 'validate']);
  });

  it('honors cancellation raised during pre-read pointer authorization before source access', async () => {
    const controller = new AbortController();
    const repo = repository([record('one')]);
    repo.authorizePointer = vi.fn(async () => {
      controller.abort('owner_cancelled');
      return true;
    });
    const service = createContextQueryService({ repository: repo });

    await expect(
      service.open({ scope, pointer: pointer('one'), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(repo.canOpen).not.toHaveBeenCalled();
    expect(repo.readSource).not.toHaveBeenCalled();
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

  it('continues expanded pages by revalidating the original issued pointer', async () => {
    const content = '0123456789🚀tail';
    const original = { ...pointer('one', 6, 10) };
    const validatePointer = vi.fn(async (candidate: ContextPointer) =>
      candidate.id === 'pointer-one-6-10' && candidate.byteStart === 6 && candidate.byteEnd === 10,
    );
    const service = createContextQueryService({
      repository: { ...repository([record('one')], content), validatePointer },
      limits: { maxOpenBytes: 5 },
    });
    let page = await service.expand({ scope, pointer: original, beforeBytes: 6, afterBytes: 20 });
    expect(page.truncated).toBe(true);
    const first = page;
    // A caller cannot alter the authority already retained by the opaque continuation.
    original.byteStart = 0;
    original.byteEnd = 1_000;
    let joined = page.text;
    while (page.continuation) {
      page = await service.open({ scope, pointer: page.pointer, continuation: page.continuation });
      joined += page.text;
    }
    expect(joined).toBe(content);
    expect(validatePointer.mock.calls.every(([candidate]) => candidate.id === 'pointer-one-6-10'))
      .toBe(true);
    await expect(service.open({ scope, pointer: first.pointer, continuation: first.continuation }))
      .rejects.toMatchObject({ code: 'continuation_invalid' });
    await expect(service.open({ scope, pointer: first.pointer }))
      .rejects.toMatchObject({ code: 'pointer_invalid' });
  });

  it.each([
    ['pointer', 'pointer_invalid'],
    ['permission', 'permission_denied'],
    ['revision', 'source_stale'],
  ] as const)('keeps %s revocation effective on expanded continuations', async (kind, code) => {
    const validatePointer = vi.fn(async () => true);
    const repo = { ...repository([record('one')], '0123456789abcdefghijkl'), validatePointer };
    const service = createContextQueryService({ repository: repo, limits: { maxOpenBytes: 5 } });
    const first = await service.expand({ scope, pointer: pointer('one', 6, 10), beforeBytes: 6, afterBytes: 10 });
    if (kind === 'pointer') validatePointer.mockResolvedValue(false);
    if (kind === 'permission') vi.mocked(repo.canOpen).mockResolvedValue(false);
    if (kind === 'revision') vi.mocked(repo.readSource).mockResolvedValue({
      bytes: encoder.encode('changed'), contentHash: HASH_B, sourceVersion: 'changed',
    });
    await expect(service.open({ scope, pointer: first.pointer, continuation: first.continuation }))
      .rejects.toMatchObject({ code });
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

describe('truthful bounded-result coverage', () => {
  it('marks a caller-limited source list and timeline as truncated', async () => {
    const service = createContextQueryService({
      repository: repository([record('one'), record('two')]),
    });
    expect(await service.sources({ scope, limit: 1 })).toMatchObject({ truncated: true });
    expect(await service.timeline({ scope, limit: 1 })).toMatchObject({ truncated: true });
    expect(await service.sources({ scope, limit: 2 })).toMatchObject({ truncated: false });
  });
  it('does not describe skipped missing evidence as a complete investigation', async () => {
    const repo = repository([record('one'), record('missing')]);
    const read = repo.readSource;
    repo.readSource = async (item, signal) =>
      item.id === 'missing' ? undefined : read(item, signal);
    const service = createContextQueryService({ repository: repo });
    const result = await service.investigate({ scope, query: 'match' });
    expect(result.evidence.map((item) => item.record.id)).toEqual(['one']);
    expect(result.truncated).toBe(true);
  });
  it('reports byte-capped opened evidence as incomplete', async () => {
    const service = createContextQueryService({
      repository: repository([record('one')]),
      limits: { maxOpenBytes: 4 },
    });
    const result = await service.investigate({ scope, query: 'match' });
    expect(result.evidence[0].truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });
});

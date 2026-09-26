import { describe, expect, it, vi } from 'vitest';
import { createContextPointer } from './losslessContext';
import {
  ContextQueryError,
  createContextQueryService,
  type ContextScope,
} from './contextQueryService';
import { createSiyuanRlmRepository, type SiyuanRlmPort } from './siyuanRlmRepository';

const scope: ContextScope = Object.freeze({
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
});

function port(markdown = '# Project Atlas\nThe launch phrase is cobalt fern.'): SiyuanRlmPort {
  return {
    searchBlocks: vi.fn(async () => [
      {
        id: '20260820-block',
        notebookId: '20260820-book',
        path: '/Project Atlas.sy',
        content: 'Project Atlas cobalt fern',
      },
    ]),
    getBlock: vi.fn(async (_projectId, id) => ({
      id,
      notebookId: '20260820-book',
      path: '/Project Atlas.sy',
      markdown,
    })),
    listInboundBacklinks: vi.fn(async () => []),
  };
}

describe('SiYuan RLM repository', () => {
  it('preserves the observed revision timestamp through repeated search, open and expand', async () => {
    let markdown = 'Revision one: cobalt fern.';
    let now = 1_000;
    const native = port();
    vi.mocked(native.getBlock).mockImplementation(async (_projectId, id) => ({
      id, notebookId: '20260820-book', path: '/Project Atlas.sy', markdown,
    }));
    const service = createContextQueryService({
      repository: createSiyuanRlmRepository(native, { now: () => now }),
    });
    const initial = (await service.search({ scope, query: 'cobalt fern' })).items[0]!;
    expect(initial.record.createdAt).toBe(1_000);
    expect(initial.record.updatedAt).toBeUndefined();

    markdown = 'Revision two: cobalt fern.';
    now = 2_000;
    const revised = (await service.search({ scope, query: 'cobalt fern' })).items[0]!;
    expect(revised.record.updatedAt).toBe(2_000);
    now = 3_000;
    const first = await service.open({ scope, pointer: revised.pointer });
    const second = await service.open({ scope, pointer: revised.pointer });
    const expanded = await service.expand({ scope, pointer: revised.pointer, beforeBytes: 16, afterBytes: 16 });
    const repeated = (await service.search({ scope, query: 'cobalt fern' })).items[0]!;
    for (const record of [first.record, second.record, expanded.record, repeated.record]) {
      expect(record).toEqual(revised.record);
    }
    expect(second.text).toContain('Revision two');

    markdown = 'Revision three: cobalt fern.';
    now = 4_000;
    const latest = (await service.search({ scope, query: 'cobalt fern' })).items[0]!;
    expect(latest.record).toMatchObject({ createdAt: 1_000, updatedAt: 4_000 });
    expect(latest.record.contentHash).not.toBe(revised.record.contentHash);
    expect((await service.open({ scope, pointer: latest.pointer })).record).toEqual(latest.record);
  });

  it('does not invent an update timestamp when unchanged content is reread', async () => {
    let now = 1_000;
    const service = createContextQueryService({
      repository: createSiyuanRlmRepository(port(), { now: () => now }),
    });
    const initial = (await service.search({ scope, query: 'cobalt fern' })).items[0]!;
    now = 2_000;
    const reopened = await service.open({ scope, pointer: initial.pointer });
    const repeated = (await service.search({ scope, query: 'cobalt fern' })).items[0]!;
    expect(reopened.record).toEqual(initial.record);
    expect(repeated.record).toEqual(initial.record);
    expect(repeated.record.updatedAt).toBeUndefined();
  });

  it('keeps a byte-capped search pointer on a complete UTF-8 boundary', async () => {
    const markdown = `${'x'.repeat(65_535)}🚀END`;
    const service = createContextQueryService({ repository: createSiyuanRlmRepository(port(markdown)) });
    const item = (await service.search({ scope, query: 'atlas' })).items[0]!;
    expect(item.pointer.byteEnd).toBe(65_535);
    expect(item.pointer.id).toBe(`ptr:${item.record.id}:0:65535`);
    const opened = await service.open({ scope, pointer: item.pointer });
    expect(opened.text).toBe('x'.repeat(65_535));
    expect(new TextEncoder().encode(opened.text)).toEqual(
      new TextEncoder().encode(markdown).slice(opened.byteStart, opened.byteEnd),
    );
  });

  it('produces scoped hash-bound pointers that open through ContextQueryService', async () => {
    const native = port();
    const repository = createSiyuanRlmRepository(native, { now: () => 1_000 });
    const service = createContextQueryService({ repository });
    const found = await service.search({ scope, query: 'cobalt fern' });

    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.record).toMatchObject({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sourceKind: 'context_note',
      sourceId: '20260820-block',
      parentSourceId: '20260820-book',
      trustLevel: 'app_verified',
    });
    expect(found.items[0]?.record.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(found.items[0]?.pointer.contentHash).toBe(found.items[0]?.record.contentHash);

    const opened = await service.open({ scope, pointer: found.items[0]!.pointer });
    expect(opened.text).toContain('cobalt fern');
    expect(native.searchBlocks).toHaveBeenCalledWith('project-1', 'cobalt fern', 20);
    expect(native.getBlock).toHaveBeenCalledWith('project-1', '20260820-block');
  });

  it('prioritizes only an exact structured identifier without changing ordinary scores', async () => {
    const native = port('# Project Atlas\nArtifact demo-0042 is maintained here.');
    vi.mocked(native.searchBlocks).mockResolvedValue([
      {
        id: '20260820-block',
        notebookId: '20260820-book',
        path: '/Project Atlas.sy',
        content: 'Artifact demo-0042 is maintained here.',
      },
    ]);
    const repository = createSiyuanRlmRepository(native);

    const [exact] = await repository.search(scope, 'what is authoritative for artifact demo-0042?');
    const [repeated] = await repository.search(
      scope,
      'compare artifact demo-0042 with record DEMO-0042',
    );
    const [ordinary] = await repository.search(scope, 'what is authoritative for this project?');
    const [partial] = await repository.search(
      scope,
      'what is authoritative for artifact demo-004?',
    );
    const [ambiguous] = await repository.search(
      scope,
      'compare artifact demo-0042 with record demo-0043',
    );

    expect(exact?.score).toBe(3_000_000_020);
    expect(repeated?.score).toBe(3_000_000_020);
    expect(ordinary?.score).toBe(20);
    expect(partial?.score).toBe(20);
    expect(ambiguous?.score).toBe(20);
    expect(native.searchBlocks).toHaveBeenNthCalledWith(1, 'project-1', 'demo-0042', 20);
    expect(native.searchBlocks).toHaveBeenNthCalledWith(2, 'project-1', 'demo-0042', 20);
    expect(native.searchBlocks).toHaveBeenNthCalledWith(
      3,
      'project-1',
      'what is authoritative for this project?',
      20,
    );
    expect(native.searchBlocks).toHaveBeenNthCalledWith(4, 'project-1', 'demo-004', 20);
    expect(native.searchBlocks).toHaveBeenNthCalledWith(
      5,
      'project-1',
      'compare artifact demo-0042 with record demo-0043',
      20,
    );
  });

  it('does not trust summary-only identifier text for authoritative ranking', async () => {
    const native = port('# Project Atlas\nNo structured identifier is present.');
    vi.mocked(native.searchBlocks).mockResolvedValue([
      {
        id: '20260820-block',
        notebookId: '20260820-book',
        path: '/Project Atlas.sy',
        content: 'Artifact demo-0042 is present only in the summary.',
      },
    ]);
    const repository = createSiyuanRlmRepository(native);

    const [hit] = await repository.search(scope, 'what is authoritative for artifact demo-0042?');

    expect(hit?.score).toBe(20);
  });

  it('does not issue authority for malformed, duplicate, or cross-notebook results', async () => {
    const native: SiyuanRlmPort = {
      searchBlocks: vi.fn(async () => [
        { id: '../escape', notebookId: 'book', path: '/bad.sy', content: 'bad' },
        { id: 'block-1', notebookId: 'book-1', path: '/one.sy', content: 'one' },
        { id: 'block-1', notebookId: 'book-1', path: '/one.sy', content: 'duplicate' },
        { id: 'block-2', notebookId: 'book-2', path: '/two.sy', content: 'two' },
      ]),
      getBlock: vi.fn(async (_projectId, id) => ({
        id,
        notebookId: id === 'block-1' ? 'wrong-book' : 'book-2',
        path: '/value.sy',
        markdown: 'bounded markdown',
      })),
      listInboundBacklinks: vi.fn(async () => []),
    };
    const repository = createSiyuanRlmRepository(native);
    await expect(repository.search(scope, 'bounded')).resolves.toHaveLength(1);
  });

  it('rejects cross-project scope and a forged pointer that was never issued', async () => {
    const repository = createSiyuanRlmRepository(port());
    const hits = await repository.search(scope, 'atlas');
    const record = await repository.getRecord(hits[0]!.recordId);
    expect(record).toBeDefined();
    await expect(repository.canOpen(record!, { ...scope, projectId: 'project-2' })).resolves.toBe(
      false,
    );

    const source = await repository.readSource(record!);
    const forged = createContextPointer({
      ...hits[0]!.pointer,
      id: `ptr:${record!.id}:0:1`,
      byteStart: 0,
      byteEnd: 1,
    });
    expect(await repository.validatePointer!(forged, record!, source!, scope)).toBe(false);
  });

  it('authorizes issued SiYuan pointers without reloading source bytes', async () => {
    const native = port();
    const getBlock = vi.spyOn(native, 'getBlock');
    const repository = createSiyuanRlmRepository(native);
    const [hit] = await repository.search(scope, 'atlas');
    const record = await repository.getRecord(hit!.recordId);
    expect(record).toBeDefined();
    const source = await repository.readSource(record!);
    const item = {
      record: record!,
      pointer: hit!.pointer,
      preview: hit!.preview,
      score: hit!.score,
    };
    expect(repository.issuePointers!([item], scope)).toBe(true);
    const readsAfterIssue = getBlock.mock.calls.length;
    const forged = createContextPointer({
      ...hit!.pointer,
      id: `ptr:${record!.id}:0:1`,
      byteStart: 0,
      byteEnd: 1,
    });

    expect(repository.authorizePointer!(forged, record!, scope)).toBe(false);
    expect(repository.authorizePointer!(hit!.pointer, record!, scope)).toBe(true);
    expect(getBlock).toHaveBeenCalledTimes(readsAfterIssue);
    expect(await repository.validatePointer!(hit!.pointer, record!, source!, scope)).toBe(true);
  });

  it('rehydrates an exact persisted record id after a new repository receives its scope', async () => {
    const native = port();
    const first = createSiyuanRlmRepository(native);
    const [hit] = await first.search(scope, 'atlas');

    const restarted = createSiyuanRlmRepository(native);
    await expect(restarted.getRecord(hit!.recordId)).resolves.toBeUndefined();
    await restarted.listRecords(scope);
    await expect(restarted.getRecord(hit!.recordId)).resolves.toMatchObject({
      id: hit!.recordId,
      projectId: 'project-1',
      sourceId: '20260820-block',
    });
  });

  it('reports source_stale when SiYuan changes after pointer issuance', async () => {
    let markdown = 'version one';
    const native = port();
    vi.mocked(native.getBlock).mockImplementation(async (_projectId, id) => ({
      id,
      notebookId: '20260820-book',
      path: '/Project Atlas.sy',
      markdown,
    }));
    const service = createContextQueryService({ repository: createSiyuanRlmRepository(native) });
    const found = await service.search({ scope, query: 'version' });
    markdown = 'version two';
    await expect(service.open({ scope, pointer: found.items[0]!.pointer })).rejects.toEqual(
      expect.objectContaining<Partial<ContextQueryError>>({ code: 'source_stale' }),
    );
  });

  it('uses only verified native relations and never substitutes notebook neighbors', async () => {
    const native = port();
    vi.mocked(native.searchBlocks).mockResolvedValue([
      {
        id: 'source-block',
        notebookId: 'shared-book',
        path: '/source.sy',
        content: 'source',
      },
      {
        id: 'unrelated-block',
        notebookId: 'shared-book',
        path: '/unrelated.sy',
        content: 'unrelated',
      },
    ]);
    vi.mocked(native.listInboundBacklinks!).mockResolvedValue([
      'target-block',
      'missing-block',
      'backlink-block',
      'target-block',
    ]);
    vi.mocked(native.getBlock).mockImplementation(async (projectId, id) => ({
      id: id === 'missing-block' ? 'different-block' : id,
      notebookId:
        id === 'target-block'
          ? 'other-project-notebook'
          : projectId === 'project-1'
            ? 'shared-book'
            : 'other-book',
      path: `/${id}.sy`,
      markdown: `authority:${id}`,
    }));
    const repository = createSiyuanRlmRepository(native);
    const hits = await repository.search(scope, 'source');
    const source = hits.find((hit) => hit.recordId.endsWith(':source-block'))!;

    await expect(repository.relatedRecordIds!(source.recordId)).resolves.toEqual([
      expect.stringMatching(/:target-block$/u),
      expect.stringMatching(/:backlink-block$/u),
    ]);
    expect(native.listInboundBacklinks).toHaveBeenCalledExactlyOnceWith(
      'project-1',
      'source-block',
    );
    expect(native.getBlock).toHaveBeenCalledWith('project-1', 'target-block');
    expect(native.getBlock).toHaveBeenCalledWith('project-1', 'backlink-block');
    expect(native.getBlock).toHaveBeenCalledWith('project-1', 'missing-block');
    expect(await repository.relatedRecordIds!(source.recordId)).not.toContain(
      expect.stringMatching(/:unrelated-block$/u),
    );
  });

  it.each(['search', 'read', 'related-source', 'backlinks'] as const)(
    'preserves cancellation when the %s transport rejects',
    async (operation) => {
      const native = port();
      const repository = createSiyuanRlmRepository(native);
      const [hit] = await repository.search(scope, 'source');
      const record = await repository.getRecord(hit!.recordId);
      const controller = new AbortController();
      const rejectAfterCancellation = async () => {
        controller.abort('owner_cancelled');
        throw new Error('siyuan_transport_unavailable');
      };
      if (operation === 'search') {
        vi.mocked(native.searchBlocks).mockImplementation(rejectAfterCancellation);
      } else if (operation === 'backlinks') {
        vi.mocked(native.listInboundBacklinks!).mockImplementation(rejectAfterCancellation);
      } else {
        vi.mocked(native.getBlock).mockImplementation(rejectAfterCancellation);
      }
      const result = operation === 'search'
        ? repository.search(scope, 'source', controller.signal)
        : operation === 'read'
          ? repository.readSource(record!, controller.signal)
          : repository.relatedRecordIds!(hit!.recordId, controller.signal);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    },
  );

  it('retains optional-source empty and missing fallbacks for uncancelled failures', async () => {
    const native = port();
    const repository = createSiyuanRlmRepository(native);
    const [hit] = await repository.search(scope, 'source');
    const record = await repository.getRecord(hit!.recordId);
    vi.mocked(native.searchBlocks).mockRejectedValue(new Error('siyuan_transport_unavailable'));
    await expect(repository.search(scope, 'source')).resolves.toEqual([]);
    vi.mocked(native.getBlock).mockRejectedValue(new Error('siyuan_transport_unavailable'));
    await expect(repository.readSource(record!)).resolves.toBeUndefined();
  });

  it('fails closed when the typed relation route is unavailable', async () => {
    const native = port();
    vi.mocked(native.listInboundBacklinks!).mockRejectedValue(
      new Error('siyuan_transport_unavailable'),
    );
    const repository = createSiyuanRlmRepository(native);
    const [hit] = await repository.search(scope, 'source');

    await expect(repository.relatedRecordIds!(hit!.recordId)).resolves.toEqual([]);

    const legacyPort = port();
    delete legacyPort.listInboundBacklinks;
    const legacyRepository = createSiyuanRlmRepository(legacyPort);
    const [legacyHit] = await legacyRepository.search(scope, 'source');
    await expect(legacyRepository.relatedRecordIds!(legacyHit!.recordId)).resolves.toEqual([]);
  });

  it('skips stale roots, verifies 21 records, and reports a 20-item service page as truncated', async () => {
    const native = port();
    vi.mocked(native.listInboundBacklinks!).mockResolvedValue([
      ...Array.from({ length: 5 }, (_, index) => `missing-${index}`),
      ...Array.from({ length: 25 }, (_, index) => `target-${index}`),
    ]);
    vi.mocked(native.getBlock).mockImplementation(async (_projectId, id) => ({
      id: id.startsWith('missing-') ? `stale-${id}` : id,
      notebookId: '20260820-book',
      path: `/${id}.sy`,
      markdown: `authority:${id}`,
    }));
    const repository = createSiyuanRlmRepository(native);
    const [hit] = await repository.search(scope, 'source');
    vi.mocked(native.getBlock).mockClear();
    const service = createContextQueryService({ repository });

    const related = await service.related({ scope, recordId: hit!.recordId, limit: 20 });
    expect(related.items).toHaveLength(20);
    expect(related.truncated).toBe(true);
    expect(native.getBlock).toHaveBeenCalledWith('project-1', 'missing-0');
    expect(native.getBlock).toHaveBeenCalledWith('project-1', 'target-20');
    expect(native.getBlock).not.toHaveBeenCalledWith('project-1', 'target-21');
  });
});

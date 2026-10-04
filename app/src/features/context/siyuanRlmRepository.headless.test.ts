import { describe, expect, it, vi } from 'vitest';
import {
  createContextQueryService,
  type ContextScope,
} from './contextQueryService';
import {
  createSiyuanRlmRepository,
  type SiyuanRlmBlock,
  type SiyuanRlmPort,
} from './siyuanRlmRepository';

const scope: ContextScope = Object.freeze({
  accountId: 'fixture-account',
  workspaceId: 'fixture-workspace',
  projectId: 'fixture-project',
});

const block: SiyuanRlmBlock = Object.freeze({
  id: 'fixture-block-2026',
  notebookId: 'fixture-notebook-2026',
  path: '/Project Atlas.sy',
  markdown: '# Project Atlas\nThe launch phrase is cobalt fern.\n',
});

function createPort(markdown = block.markdown): SiyuanRlmPort {
  return {
    searchBlocks: vi.fn(async () => [
      {
        id: block.id,
        notebookId: block.notebookId,
        path: block.path,
        content: 'SiYuan search summary for the fixture block.',
      },
    ]),
    getBlock: vi.fn(async (_projectId, id) => ({ ...block, id, markdown })),
    listInboundBacklinks: vi.fn(async () => []),
  };
}

describe('SiYuan RLM headless ContextQueryService compatibility', () => {
  it('keeps the exact block and content version authoritative across search, open, and expand', async () => {
    const markdown = `${'x'.repeat(65_535)}🚀 Exact source fact: cobalt fern.`;
    const native = createPort(markdown);
    const service = createContextQueryService({
      repository: createSiyuanRlmRepository(native),
      limits: { maxOpenBytes: 65_600 },
    });

    const found = await service.search({ scope, query: 'cobalt fern' });
    expect(found.items).toHaveLength(1);
    const item = found.items[0]!;
    expect(item.record).toMatchObject({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      sourceKind: 'context_note',
      sourceId: block.id,
      parentSourceId: block.notebookId,
      contentRef: `siyuan://${block.notebookId}/${block.id}`,
      trustLevel: 'app_verified',
    });
    expect(item.pointer).toMatchObject({
      recordId: item.record.id,
      id: `ptr:${item.record.id}:0:65535`,
      byteStart: 0,
      byteEnd: 65_535,
      contentHash: item.record.contentHash,
      sourceVersion: `siyuan:3.8.1:sha256:${item.record.contentHash}`,
    });

    const opened = await service.open({ scope, pointer: item.pointer });
    expect(opened.status).toBe('current');
    expect(opened.record).toEqual(item.record);
    expect(opened.text).toBe('x'.repeat(65_535));
    expect(opened.pointer.contentHash).toBe(item.pointer.contentHash);
    expect(opened.pointer.sourceVersion).toBe(item.pointer.sourceVersion);

    const expanded = await service.expand({
      scope,
      pointer: item.pointer,
      beforeBytes: 24,
      afterBytes: 40,
    });
    expect(expanded.status).toBe('current');
    expect(expanded.record).toEqual(item.record);
    expect(expanded.text).toContain('🚀 Exact source fact: cobalt fern.');
    expect(expanded.pointer.contentHash).toBe(item.pointer.contentHash);
    expect(expanded.pointer.sourceVersion).toBe(item.pointer.sourceVersion);
    expect(native.searchBlocks).toHaveBeenCalledWith(scope.projectId, 'cobalt fern', 20);
    expect(vi.mocked(native.getBlock).mock.calls.every(([projectId, id]) =>
      projectId === scope.projectId && id === block.id,
    )).toBe(true);
  });

  it('returns a truthful empty search result without manufacturing a block pointer', async () => {
    const native = createPort();
    vi.mocked(native.searchBlocks).mockResolvedValue([]);
    const service = createContextQueryService({
      repository: createSiyuanRlmRepository(native),
    });

    await expect(service.search({ scope, query: 'no matching block' })).resolves.toMatchObject({
      items: [],
      truncated: false,
      indexAvailable: true,
      stale: false,
    });
    expect(native.getBlock).not.toHaveBeenCalled();
  });

  it('rejects stale block revisions and foreign-project opens for an issued pointer', async () => {
    let markdown = 'Version one: cobalt fern.';
    const native = createPort();
    vi.mocked(native.getBlock).mockImplementation(async (_projectId, id) => ({
      ...block,
      id,
      markdown,
    }));
    const service = createContextQueryService({
      repository: createSiyuanRlmRepository(native),
    });
    const found = await service.search({ scope, query: 'cobalt fern' });
    const pointer = found.items[0]!.pointer;

    await expect(
      service.open({ scope: { ...scope, projectId: 'foreign-project' }, pointer }),
    ).rejects.toMatchObject({ code: 'scope_denied' });

    markdown = 'Version two: cobalt fern.';
    await expect(service.open({ scope, pointer })).rejects.toMatchObject({ code: 'source_stale' });

    let expandedMarkdown = 'Version one: cobalt fern.';
    const expandedPort = createPort();
    vi.mocked(expandedPort.getBlock).mockImplementation(async (_projectId, id) => ({
      ...block,
      id,
      markdown: expandedMarkdown,
    }));
    const expandedService = createContextQueryService({
      repository: createSiyuanRlmRepository(expandedPort),
    });
    const expandedPointer = (await expandedService.search({ scope, query: 'cobalt fern' }))
      .items[0]!.pointer;
    expandedMarkdown = 'Version two: cobalt fern.';
    await expect(
      expandedService.expand({ scope, pointer: expandedPointer, afterBytes: 16 }),
    ).rejects.toMatchObject({ code: 'source_stale' });
  });

  it.each(['search', 'open', 'expand'] as const)(
    'preserves cancellation when SiYuan %s is in flight',
    async (operation) => {
      const controller = new AbortController();
      let cancelOnRead = false;
      const native = createPort();
      vi.mocked(native.searchBlocks).mockImplementation(async () => {
        if (operation === 'search') {
          controller.abort('fixture_cancelled');
          throw new Error('native transport cancelled');
        }
        return [
          {
            id: block.id,
            notebookId: block.notebookId,
            path: block.path,
            content: 'fixture summary',
          },
        ];
      });
      vi.mocked(native.getBlock).mockImplementation(async (_projectId, id) => {
        if (cancelOnRead) {
          controller.abort('fixture_cancelled');
          throw new Error('native transport cancelled');
        }
        return { ...block, id };
      });
      const service = createContextQueryService({
        repository: createSiyuanRlmRepository(native),
      });

      if (operation === 'search') {
        await expect(
          service.search({ scope, query: 'cobalt fern', signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        return;
      }

      const found = await service.search({ scope, query: 'cobalt fern' });
      const pointer = found.items[0]!.pointer;
      cancelOnRead = true;
      const request = operation === 'open'
        ? service.open({ scope, pointer, signal: controller.signal })
        : service.expand({ scope, pointer, afterBytes: 8, signal: controller.signal });
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    },
  );
});

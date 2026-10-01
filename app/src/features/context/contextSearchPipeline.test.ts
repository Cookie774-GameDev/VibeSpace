import { describe, expect, it, vi } from 'vitest';
import {
  ContextSearchPipelineError,
  createContextSearchPipeline,
  createTauriContextSearchIndexPort,
  type ContextProgressiveSearchResult,
} from './contextSearchPipeline';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function result(id: string, score: number): ContextProgressiveSearchResult {
  return {
    documentId: id,
    title: `Title ${id}`,
    path: `notes/${id}.md`,
    sourceType: 'local_file',
    excerpt: `Excerpt ${id}`,
    matchReason: 'content',
    updatedAt: 100,
    score,
  };
}

describe('progressive Context search', () => {
  it('emits quick, full-text, then semantically reranked stages in order', async () => {
    const lexical = vi.fn(async ({ mode }: { mode: 'quick' | 'full_text' }) =>
      mode === 'quick' ? [result('a', 3)] : [result('a', 4), result('b', 5)],
    );
    const semantic = vi.fn(async () => [
      { id: 'a', score: 0.2 },
      { id: 'b', score: 0.99 },
    ]);
    const updates: Array<{ stage: string; ids: string[]; complete: boolean }> = [];
    const final = await createContextSearchPipeline({ lexical, semantic }).search(
      {
        accountId: 'account-1',
        mapId: 'map-1',
        query: 'release approval',
        limit: 10,
      },
      (update) =>
        updates.push({
          stage: update.stage,
          ids: update.results.map(({ documentId }) => documentId),
          complete: update.complete,
        }),
    );

    expect(updates).toEqual([
      { stage: 'quick', ids: ['a'], complete: false },
      { stage: 'full_text', ids: ['b', 'a'], complete: false },
      { stage: 'semantic', ids: ['b', 'a'], complete: true },
    ]);
    expect(final).toEqual(expect.objectContaining({ stage: 'semantic', complete: true }));
    expect(lexical.mock.calls.map(([call]) => call.mode)).toEqual(['quick', 'full_text']);
    expect(semantic).toHaveBeenCalledTimes(1);
  });

  it('returns full-text as the final stage when semantic search is unavailable', async () => {
    const updates: string[] = [];
    const final = await createContextSearchPipeline({
      lexical: async ({ mode }) => [result(mode === 'quick' ? 'quick' : 'full', 1)],
    }).search({ accountId: 'account-1', mapId: 'map-1', query: 'auth', limit: 5 }, ({ stage }) =>
      updates.push(stage),
    );
    expect(updates).toEqual(['quick', 'full_text']);
    expect(final).toMatchObject({ stage: 'full_text', complete: true });
  });

  it('cancels an executor that ignores AbortSignal without publishing stale results', async () => {
    let finish!: (value: ContextProgressiveSearchResult[]) => void;
    const lexical = vi.fn(
      async () =>
        await new Promise<ContextProgressiveSearchResult[]>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const update = vi.fn();
    const pending = createContextSearchPipeline({ lexical }).search(
      { accountId: 'account-1', mapId: 'map-1', query: 'cancel', limit: 5 },
      update,
      controller.signal,
    );
    await vi.waitFor(() => expect(lexical).toHaveBeenCalledTimes(1));
    controller.abort('superseded');
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    finish([result('late', 1)]);
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
  });

  it('suppresses a late semantic stage after full-text was already published', async () => {
    let finishSemantic!: (value: Array<{ id: string; score: number }>) => void;
    const controller = new AbortController();
    const updates: string[] = [];
    const semantic = vi.fn(
      async () =>
        await new Promise<Array<{ id: string; score: number }>>((resolve) => {
          finishSemantic = resolve;
        }),
    );
    const pending = createContextSearchPipeline({
      lexical: async ({ mode }) => [result(mode, 1)],
      semantic,
    }).search(
      { accountId: 'account-1', mapId: 'map-1', query: 'cancel semantic', limit: 5 },
      ({ stage }) => updates.push(stage),
      controller.signal,
    );
    await vi.waitFor(() => expect(semantic).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    finishSemantic([{ id: 'full_text', score: 1 }]);
    await Promise.resolve();
    expect(updates).toEqual(['quick', 'full_text']);
  });

  it('keeps full-text results when optional semantic ranking fails', async () => {
    const updates: Array<{ stage: string; complete: boolean }> = [];
    const final = await createContextSearchPipeline({
      lexical: async ({ mode }) => [result(mode, 1)],
      semantic: async () => {
        throw new Error('provider unavailable');
      },
    }).search(
      { accountId: 'account-1', mapId: 'map-1', query: 'fallback', limit: 5 },
      ({ stage, complete }) => updates.push({ stage, complete }),
    );
    expect(updates).toEqual([
      { stage: 'quick', complete: false },
      { stage: 'full_text', complete: false },
      { stage: 'full_text', complete: true },
    ]);
    expect(final).toMatchObject({ stage: 'full_text', complete: true });
  });

  it('keeps full-text results when semantic output is malformed', async () => {
    const final = await createContextSearchPipeline({
      lexical: async ({ mode }) => [result(mode, 1)],
      semantic: async () => [{ id: 'bad', score: 'not-a-number' }],
    }).search({ accountId: 'account-1', mapId: 'map-1', query: 'fallback', limit: 5 }, () => {});
    expect(final).toMatchObject({ stage: 'full_text', complete: true });
  });

  it('filters unknown semantic IDs without displacing lexical candidates', async () => {
    const lexicalResults = Array.from({ length: 5 }, (_, index) =>
      result(`known-${index}`, 5 - index),
    );
    const final = await createContextSearchPipeline({
      lexical: async () => lexicalResults,
      semantic: async () => [
        ...Array.from({ length: 95 }, (_, index) => ({
          id: `unknown-${index}`,
          score: 100 - index,
        })),
        { id: 'known-4', score: 1 },
      ],
    }).search({ accountId: 'account-1', mapId: 'map-1', query: 'known', limit: 5 }, () => {});
    expect(final.results).toHaveLength(5);
    expect(final.results.map(({ documentId }) => documentId).sort()).toEqual(
      lexicalResults.map(({ documentId }) => documentId).sort(),
    );
  });

  it('freezes and limits every published result array', async () => {
    const updates: Array<readonly Readonly<ContextProgressiveSearchResult>[]> = [];
    await createContextSearchPipeline({
      lexical: async () => Array.from({ length: 10 }, (_, index) => result(`r-${index}`, index)),
    }).search(
      { accountId: 'account-1', mapId: 'map-1', query: 'bounded', limit: 3 },
      ({ results }) => updates.push(results),
    );
    expect(updates.map((results) => results.length)).toEqual([3, 3]);
    expect(updates.every(Object.isFrozen)).toBe(true);
  });

  it('rejects semantic accessors without invoking them', async () => {
    const getter = vi.fn(() => 'a');
    const semanticResult = Object.defineProperties(
      {},
      {
        id: { enumerable: true, get: getter },
        score: { enumerable: true, value: 1 },
      },
    );
    await expect(
      createContextSearchPipeline({
        lexical: async ({ mode }) => [result(mode, 1)],
        semantic: async () => [semanticResult],
      }).search(
        { accountId: 'account-1', mapId: 'map-1', query: 'safe boundary', limit: 5 },
        () => {},
      ),
    ).resolves.toMatchObject({ stage: 'full_text', complete: true });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects outer array accessors without invoking them', async () => {
    const getter = vi.fn(() => result('a', 1));
    const unsafe = [] as ContextProgressiveSearchResult[];
    Object.defineProperty(unsafe, '0', {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    unsafe.length = 1;
    await expect(
      createContextSearchPipeline({ lexical: async () => unsafe }).search(
        { accountId: 'account-1', mapId: 'map-1', query: 'safe array', limit: 5 },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'invalid_result' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects malformed inputs and bridge results at the pipeline boundary', async () => {
    const pipeline = createContextSearchPipeline({
      lexical: async () => [{ ...result('a', 1), path: '../escape.md' }],
    });
    await expect(
      pipeline.search({ accountId: 'account-1', mapId: 'map-1', query: 'x', limit: 5 }, () => {}),
    ).rejects.toBeInstanceOf(ContextSearchPipelineError);
    await expect(
      pipeline.search({ accountId: 'account-1', mapId: 'map-1', query: '', limit: 5 }, () => {}),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('native Context search index port', () => {
  it('uses exact account/map scopes and document payloads for mutations', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        affectedDocuments: 1,
        status: {
          documentCount: 1,
          indexId: 'index-1',
          engine: 'tantivy-0.22.1',
          schemaVersion: 1,
          recoveredCorruption: false,
          needsRebuild: false,
        },
      })
      .mockResolvedValueOnce({
        affectedDocuments: 1,
        status: {
          documentCount: 0,
          indexId: 'index-1',
          engine: 'tantivy-0.22.1',
          schemaVersion: 1,
          recoveredCorruption: false,
          needsRebuild: false,
        },
      });
    const port = createTauriContextSearchIndexPort();
    const document = {
      documentId: 'node-1',
      sourceId: 'node-1',
      title: 'one.txt',
      path: 'one.txt',
      sourceType: 'local_file',
      body: 'content',
      tags: [],
      properties: {},
      updatedAt: 10,
      contentHash: 'a'.repeat(64),
    };

    await expect(port.replaceDocuments('account-1', 'map-1', [document])).resolves.toEqual({
      affectedDocuments: 1,
      documentCount: 1,
    });
    await expect(port.deleteDocuments('account-1', 'map-1', ['node-1'])).resolves.toEqual({
      affectedDocuments: 1,
      documentCount: 0,
    });
    expect(invoke).toHaveBeenNthCalledWith(1, 'context_search_replace_documents', {
      request: { accountId: 'account-1', mapId: 'map-1', documents: [document] },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'context_search_delete_documents', {
      request: { accountId: 'account-1', mapId: 'map-1', documentIds: ['node-1'] },
    });
  });

  it('rejects malformed native mutation and status responses', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue({ affectedDocuments: 1, status: { documentCount: -1 } });
    await expect(
      createTauriContextSearchIndexPort().replaceDocuments('account-1', 'map-1', []),
    ).rejects.toThrow('context_search_index_response_invalid');
  });
});

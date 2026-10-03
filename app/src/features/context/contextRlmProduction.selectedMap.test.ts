// @vitest-environment node
import {beforeEach, describe, expect, it, vi} from 'vitest';
const io = vi.hoisted(() => ({hash: '', selectedOnly: true, count: 1, status: 'healthy', queries: 0}));
const content = 'saffron evidence source';
vi.mock('@/features/context/contextPersistence', async original => ({
  ...await original<typeof import('@/features/context/contextPersistence')>(),
  loadPersistedContextMaps: async () => ['map-a', ...(io.selectedOnly ? [] : ['map-b'])].map(id => ({
    id, projectId: 'project', rootDir: 'D:/disposable', status: 'active', sourceType: 'local_folder', updatedAt: 1,
    tree: {nodes: Array.from({length: io.count}, (_, i) => ({id: id + '-node' + (i ? '-' + i : ''), kind: 'file', title: id + (i ? '-' + i : '') + '.txt', summary: '', path: 'D:/disposable/' + id + (i ? '-' + i : '') + '.txt'}))},
  })),
}));
vi.mock('@/lib/fs', async original => ({...await original<typeof import('@/lib/fs')>(),
  statProjectPath: async (path: string, sha: boolean) => ({ok: true, path, kind: 'file', size: content.length,
    createdMs: 1, modifiedMs: 1, ...(sha ? {sha256: 'sha256:' + io.hash} : {})}),
  readTextFileSample: async (path: string) => ({ok: true, path, content}),
}));
vi.mock('@/features/context/contextSearchPipeline', async original => ({
  ...await original<typeof import('@/features/context/contextSearchPipeline')>(),
  createTauriContextSearchIndexPort: () => ({status: async () => {if (io.status === 'throw') throw new Error('private native failure'); return {documentCount: io.status === 'empty' ? 0 : 1, needsRebuild: false};}}),
  createTauriContextLexicalSearchExecutor: () => async (request: {mapId: string}) =>
    {io.queries++; if (io.status === 'query-throw') throw new Error('private query failure'); return io.status === 'miss' ? [] : [{documentId: request.mapId + '-node', score: 1, excerpt: ''}];},
}));
vi.mock('@/features/context/contextRlmHistory', async original => ({
  ...await original<typeof import('@/features/context/contextRlmHistory')>(), loadProductionRlmHistory: async () => [],
}));
import {createProductionRlmContextTool} from './contextRlmProduction';
import { ContextSearchReadinessError } from './contextSearchReadiness';
import type {RlmContextLease} from './rlmOpenCodeTool';
const scope = {accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeId: 'D:/disposable'};
beforeEach(async () => {io.selectedOnly = true; io.count = 1; io.status = 'healthy'; io.queries = 0; const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  io.hash = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');});

const lease = (): RlmContextLease => ({...scope, sessionId: 'session', selectedMapId: 'map-a', expiresAt: Date.now() + 60_000});
describe('selected-map factory retrieval with synthetic physical/index IO only', () => {
  it('keeps unrelated active maps out of dedicated search', async () => {
    io.selectedOnly = false;
    const result = await createProductionRlmContextTool().execute({operation:'search', query:'saffron evidence'}, lease()) as {items: Array<{record: {title: string}}>};
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.record.title).toBe('map-a.txt');
  });
  it('retains issued pointers for a subsequent selected-map open', async () => {
    const factory = createProductionRlmContextTool();
    const first = await factory.execute({operation:'search', query:'saffron evidence'}, lease()) as {items: Array<{pointer: {id: string}}>};
    const opened = await factory.execute({operation:'open', pointer: first.items[0]!.pointer}, lease()) as {text: string};
    expect(opened.text).toBe(content);
  });
  it('refuses an issued pointer under another selected map', async () => {
    io.selectedOnly = false;
    const factory = createProductionRlmContextTool();
    const first = await factory.execute({operation:'search', query:'saffron evidence'}, lease()) as {items: Array<{pointer: {id: string}}>};
    await expect(factory.execute({operation:'open', pointer: first.items[0]!.pointer}, {...lease(), selectedMapId:'map-b'})).rejects.toThrow();
  });
  it.each(['empty', 'throw'])('reports unusable large selected index %s before lexical IO', async status => {
    io.count = 129; io.status = status;
    await expect(createProductionRlmContextTool().execute({operation:'search', query:'saffron evidence'}, lease())).rejects.toBeInstanceOf(ContextSearchReadinessError);
    expect(io.queries).toBe(0);
  });
  it('preserves healthy indexed lexical misses as genuine empty results', async () => {
    io.count = 129; io.status = 'miss';
    const result = await createProductionRlmContextTool().execute({operation:'search', query:'absent unique token'}, lease()) as {items: unknown[]};
    expect(result.items).toEqual([]); expect(io.queries).toBeGreaterThan(0);
  });
  it('does not hide a native lexical failure as an empty hit set', async () => {
    io.count = 129; io.status = 'query-throw';
    await expect(createProductionRlmContextTool().execute({operation:'search', query:'saffron evidence'}, lease())).rejects.toMatchObject({code:'context_search_failed',reason:'lexical_query_failed'});
  });
  it('aborted callers launch no index query', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createProductionRlmContextTool().execute({operation:'search', query:'saffron evidence'}, lease(), controller.signal)).rejects.toThrow();
    expect(io.queries).toBe(0);
  });
});
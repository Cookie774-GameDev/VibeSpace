// @vitest-environment node
import {beforeEach, describe, expect, it, vi} from 'vitest';
const io = vi.hoisted(() => ({hash: '', selectedOnly: true}));
const content = 'saffron evidence source';
vi.mock('@/features/context/contextPersistence', async original => ({
  ...await original<typeof import('@/features/context/contextPersistence')>(),
  loadPersistedContextMaps: async () => ['map-a', ...(io.selectedOnly ? [] : ['map-b'])].map(id => ({
    id, projectId: 'project', rootDir: 'D:/disposable', status: 'active', sourceType: 'local_folder', updatedAt: 1,
    tree: {nodes: [{id: id + '-node', kind: 'file', title: id + '.txt', summary: '', path: 'D:/disposable/' + id + '.txt'}]},
  })),
}));
vi.mock('@/lib/fs', async original => ({...await original<typeof import('@/lib/fs')>(),
  statProjectPath: async (path: string, sha: boolean) => ({ok: true, path, kind: 'file', size: content.length,
    createdMs: 1, modifiedMs: 1, ...(sha ? {sha256: 'sha256:' + io.hash} : {})}),
  readTextFileSample: async (path: string) => ({ok: true, path, content}),
}));
vi.mock('@/features/context/contextSearchPipeline', async original => ({
  ...await original<typeof import('@/features/context/contextSearchPipeline')>(),
  createTauriContextSearchIndexPort: () => ({status: async () => ({documentCount: 1, needsRebuild: false})}),
  createTauriContextLexicalSearchExecutor: () => async (request: {mapId: string}) =>
    request.mapId === (io.selectedOnly ? 'map-a' : 'map-b') ? [{documentId: request.mapId + '-node', score: 1, excerpt: ''}] : [],
}));
vi.mock('@/features/context/contextRlmHistory', async original => ({
  ...await original<typeof import('@/features/context/contextRlmHistory')>(), loadProductionRlmHistory: async () => [],
}));
import {createProductionRlmContextTool, createProductionContextSourceRevisionPort} from './contextRlmProduction';
import type {RlmContextLease} from './rlmOpenCodeTool';
const scope = {accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeId: 'D:/disposable'};
beforeEach(async () => {io.selectedOnly = true; const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  io.hash = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');});
describe('actual factory after-run proof with synthetic filesystem/index IO only', () => {
  it('retains A proof when unrelated active B cannot escape selected-map retrieval', async () => {
    const lease: RlmContextLease = {...scope, sessionId: 'session', chatId: 'chat', selectedMapId: 'map-a',
      canonicalBinding: {runId: 'run-factory-unavailable', requestId: 'request', attemptNumber: 1},
      contextRevision: 'rlm:1', expiresAt: Date.now() + 60_000};
    const current = () => lease.contextRevision;
    const factory = createProductionRlmContextTool(); const read = createProductionContextSourceRevisionPort();
    const a = await factory.execute({operation: 'search', query: 'saffron evidence'}, lease, undefined, current) as {items: unknown[]};
    expect(a.items).toHaveLength(1);
    const run = {...lease.canonicalBinding!, accountId: scope.accountId, chatId: 'chat'};
    expect(await read(scope, 'map-a', undefined, run, lease.contextRevision, current)).toMatchObject({sourceCount: 1});
    // A second active map is a real federated retrieval source, but cannot mint
    // an evidence capability for the selected map A. No canned handler result.
    io.selectedOnly = false;
    const b = await factory.execute({operation: 'search', query: 'saffron evidence'}, lease, undefined, current) as
      {items: Array<{record: {title?: string}}>};
    expect(b.items.some(item => item.record.title === 'map-b.txt')).toBe(false);
    expect(await read(scope, 'map-a', undefined, run, lease.contextRevision, current)).toMatchObject({sourceCount: 1});
  });
});

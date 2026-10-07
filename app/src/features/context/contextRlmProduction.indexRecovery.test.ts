// @vitest-environment node
// Production-path regression with isolated synthetic disk/index ports; no native acceptance.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ includePending: false, sourceStatus: 'ready', count: 129, mode: 'empty', queries: 0, writes: 0, reads: 0,
  hash: '', documents: new Map<string, { documentId: string; body: string }>(), revision: 1, mapId: 'map-recovery',
  readGate: undefined as Promise<void> | undefined, firstRead: undefined as (() => void) | undefined }));
const content = 'Launch owner Mira. Saffron depot is Delta. Grounded source evidence.';
vi.mock('@/features/context/contextPersistence', async original => ({
  ...await original<typeof import('@/features/context/contextPersistence')>(),
  loadPersistedContextMaps: async () => [{ id: io.mapId, projectId: 'project-a', rootDir: 'C:/fixture',
    status: 'active', sourceType: 'local_folder', sourceStatus: io.sourceStatus, updatedAt: io.revision,
    tree: { nodes: Array.from({ length: io.count }, (_, i) => ({ id: 'node-' + i, kind: 'file',
      title: 'source-' + i + '.txt', summary: '', path: 'source-' + i + '.txt' })) } },
    ...(io.includePending ? [{id:'pending-other',projectId:'project-a',rootDir:'C:/fixture',status:'active',sourceType:'local_folder',sourceStatus:'indexing',updatedAt:2,tree:{nodes:[]}}] : [])],
}));
vi.mock('@/lib/fs', async original => ({ ...await original<typeof import('@/lib/fs')>(),
  statProjectPath: async (path: string, hash: boolean) => io.mode === 'denied'
    ? { ok: false, error: { code: 'permission_denied' } }
    : { ok: true, path, kind: 'file', size: content.length, createdMs: 1, modifiedMs: 1,
      ...(hash ? { sha256: 'sha256:' + io.hash } : {}) },
  readTextFileSample: async (path: string) => { io.reads++;
    if (io.reads === 1) io.firstRead?.(); await io.readGate;
    if (io.mode === 'changed' || (['changed-late', 'cleanup-failed'].includes(io.mode) && io.reads === 66)) io.revision++;
    return { ok: true, path, content }; },
}));
vi.mock('@/features/context/contextSearchPipeline', async original => ({
  ...await original<typeof import('@/features/context/contextSearchPipeline')>(),
  createTauriContextSearchIndexPort: () => ({
    status: async () => { if (io.mode === 'status-failed') throw new Error('private index error');
      return { documentCount: io.documents.size, needsRebuild: io.mode === 'rebuild' }; },
    replaceDocuments: async (_account: string, _map: string, docs: Array<{ documentId: string; body: string }>) => {
      io.writes++; for (const doc of docs) io.documents.set(doc.documentId, doc);
      return { affectedDocuments: docs.length, documentCount: io.documents.size }; },
    deleteDocuments: async (_account: string, _map: string, ids: string[]) => {
      if (io.mode === 'cleanup-failed' && io.documents.size > 0) throw new Error('private cleanup error');
      io.writes++; for (const id of ids) io.documents.delete(id);
      return { affectedDocuments: ids.length, documentCount: io.documents.size }; },
  }),
  createTauriContextLexicalSearchExecutor: () => async (request: { query: string; limit: number }) => {
    io.queries++; return [...io.documents.values()].filter(doc => request.query.toLowerCase().split(/\s+/u)
      .every(term => doc.body.toLowerCase().includes(term))).slice(0, request.limit)
      .map(doc => ({ documentId: doc.documentId, score: 1, excerpt: '' })); },
}));
vi.mock('@/features/context/contextRlmHistory', async original => ({
  ...await original<typeof import('@/features/context/contextRlmHistory')>(), loadProductionRlmHistory: async () => [],
}));
vi.mock('@/features/context/siyuanRlmProduction', () => ({ getProductionSiyuanRlmPort: () => ({
  searchBlocks: async () => [], getBlock: async () => undefined,
}) }));
import { createContextMapRlmRepository, createProductionRlmContextTool } from './contextRlmProduction';
import { writeFileSync } from 'node:fs';
import type { RlmContextLease } from './rlmOpenCodeTool';
const lease = (): RlmContextLease => ({ accountId: 'account-a', workspaceId: 'workspace-a',
  projectId: 'project-a', worktreeId: 'C:/fixture', sessionId: 'session-a', selectedMapId: io.mapId,
  expiresAt: Date.now() + 60_000 });
let sequence = 0;
beforeEach(async () => { io.mapId = 'map-recovery-' + ++sequence;
  io.includePending = false; io.sourceStatus = 'ready'; io.mode = 'empty'; io.documents.clear(); io.queries = 0; io.writes = 0;
  io.reads = 0; io.revision = 1; io.count = 129;
  io.readGate = undefined; io.firstRead = undefined;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  io.hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); });
describe('large selected map confirmed-empty index recovery', () => {
  it('recovers a derivative index and issues a physically verified pointer', async () => {
    const tool = createProductionRlmContextTool();
    const result = await tool.execute({ operation: 'search', query: 'saffron evidence', limit: 3 }, lease()) as
      { items: Array<{ pointer: unknown }> };
    expect(result.items.length).toBeGreaterThan(0); expect(io.documents.size).toBe(129);
    const opened = await tool.execute({ operation: 'open', pointer: result.items[0]!.pointer }, lease());
    expect(opened).toMatchObject({ status: 'current' });
    expect(JSON.stringify(opened)).toContain('Saffron depot is Delta');
  });
  it('returns a truthful no-match for the reported command after recovery', async () => {
    const result = await createProductionRlmContextTool().execute({ operation: 'search',
      query: 'HEY PLEASE RUN RLM TOOLS ON THESE CONTEXT MAPS OKAY', limit: 3 }, lease()) as { items: unknown[] };
    expect(result.items).toEqual([]); expect(io.documents.size).toBe(129); expect(io.queries).toBeGreaterThan(0);
  });
  it.each(['rebuild', 'status-failed'])('does not rewrite an unavailable %s index', async mode => {
    io.mode = mode;
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()))
      .rejects.toMatchObject({ code: 'context_index_unavailable' });
    expect(io.writes).toBe(0); expect(io.reads).toBe(0);
  });
  it('keeps denied source recovery unavailable and sanitized', async () => {
    io.mode = 'denied';
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()))
      .rejects.toMatchObject({ code: 'context_index_unavailable' });
    expect(io.documents.size).toBe(0); expect(io.queries).toBe(0);
  });
  it('does not publish a repair after map membership changes during source IO', async () => {
    io.mode = 'changed';
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()))
      .rejects.toMatchObject({ code: 'context_index_unavailable' });
    expect(io.documents.size).toBe(0); expect(io.queries).toBe(0);
  });
  it('removes only recovery-owned partial commits after a later membership change', async () => {
    io.mode = 'changed-late';
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()))
      .rejects.toMatchObject({ code: 'context_index_unavailable' });
    expect(io.writes).toBeGreaterThan(1); expect(io.documents.size).toBe(0); expect(io.queries).toBe(0);
  });
  it('keeps a failed native cleanup unavailable even through a later factory', async () => {
    io.mode = 'cleanup-failed';
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()))
      .rejects.toMatchObject({ code: 'context_index_unavailable' });
    expect(io.documents.size).toBe(64);
    io.mode = 'healthy';
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()))
      .rejects.toMatchObject({ code: 'context_index_unavailable' });
    expect(io.queries).toBe(0);
  });
  it('preserves a healthy existing index without mutation', async () => {
    io.documents.set('node-0', { documentId: 'node-0', body: content });
    const result = await createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease()) as { items: unknown[] };
    expect(result.items.length).toBeGreaterThan(0); expect(io.writes).toBe(0);
  });
  it('shares recovery without exposing a partial index to concurrent searches', async () => {
    const tool = createProductionRlmContextTool();
    const results = await Promise.all([0, 1].map(() => tool.execute({ operation: 'search',
      query: 'saffron evidence', limit: 3 }, lease())));
    expect(io.documents.size).toBe(129); expect(io.writes).toBe(4);
    for (const result of results) expect((result as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
  it('cancels one subscriber without stopping a live peer recovery', async () => {
    let release!: () => void;
    io.readGate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { io.firstRead = resolve; });
    const tool = createProductionRlmContextTool();
    const cancelled = new AbortController();
    const first = tool.execute({ operation: 'search', query: 'saffron evidence' }, lease(), cancelled.signal);
    const firstOutcome = first.then(() => 'unexpected success', (error: unknown) => error);
    await began;
    const peer = tool.execute({ operation: 'search', query: 'saffron evidence' }, lease());
    await new Promise(resolve => setTimeout(resolve, 0));
    cancelled.abort(); release();
    expect(await firstOutcome).toBeInstanceOf(Error);
    const result = await peer as { items: unknown[] };
    expect(result.items.length).toBeGreaterThan(0); expect(io.documents.size).toBe(129);
  });
  it('aborted callers never begin recovery', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createProductionRlmContextTool().execute({ operation: 'search', query: 'saffron evidence' }, lease(), controller.signal)).rejects.toThrow();
    expect(io.writes).toBe(0); expect(io.reads).toBe(0);
  });
});

describe('bounded parallel lexical retrieval over the same synthetic inputs', () => {
  it('runs independent long-question probes concurrently while retaining verified evidence', async () => {
    let active = 0, maximum = 0, calls = 0;
    const repository = createContextMapRlmRepository({
      loadMaps: async () => [{ id: 'map-a', projectId: 'project-a', rootDir: 'C:/fixture',
        status: 'active', sourceType: 'local_folder', updatedAt: 1,
        tree: { nodes: Array.from({ length: 1993 }, (_, index) => ({ id: 'node-' + index,
          kind: 'file', title: 'source-' + index + '.txt', summary: '', path: 'source-' + index + '.txt' })) } }],
      stat: async path => ({ ok: true, path, kind: 'file', size: content.length,
        createdMs: 1, modifiedMs: 1, sha256: `sha256:${io.hash}` as const }),
      read: async path => ({ ok: true, path, content }),
      indexStatus: async () => ({ documentCount: 1993, needsRebuild: false }),
      lexicalSearch: async () => { active++; calls++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 10)); active--;
        return [{ documentId: 'node-0', score: 1, excerpt: '' }]; },
    });
    const times: number[] = [];
    for (let index = 0; index < 10; index++) {
      const start = performance.now();
      const hits = await repository.search({ accountId: 'account-a', projectId: 'project-a' },
        'Explain saffron depot owner launch readiness and evidence');
      times.push(performance.now() - start);
      expect(hits.length).toBeGreaterThan(0); expect(hits[0]!.preview).toContain('Saffron depot is Delta');
    }
    const sorted = [...times].sort((a, b) => a - b);
    if (process.env.RLM_PROBE_RECEIPT) writeFileSync(process.env.RLM_PROBE_RECEIPT, JSON.stringify({
      scope: 'synthetic 1993-file production repository with 10ms injected lexical-port delay; not native or real map',
      samples: times, p50: sorted[4], p95: sorted[9], lexicalCalls: calls, maximumConcurrentProbes: maximum,
      verifiedFactChecks: 10, runs: 10,
    }, null, 2));
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(4);
  }, 20_000);
});

it.each(['indexing','error'])('fails closed before index reads or repairs for a %s source', async status => {
 io.sourceStatus=status;
 await expect(createProductionRlmContextTool().execute({operation:'search',query:'saffron evidence'},lease())).rejects.toMatchObject({code:'context_index_unavailable'});
 expect(io.reads).toBe(0);expect(io.writes).toBe(0);expect(io.queries).toBe(0);
});

it('keeps a selected ready map usable while another overlapping map is pending',async()=>{
 io.includePending=true;
 const result=await createProductionRlmContextTool().execute({operation:'search',query:'saffron evidence'},lease()) as {items:unknown[]};
 expect(result.items.length).toBeGreaterThan(0);
});

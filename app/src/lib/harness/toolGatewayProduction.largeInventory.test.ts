// @vitest-environment node
// Source integration checks only. IO fixtures are not native acceptance receipts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { ToolGatewayTool } from '@/lib/harness/toolGatewayProtocol';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import { useAuthStore } from '@/stores/auth';
import { bindToolGatewaySessionAuthority, bindToolGatewayObservedExecutionAuthority,
  captureToolGatewayAuthorityClaim, clearToolGatewayAuthorityForTests } from '@/lib/harness/toolGatewayAuthority';
import { createProductionToolGatewayDependencies, installToolGatewayRlmContextPort } from '@/lib/harness/toolGatewayProduction';
import { createFederatedRlmRepository } from '@/features/context/contextRlmHistory';
import type { ContextQueryRepository } from '@/features/context/contextQueryService';
import { createProductionRlmContextTool } from '@/features/context/contextRlmProduction';

const io = vi.hoisted(() => ({ files: new Map<string, string>(), maps: [] as unknown[], reads: 0,
  denied: false, childCalls: 0, stats: 0, hashStats: 0, oversized: false, statGate: undefined as Promise<void> | undefined, eightStats: undefined as (() => void) | undefined }));
vi.mock('@/lib/fs', async (original) => ({
  ...await original<typeof import('@/lib/fs')>(),
  statProjectPath: async (path: string, includeSha: boolean) => {
    io.stats++; if (includeSha) io.hashStats++; if (io.stats === 8) io.eightStats?.(); await io.statGate;
    if (io.denied || !io.files.has(path)) return { ok: false, error: 'permission_denied' };
    const content = io.files.get(path)!;
    if (io.oversized) return { ok: true, path, kind: 'file', size: 2 * 1024 * 1024, createdMs: 1, modifiedMs: 1 };
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return { ok: true, path, kind: 'file', size: new TextEncoder().encode(content).length,
      createdMs: 1, modifiedMs: 1, ...(includeSha ? { sha256: 'sha256:' +
        [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('') } : {}) };
  },
  readTextFileSample: async (path: string) => {
    io.reads++;
    return io.denied || !io.files.has(path) ? { ok: false, error: 'permission_denied' }
      : { ok: true, path, content: io.files.get(path)! };
  },
}));
vi.mock('@/features/context/contextPersistence', async (original) => ({
  ...await original<typeof import('@/features/context/contextPersistence')>(),
  loadPersistedContextMaps: async (projectId: string) => projectId === 'project-a' ? io.maps : [],
}));
vi.mock('@/features/context/contextSearchPipeline', async (original) => ({
  ...await original<typeof import('@/features/context/contextSearchPipeline')>(),
  createTauriContextLexicalSearchExecutor: () => async () => [],
  createTauriContextSearchIndexPort: () => ({ status: async () => ({ documentCount: 0, needsRebuild: false }) }),
}));
vi.mock('@/features/context/contextRlmHistory', async (original) => ({
  ...await original<typeof import('@/features/context/contextRlmHistory')>(),
  loadProductionRlmHistory: async () => [],
}));
vi.mock('@/features/context/siyuanRlmProduction', () => ({ getProductionSiyuanRlmPort: () => ({
  searchBlocks: async () => [], getBlock: async () => undefined,
}) }));
vi.mock('@/lib/ai/adapters/codexRlmBoundChild', () => ({ createRegisteredCodexRlmChild: () =>
  async (request: import('@/features/context/rlmRuntime').RlmChildRequest) => {
    request.signal.throwIfAborted(); io.childCalls++;
    return { answer: request.evidence.map(item => item.text).join('\n'), citations: request.sourcePointers };
  } }));

const root = 'C:\\fixture';
const identity = Object.freeze({ transportConnectionId: 'openai-codex', transportAdapterId: 'codex-app-server',
  upstreamProviderId: 'openai', upstreamModelId: 'gpt-6-luna', providerQualifiedModelId: 'openai/gpt-6-luna',
  authBillingRoute: 'chatgpt-subscription', effort: 'low', fastVariant: 'standard',
  catalogRevision: 'fixture-catalog', observedProviderIdentity: 'openai/gpt-6-luna' });
let runtime: ReturnType<typeof createToolGatewayRuntime>;
let dispose: () => void;
let sequence = 0;
function bind(sessionId = 'session-a', chatId = 'chat-a') {
  const authority = captureToolGatewayAuthorityClaim()!;
  expect(bindToolGatewaySessionAuthority(sessionId, authority, undefined,
    { requestId: 'turn-a', chatId })).toBe(true);
  expect(bindToolGatewayObservedExecutionAuthority(sessionId, authority,
    { executionIdentity: identity, performance: 'quality' })).toBe(true);
}
function call(tool: ToolGatewayTool, args: Record<string, unknown>, signal?: AbortSignal,
  sessionId = 'session-a') {
  return runtime.execute(parseToolGatewayRequest({ protocolVersion: 1,
    requestId: 'request-' + ++sequence, sessionId, messageId: 'turn-a', tool, args,
    directory: root, worktree: root }), signal);
}
beforeEach(async () => {
  clearToolGatewayAuthorityForTests(); io.files.clear(); io.reads = 0; io.denied = false; io.childCalls = 0; io.stats = 0; io.hashStats = 0; io.oversized = false; io.statGate = undefined; io.eightStats = undefined;
  const nodes = Array.from({ length: 2020 }, (_, index) => {
    const file = root + '\\charter-' + index + '.txt';
    io.files.set(file, 'Launch owner Mira. Source ' + index + '.');
    return { id: 'node-' + index, kind: 'file', title: 'charter-' + index + '.txt',
      path: file, summary: '', modifiedAt: 1 };
  });
  io.maps = [
    { id: 'map-a', name: 'Synthetic 2020 files', projectId: 'project-a', rootDir: root,
      status: 'active', sourceType: 'local_folder', updatedAt: 1, tree: { nodes } },
    { id: 'map-note', name: 'Synthetic linked note', projectId: 'project-a', rootDir: root,
      status: 'active', sourceType: 'linked_vibespace_content', updatedAt: 1, tree: { nodes: [
        { id: 'note-1', kind: 'note', title: 'Linked note', summary: 'Bounded note context.', path: root + '\\note.txt' },
      ] } },
  ];
  useAuthStore.setState({ localUserId: 'account-a', cloudSession: null,
    workspaceId: 'workspace-a' as WorkspaceId, projectId: 'project-a' as ProjectId });
  bind(); dispose = installToolGatewayRlmContextPort(createProductionRlmContextTool());
  runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
});
afterEach(() => { dispose?.(); clearToolGatewayAuthorityForTests(); });

describe('production inventory budgets over synthetic 2021 scoped records', () => {
  it('describes the full structural inventory without native hashing', async () => {
    const result = await call('vibespace_context', { operation: 'describe' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ recordCount: 2021 });
    expect(io.stats).toBe(0); expect(io.childCalls).toBe(0);
  });
  it('bounds source and timeline candidate attempts before filling the result page', async () => {
    for (const operation of ['sources', 'timeline']) {
      io.stats = 0; io.hashStats = 0;
      const result = await call('vibespace_context', { operation, limit: 20 });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ truncated: true });
      expect((result.data as { items: unknown[] }).items).toHaveLength(20);
      expect(io.hashStats).toBeLessThanOrEqual(21); expect(io.stats).toBeLessThanOrEqual(42);
    }
    expect(io.childCalls).toBe(0);
  });
  it('returns an explicitly incomplete checkpoint within actual response array bounds', async () => {
    const result = await call('vibespace_context', { operation: 'checkpoint' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ recordCount: 20, truncated: true, complete: false });
    const data = result.data as { recordIds: unknown[]; contentHashes: unknown[] };
    expect(data.recordIds).toHaveLength(20); expect(data.contentHashes).toHaveLength(20);
    expect(io.hashStats).toBeLessThanOrEqual(21); expect(io.stats).toBeLessThanOrEqual(42);
  });
  it('does not scan 2021 denied candidates to fill an empty page', async () => {
    io.denied = true;
    const result = await call('vibespace_context', { operation: 'sources', limit: 20 });
    expect(result).toMatchObject({ ok: true, data: { items: [], truncated: true } });
    expect(io.stats).toBeLessThanOrEqual(21); expect(io.hashStats).toBe(0);
  });
  it('preflights oversized candidates without requesting their full native hashes', async () => {
    io.oversized = true;
    const result = await call('vibespace_context', { operation: 'sources', limit: 20 });
    expect(result).toMatchObject({ ok: true, data: { items: [], truncated: true } });
    expect(io.stats).toBeLessThanOrEqual(21); expect(io.hashStats).toBe(0);
  });
  it('revokes a foreign account before inventory IO', async () => {
    useAuthStore.setState({ localUserId: 'account-b' });
    expect(await call('vibespace_context', { operation: 'sources', limit: 20 }))
      .toMatchObject({ ok: false, code: 'authority_revoked' });
    expect(io.stats).toBe(0); expect(io.childCalls).toBe(0);
  });
  it('keeps named large-map search pointers exact and rejects later source changes', async () => {
    const found = await call('vibespace_context_search', { query: 'Read ' + root + '\\charter-2019.txt', limit: 1 });
    expect(found.ok).toBe(true);
    const pointer = (found.data as { items: { pointer: Record<string, unknown> }[] }).items[0].pointer;
    const opened = await call('vibespace_context_open', { pointer });
    expect(opened.ok).toBe(true); expect(JSON.stringify(opened.data)).toContain('Source 2019');
    const expanded = await call('vibespace_context_expand', { pointer });
    expect(expanded.ok).toBe(true);
    io.files.set(root + '\\charter-2019.txt', 'Launch owner Nora. Source 2019.');
    expect(await call('vibespace_context_open', { pointer })).toMatchObject({ ok: false });
    expect(io.childCalls).toBe(0);
  });
  it('leaves an unpaged history backend unread instead of scanning it for metadata', async () => {
    const fullHistory = vi.fn(async () => { throw new Error('full history scan must not start'); });
    const history: ContextQueryRepository = {
      listRecords: fullHistory, getRecord: async () => undefined,
      search: async () => [], readSource: async () => undefined, canOpen: async () => false,
    };
    const repository = createFederatedRlmRepository([history]);
    const page = await repository.listRecordsPage!({ accountId: 'account-a', projectId: 'project-a' }, 1);
    expect(page).toEqual({ items: [], truncated: true });
    expect(fullHistory).not.toHaveBeenCalled();
    expect(io.stats).toBe(0); expect(io.childCalls).toBe(0);
  });
  it('stops new IO after cancellation while allowing already-started IO to settle', async () => {
    let release!: () => void;
    io.statGate = new Promise<void>(resolve => { release = resolve; });
    const eightStarted = new Promise<void>(resolve => { io.eightStats = resolve; });
    const controller = new AbortController();
    const pending = call('vibespace_context', { operation: 'sources', limit: 20 }, controller.signal);
    await eightStarted; controller.abort(); release();
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' });
    // The first eight native calls are real fixture IO; cancellation cannot recall them.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(io.stats).toBe(8); expect(io.hashStats).toBe(0); expect(io.childCalls).toBe(0);
  });
});


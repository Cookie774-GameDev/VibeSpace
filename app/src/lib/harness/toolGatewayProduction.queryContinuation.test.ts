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
import { createProductionRlmContextTool } from '@/features/context/contextRlmProduction';

const io = vi.hoisted(() => ({ files: new Map<string, string>(), maps: [] as unknown[], reads: 0,
  denied: false, childCalls: 0 }));
vi.mock('@/lib/fs', async (original) => ({
  ...await original<typeof import('@/lib/fs')>(),
  statProjectPath: async (path: string, includeSha: boolean) => {
    if (io.denied || !io.files.has(path)) return { ok: false, error: 'permission_denied' };
    const content = io.files.get(path)!;
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
const path = root + '\\charter.txt';
const content = 'The launch owner is Mira. The depot is North Station.\n';
const identity = Object.freeze({ transportConnectionId: 'openai-codex', transportAdapterId: 'codex-app-server',
  upstreamProviderId: 'openai', upstreamModelId: 'gpt-6-luna', providerQualifiedModelId: 'openai/gpt-6-luna',
  authBillingRoute: 'chatgpt-subscription', effort: 'low', fastVariant: 'standard',
  catalogRevision: 'fixture-catalog', observedProviderIdentity: 'openai/gpt-6-luna' });
let runtime: ReturnType<typeof createToolGatewayRuntime>;
let dispose: () => void;
let sequence = 0;
async function hash(value: string) {
  return 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
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
  clearToolGatewayAuthorityForTests(); io.files.clear(); io.reads = 0; io.denied = false; io.childCalls = 0;
  io.files.set(path, content);
  io.files.set(root + '\\charter2.txt', content + 'Second launch owner record.');
  const shard = 'Address fixture source.';
  io.files.set(root + '\\shard.txt', shard);
  const shards = [{ index: '0', tokenStart: '0', tokenEnd: '16', file: 'shard.txt', contentSha256: await hash(shard) }];
  io.files.set(root + '\\.vibespace-large-address-v1.json', JSON.stringify({ version: 1,
    corpusId: 'fixture-corpus', totalTokens: '16', shardSize: '16', generatedAt: 1, shards,
    contentDigest: await hash(JSON.stringify(shards.map(s => [s.index, s.tokenStart, s.tokenEnd, s.file, s.contentSha256]))) }));
  io.maps = [{ id: 'map-a', name: 'Fixture', projectId: 'project-a', rootDir: root,
    status: 'active', sourceType: 'local_folder', updatedAt: 1, tree: { nodes: [
      { id: 'node-a', kind: 'file', summary: '', title: 'charter.txt', path, sizeBytes: content.length, modifiedAt: 1 },
      { id: 'node-descriptor', kind: 'file', summary: '', title: '.vibespace-large-address-v1.json', path: root + '\\.vibespace-large-address-v1.json' },
      { id: 'node-second', kind: 'file', summary: '', title: 'charter2.txt', path: root + '\\charter2.txt' },
      { id: 'node-virtual', kind: 'root', summary: '', title: 'Virtual group' },
      { id: 'node-shard', kind: 'file', summary: '', title: 'shard.txt', path: root + '\\shard.txt' },
    ] } }];
  useAuthStore.setState({ localUserId: 'account-a', cloudSession: null,
    workspaceId: 'workspace-a' as WorkspaceId, projectId: 'project-a' as ProjectId });
  bind(); dispose = installToolGatewayRlmContextPort(createProductionRlmContextTool());
  runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
});
afterEach(() => { dispose?.(); clearToolGatewayAuthorityForTests(); });

async function firstPage() {
  const result = await call('vibespace_context_search', { query: 'launch owner', limit: 1 });
  expect(result.ok).toBe(true);
  const data = result.data as { items: { pointer: { recordId: string } }[]; continuation?: string };
  expect(data.items).toHaveLength(1); expect(data.continuation).toEqual(expect.any(String));
  return data;
}
describe('production query pagination uses the actual issued search cursor', () => {
  it('resumes the next page without invoking recursive child IO', async () => {
    const first = await firstPage();
    const next = await call('vibespace_context', { operation: 'query', query: 'launch owner',
      limit: 1, continuation: first.continuation });
    expect(next.ok).toBe(true);
    const data = next.data as { items: { pointer: { recordId: string } }[] };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].pointer.recordId).not.toBe(first.items[0].pointer.recordId);
    expect(io.childCalls).toBe(0);
  });
  it('rejects an issued cursor with a changed query', async () => {
    const first = await firstPage();
    expect(await call('vibespace_context', { operation: 'query', query: 'different query',
      continuation: first.continuation })).toMatchObject({ ok: false });
    expect(io.childCalls).toBe(0);
  });
  it('rejects a cursor from a different worktree scope', async () => {
    const first = await firstPage();
    const result = await runtime.execute(parseToolGatewayRequest({ protocolVersion: 1,
      requestId: 'foreign-cursor', sessionId: 'session-a', messageId: 'turn-a',
      tool: 'vibespace_context', directory: 'C:\\foreign', worktree: 'C:\\foreign',
      args: { operation: 'query', query: 'launch owner', continuation: first.continuation } }));
    expect(result.ok).toBe(false); expect(io.childCalls).toBe(0);
  });
  it('rejects a forged cursor without starting a child', async () => {
    expect(await call('vibespace_context', { operation: 'query', query: 'launch owner',
      continuation: 'invented-cursor' })).toMatchObject({ ok: false });
    expect(io.childCalls).toBe(0);
  });
  it('honors cancellation before a real cursor can resume', async () => {
    const first = await firstPage(); const controller = new AbortController(); controller.abort();
    const reads = io.reads;
    expect(await call('vibespace_context', { operation: 'query', query: 'launch owner',
      continuation: first.continuation }, controller.signal)).toMatchObject({ ok: false, code: 'cancelled' });
    expect(io.reads).toBe(reads); expect(io.childCalls).toBe(0);
  });
});


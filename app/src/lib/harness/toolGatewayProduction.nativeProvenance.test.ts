// @vitest-environment node
// Synthetic production-gateway fixture only. This is not a native or user-map receipt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { ToolGatewayTool } from '@/lib/harness/toolGatewayProtocol';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import { clearToolGatewayContextCitationItems, consumeToolGatewayContextCitationItems } from '@/lib/harness/toolGatewayCitations';
import { getActiveContextPersistenceState } from '@/features/context';
import { useAuthStore } from '@/stores/auth';
import {
  bindToolGatewayObservedExecutionAuthority,
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  clearToolGatewayAuthorityForTests,
  releaseToolGatewaySessionAuthority,
  readToolGatewayTurnIdentity,
} from '@/lib/harness/toolGatewayAuthority';
import {
  createProductionToolGatewayDependencies,
  installToolGatewayRlmContextPort,
} from '@/lib/harness/toolGatewayProduction';
import { createProductionRlmContextTool } from '@/features/context/contextRlmProduction';

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  afterChild: undefined as (() => void) | undefined,
  finalMutation: undefined as 'run' | 'foreign-record' | 'span' | undefined,
  maps: [] as unknown[],
  indexStatus: { documentCount: 64, needsRebuild: false },
  indexThrows: false,
  stats: 0,
  reads: 0,
  lexicalCalls: 0,
  childCalls: 0,
  runNonce: 0,
  nativeToolMessageIds: true,
  includeProtectedAttempt: true,
  toolMessageId: "msg_native_fixture",
  turnRequestId: "turn-fixture",
}));

vi.mock('@/lib/fs', async (original) => ({
  ...await original<typeof import('@/lib/fs')>(),
  statProjectPath: async (path: string, includeSha: boolean) => {
    fixture.stats++;
    const content = fixture.files.get(path);
    if (content === undefined) return { ok: false, error: 'permission_denied' };
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    return {
      ok: true,
      path,
      kind: 'file',
      size: bytes.length,
      createdMs: 1,
      modifiedMs: 1,
      ...(includeSha ? { sha256 } : {}),
    };
  },
  readTextFileSample: async (path: string) => {
    fixture.reads++;
    const content = fixture.files.get(path);
    return content === undefined
      ? { ok: false, error: 'permission_denied' }
      : { ok: true, path, content };
  },
}));

vi.mock('@/features/context/contextPersistence', async (original) => ({
  ...await original<typeof import('@/features/context/contextPersistence')>(),
  loadPersistedContextMaps: async (projectId: string) => projectId === 'project-fixture' ? fixture.maps : [],
  getActiveContextPersistenceState: (projectId: string | null) => projectId === 'project-fixture'
    ? ({
        accountId: 'account-fixture',
        projectId: 'project-fixture',
        selectedMapId: 'map-large-fixture',
        maps: fixture.maps,
      } as never)
    : null,
}));

// The production gateway imports persistence through this barrel. Keep its
// selected-map view explicit and assert it below before exercising trace.
vi.mock('@/features/context', async (original) => ({
  ...await original<typeof import('@/features/context')>(),
  loadPersistedContextMaps: async (projectId: string) => projectId === 'project-fixture' ? fixture.maps : [],
  getActiveContextPersistenceState: (projectId: string | null) => projectId === 'project-fixture'
    ? ({ accountId: 'account-fixture', projectId: 'project-fixture', selectedMapId: 'map-large-fixture',
        maps: fixture.maps } as never)
    : null,
}));

vi.mock('@/features/context/contextSearchPipeline', async (original) => ({
  ...await original<typeof import('@/features/context/contextSearchPipeline')>(),
  createTauriContextLexicalSearchExecutor: () => async (request: { query: string; mapId: string }) => {
    fixture.lexicalCalls++;
    if (request.mapId !== 'map-large-fixture' || /quasar-no-match|foreign-only/u.test(request.query)) return [];
    if (!/atlas|steward|reserve|backoff|mira|chen|el(i|ia)n|park/u.test(request.query.toLocaleLowerCase('en-US'))) return [];
    const query = request.query.toLocaleLowerCase('en-US');
    const hits: Array<{ documentId: string; excerpt: string; score: number }> = [];
    if (/steward|mira|chen/u.test(query)) hits.push({ documentId: 'node-charter', excerpt: 'Synthetic Atlas charter hit.', score: 3 });
    if (/reserve|capacity|backoff|elian|park/u.test(query)) hits.push({ documentId: 'node-capacity', excerpt: 'Synthetic Atlas capacity hit.', score: 2 });
    if (/decision|gate/u.test(query)) hits.push({ documentId: 'node-decision', excerpt: 'Synthetic Atlas decision hit.', score: 1 });
    return hits;
  },
  createTauriContextSearchIndexPort: () => ({
    status: async () => {
      if (fixture.indexThrows) throw new Error('fixture index is unavailable');
      return fixture.indexStatus;
    },
  }),
}));

vi.mock('@/features/context/contextRlmHistory', async (original) => ({
  ...await original<typeof import('@/features/context/contextRlmHistory')>(),
  loadProductionRlmHistory: async () => [],
}));

vi.mock('@/features/context/siyuanRlmProduction', () => ({
  getProductionSiyuanRlmPort: () => ({ searchBlocks: async () => [], getBlock: async () => undefined }),
}));

// Keep the actual runtime, child scheduling and terminal receipt. This seam only
// corrupts its final returned object to test the host's result/receipt join.
vi.mock('@/features/context/rlmRuntime', async (original) => {
  const actual = await original<typeof import('@/features/context/rlmRuntime')>();
  return { ...actual, createRlmRuntime: (...args: Parameters<typeof actual.createRlmRuntime>) => {
    const actualRuntime = actual.createRlmRuntime(...args);
    return { ...actualRuntime, investigate: async (...input: Parameters<typeof actualRuntime.investigate>) => {
      const result = await actualRuntime.investigate(...input);
      if (fixture.finalMutation === 'run') return { ...result, trace: { ...result.trace, runId: 'rlm-unrelated-final' } };
      if (fixture.finalMutation === 'foreign-record') return { ...result, citations: result.citations.map(pointer => ({ ...pointer, recordId: 'foreign-record' })) };
      if (fixture.finalMutation === 'span') return { ...result, citations: result.citations.map(pointer => ({ ...pointer, byteEnd: (pointer.byteEnd ?? 0) + 1 })) };
      return result;
    } };
  } };
});

vi.mock('@/lib/ai/adapters/codexRlmBoundChild', () => ({
  createRegisteredCodexRlmChild: () => async (
    request: import('@/features/context/rlmRuntime').RlmChildRequest,
  ) => {
    request.signal.throwIfAborted();
    fixture.childCalls++;
    const afterChild = fixture.afterChild; fixture.afterChild = undefined; afterChild?.();
    return {
      answer: request.evidence.map((item) => item.text).join('\n'),
      citations: request.sourcePointers,
    };
  },
}));

const root = 'C:\\rlm-fixture';
const mapId = 'map-large-fixture';
const corpusId = 'fixture-atlas-corpus';
const sourceContent = {
  charter: 'Project Atlas steward: Mira Chen. Release gate: blue lantern.',
  capacity: 'Atlas reserve ceiling: 48 units. Backoff owner: Elian Park.',
  decision: 'Project Atlas decision log: the recovery gate is blue lantern.',
  addressShard: 'ALPHA BRAVO CHARLIE DELTA',
};
const knownSources = {
  charter: { nodeId: 'node-charter', title: 'atlas-charter.txt', path: `${root}\\atlas-charter.txt` },
  capacity: { nodeId: 'node-capacity', title: 'capacity-register.txt', path: `${root}\\capacity-register.txt` },
  decision: { nodeId: 'node-decision', title: 'decision-log.txt', path: `${root}\\decision-log.txt` },
  descriptor: { nodeId: 'node-address-descriptor', title: '.vibespace-large-address-v1.json', path: `${root}\\.vibespace-large-address-v1.json` },
  addressShard: { nodeId: 'node-address-shard', title: 'address-shard.txt', path: `${root}\\address-shard.txt` },
};

let runtime: ReturnType<typeof createToolGatewayRuntime>;
let disposePort: (() => void) | undefined;
let sequence = 0;

const observedIdentity = Object.freeze({
  transportConnectionId: 'openai-codex',
  transportAdapterId: 'codex-app-server',
  upstreamProviderId: 'openai',
  upstreamModelId: 'gpt-6-luna',
  providerQualifiedModelId: 'openai/gpt-6-luna',
  authBillingRoute: 'chatgpt-subscription',
  effort: 'low',
  fastVariant: 'standard',
  catalogRevision: 'fixture-catalog',
  observedProviderIdentity: 'openai/gpt-6-luna',
});

function bindSession() {
  const authority = captureToolGatewayAuthorityClaim()!;
  expect(bindToolGatewaySessionAuthority('session-fixture', authority, undefined, {
    requestId: fixture.turnRequestId, chatId: 'chat-fixture',
    ...(fixture.nativeToolMessageIds ? { nativeToolMessageIds: true as const } : {}),
    ...(fixture.includeProtectedAttempt ? { protectedAttempt: {
      accountId: 'account-fixture', runId: `provider-attempt-fixture-${fixture.runNonce}`,
      requestId: fixture.turnRequestId, attemptNumber: 1,
    } } : {}),
  })).toBe(true);
  expect(readToolGatewayTurnIdentity('session-fixture', fixture.turnRequestId)).toMatchObject({
    requestId: fixture.turnRequestId, chatId: 'chat-fixture',
  });
  expect(bindToolGatewayObservedExecutionAuthority('session-fixture', authority, {
    executionIdentity: observedIdentity, performance: 'quality',
  })).toBe(true);
}

function gatewayCall(tool: ToolGatewayTool, args: Record<string, unknown>, signal?: AbortSignal) {
  return runtime.execute(parseToolGatewayRequest({
    protocolVersion: 1,
    requestId: `request-${++sequence}`,
    sessionId: 'session-fixture',
    messageId: fixture.toolMessageId,
    tool,
    args,
    directory: root,
    worktree: root,
  }), signal);
}

async function sha256(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function addressDescriptor() {
  const shard = {
    index: '0',
    tokenStart: '0',
    tokenEnd: '4',
    file: 'address-shard.txt',
    contentSha256: await sha256(sourceContent.addressShard),
  };
  const contentDigest = await sha256(JSON.stringify([[
    shard.index, shard.tokenStart, shard.tokenEnd, shard.file, shard.contentSha256,
  ]]));
  return JSON.stringify({
    version: 1,
    corpusId,
    totalTokens: '4',
    shardSize: '4',
    contentDigest,
    generatedAt: 1,
    shards: [shard],
  });
}

async function initializeFixture() {
  fixture.runNonce += 1;
  fixture.files.clear();
  fixture.stats = 0;
  fixture.reads = 0;
  fixture.lexicalCalls = 0;
  fixture.childCalls = 0;
  fixture.indexStatus = { documentCount: 64, needsRebuild: false };
  fixture.indexThrows = false;
  const descriptor = await addressDescriptor();
  const physical = [
    { ...knownSources.charter, content: sourceContent.charter },
    { ...knownSources.capacity, content: sourceContent.capacity },
    { ...knownSources.decision, content: sourceContent.decision },
    { ...knownSources.descriptor, content: descriptor },
    { ...knownSources.addressShard, content: sourceContent.addressShard },
  ];
  for (const file of physical) fixture.files.set(file.path, file.content);
  const nodes = physical.map((file) => ({
    id: file.nodeId,
    kind: 'file',
    title: file.title,
    summary: '',
    path: file.path,
    modifiedAt: 1,
  }));
  for (let index = 0; index < 59; index++) {
    const path = `${root}\\filler-${index}.txt`;
    fixture.files.set(path, `Synthetic filler record ${index}.`);
    nodes.push({ id: `node-filler-${index}`, kind: 'file', title: `filler-${index}.txt`, summary: '', path, modifiedAt: 1 });
  }
  fixture.maps = [{
    id: mapId,
    name: 'Synthetic64 source fixture',
    projectId: 'project-fixture',
    rootDir: root,
    status: 'active',
    sourceType: 'local_folder',
    updatedAt: 1,
    tree: { nodes },
  }];
  useAuthStore.setState({
    localUserId: 'account-fixture',
    cloudSession: null,
    workspaceId: 'workspace-fixture' as WorkspaceId,
    projectId: 'project-fixture' as ProjectId,
  });
  expect(getActiveContextPersistenceState('project-fixture')).toMatchObject({
    accountId: 'account-fixture',
    projectId: 'project-fixture',
    selectedMapId: mapId,
    maps: [expect.objectContaining({ id: mapId, status: 'active' })],
  });
  bindSession();
  disposePort = installToolGatewayRlmContextPort(createProductionRlmContextTool());
  runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
}

describe('joined production gateway provenance under native-message-shaped bindings', () => {
  beforeEach(async () => {
    clearToolGatewayAuthorityForTests();
    clearToolGatewayContextCitationItems();
    fixture.afterChild = undefined;
    fixture.finalMutation = undefined;
    fixture.nativeToolMessageIds = true;
    fixture.includeProtectedAttempt = true;
    fixture.toolMessageId = 'msg_native_fixture';
    fixture.turnRequestId = 'turn-fixture';
    sequence = 0;
    await initializeFixture();
  });
  afterEach(() => { disposePort?.(); disposePort = undefined; clearToolGatewayAuthorityForTests(); });

  function expectCanonical(response: { ok?: boolean; data?: unknown }) {
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ canonicalProvenance: { evidenceUris: expect.any(Array) } });
    const uris = (response.data as { canonicalProvenance: { evidenceUris: string[] } }).canonicalProvenance.evidenceUris;
    expect(uris.length).toBeGreaterThan(0);
    expect(uris.every(uri => uri.startsWith('vibespace:context/evidence/'))).toBe(true);
  }

  it('returns canonical handles for search/open/expand through an actually bound protected tool turn', async () => {
    expect(readToolGatewayTurnIdentity('session-fixture', fixture.toolMessageId)?.protectedAttempt).toBeDefined();
    const search = await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
    expectCanonical(search);
    const pointer = (search.data as { items: Array<{ pointer: unknown }> }).items[0]!.pointer;
    expectCanonical(await gatewayCall('vibespace_context_open', { pointer }));
    expectCanonical(await gatewayCall('vibespace_context_expand', { pointer }));
  });

  it('retains an issued run trace across a later protected turn in the same chat', async () => {
    const investigation = await gatewayCall('vibespace_context', { operation: 'investigate', query: 'Who is the Atlas steward and who owns reserve backoff?' });
    expect(investigation.ok).toBe(true);
    const runId = (investigation.data as { trace: { runId: string } }).trace.runId;
    expect(runId).toMatch(/^rlm-/);
    releaseToolGatewaySessionAuthority('session-fixture');
    fixture.runNonce += 1;
    fixture.turnRequestId = 'followup-fixture';
    fixture.toolMessageId = 'msg_followup_fixture';
    bindSession();
    expect(await gatewayCall('vibespace_context_trace', { runId })).toMatchObject({ ok: true, data: { found: true } });
    expectCanonical(investigation);
  });

  it.each(['run', 'foreign-record', 'span'] as const)('refuses final provenance after the actual result loses its %s join', async (mutation) => {
    fixture.finalMutation = mutation;
    const response = await gatewayCall('vibespace_context', { operation: 'investigate', query: 'Who is the Atlas steward and who owns reserve backoff?' });
    expect(response.ok).toBe(true);
    expect(fixture.childCalls).toBeGreaterThan(0);
    expect(response.data).not.toHaveProperty('canonicalProvenance');
    expect(consumeToolGatewayContextCitationItems('session-fixture')).toEqual([]);
  });

  it('withholds final provenance when actual source bytes change while the child runs', async () => {
    fixture.afterChild = () => { fixture.files.set(knownSources.charter.path, 'Atlas steward: changed after evidence capture.'); };
    const response = await gatewayCall('vibespace_context', { operation: 'investigate', query: 'Who is the Atlas steward and who owns reserve backoff?' });
    expect(fixture.childCalls).toBeGreaterThan(0);
    expect(response.data).not.toHaveProperty('canonicalProvenance');
    expect(consumeToolGatewayContextCitationItems('session-fixture')).toEqual([]);
  });

  it.each(['account-ABA', 'aborted'] as const)('does not publish final provenance after %s during the child run', async (mode) => {
    const controller = new AbortController();
    fixture.afterChild = () => {
      if (mode === 'aborted') controller.abort();
      else { useAuthStore.setState({ localUserId: 'account-other' }); useAuthStore.setState({ localUserId: 'account-fixture' }); }
    };
    const response = await gatewayCall('vibespace_context', { operation: 'investigate', query: 'Who is the Atlas steward and who owns reserve backoff?' }, controller.signal);
    expect(fixture.childCalls).toBeGreaterThan(0);
    expect(response.ok).toBe(false);
    expect(response.data).toBeUndefined();
    expect(consumeToolGatewayContextCitationItems('session-fixture')).toEqual([]);
  });

  it.each(['unbound-message', 'missing-protected-attempt'] as const)('does not invent canonical authority for %s', async (mode) => {
    releaseToolGatewaySessionAuthority('session-fixture');
    if (mode === 'unbound-message') fixture.toolMessageId = 'opaque-tool-request-id';
    else fixture.includeProtectedAttempt = false;
    bindSession();
    const binding = readToolGatewayTurnIdentity('session-fixture', fixture.toolMessageId);
    expect(binding?.protectedAttempt).toBeUndefined();
    const search = await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
    expect(search).toMatchObject({ ok: true, data: { items: expect.any(Array) } });
    expect((search.data as { canonicalProvenance?: unknown }).canonicalProvenance).toBeUndefined();
  });
});

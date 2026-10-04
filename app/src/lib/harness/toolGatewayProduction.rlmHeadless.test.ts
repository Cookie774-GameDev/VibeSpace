// @vitest-environment node
// Synthetic production-gateway fixture only. This is not a native or user-map receipt.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { ToolGatewayTool } from '@/lib/harness/toolGatewayProtocol';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import { getActiveContextPersistenceState } from '@/features/context';
import { useAuthStore } from '@/stores/auth';
import {
  bindToolGatewayObservedExecutionAuthority,
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  clearToolGatewayAuthorityForTests,
  readToolGatewayTurnIdentity,
} from '@/lib/harness/toolGatewayAuthority';
import {
  createProductionToolGatewayDependencies,
  installToolGatewayRlmContextPort,
} from '@/lib/harness/toolGatewayProduction';
import { createProductionRlmContextTool } from '@/features/context/contextRlmProduction';

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  maps: [] as unknown[],
  indexStatus: { documentCount: 2_021, needsRebuild: false },
  indexThrows: false,
  stats: 0,
  reads: 0,
  lexicalCalls: 0,
  childCalls: 0,
  runNonce: 0,
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

vi.mock('@/lib/ai/adapters/codexRlmBoundChild', () => ({
  createRegisteredCodexRlmChild: () => async (
    request: import('@/features/context/rlmRuntime').RlmChildRequest,
  ) => {
    request.signal.throwIfAborted();
    fixture.childCalls++;
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

type SafeCallReceipt = Readonly<{
  label: string;
  tool: ToolGatewayTool;
  elapsedMs: number;
  output: Readonly<Record<string, unknown>>;
}>;
const callReceipts: SafeCallReceipt[] = [];
const qualityReceipts: Array<Readonly<Record<string, unknown>>> = [];
const searchSamples: number[] = [];
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
    requestId: 'turn-fixture', chatId: 'chat-fixture',
    protectedAttempt: {
      accountId: 'account-fixture',
      runId: `provider-attempt-fixture-${fixture.runNonce}`,
      requestId: 'turn-fixture',
      attemptNumber: 1,
    },
  })).toBe(true);
  expect(readToolGatewayTurnIdentity('session-fixture', 'turn-fixture')).toMatchObject({
    requestId: 'turn-fixture',
    chatId: 'chat-fixture',
    protectedAttempt: {
      accountId: 'account-fixture',
      runId: `provider-attempt-fixture-${fixture.runNonce}`,
      requestId: 'turn-fixture',
      attemptNumber: 1,
    },
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
    messageId: 'turn-fixture',
    tool,
    args,
    directory: root,
    worktree: root,
  }), signal);
}

function recordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === 'object' &&
    typeof (item as { recordId?: unknown }).recordId === 'string'
    ? [(item as { recordId: string }).recordId]
    : []);
}

function summarizeOutput(tool: ToolGatewayTool, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return { valueType: typeof value };
  const response = value as { ok?: unknown; code?: unknown; data?: unknown };
  if (response.ok !== true) return {
    ok: false,
    ...(typeof response.code === 'string' ? { code: response.code } : {}),
  };
  const data = response.data;
  if (!data || typeof data !== 'object') return { ok: true, dataType: typeof data };
  const object = data as Record<string, unknown>;
  if (tool === 'vibespace_context_search') {
    const items = Array.isArray(object.items) ? object.items : [];
    return {
      ok: true,
      itemCount: items.length,
      issuedRecordIds: recordIds(items.map((item) => item && typeof item === 'object'
        ? (item as { pointer?: unknown }).pointer : undefined)),
      truncated: object.truncated === true,
    };
  }
  if (tool === 'vibespace_context_open' || tool === 'vibespace_context_expand') {
    const serialized = JSON.stringify(data);
    return { ok: true, containsFixtureFact: /Mira Chen|48 units|Elian Park/u.test(serialized), outputCharacters: serialized.length };
  }
  if (tool === 'vibespace_context_address') {
    const address = object.address && typeof object.address === 'object'
      ? object.address as Record<string, unknown> : {};
    return {
      ok: true,
      status: object.status,
      corpusId: (object.corpus as { corpusId?: unknown } | undefined)?.corpusId,
      position: address.position,
      shard: address.shard,
      evidenceCount: Array.isArray(object.evidence) ? object.evidence.length : 0,
    };
  }
  if (tool === 'vibespace_context_trace') {
    const receipt = object.receipt && typeof object.receipt === 'object'
      ? object.receipt as Record<string, unknown> : {};
    return {
      ok: true,
      found: object.found === true,
      runId: receipt.runId,
      status: receipt.status,
      toolInvocationCount: Array.isArray((receipt.trace as { toolInvocations?: unknown[] } | undefined)?.toolInvocations)
        ? (receipt.trace as { toolInvocations: unknown[] }).toolInvocations.length : 0,
    };
  }
  if (tool === 'vibespace_context') {
    const trace = object.trace && typeof object.trace === 'object'
      ? object.trace as Record<string, unknown> : {};
    return {
      ok: true,
      answerCharacters: typeof object.answer === 'string' ? object.answer.length : 0,
      citationRecordIds: recordIds(object.citations),
      runId: trace.runId,
      mode: trace.mode,
    };
  }
  return { ok: true, resultType: 'object' };
}

async function measuredCall(
  label: string,
  tool: ToolGatewayTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const startedAt = performance.now();
  let response: unknown;
  try {
    response = await gatewayCall(tool, args, signal);
  } catch {
    response = { ok: false, code: 'uncaught_fixture_failure' };
  }
  const elapsedMs = Number((performance.now() - startedAt).toFixed(3));
  callReceipts.push(Object.freeze({ label, tool, elapsedMs, output: summarizeOutput(tool, response) }));
  return { response: response as { ok?: boolean; code?: string; data?: unknown }, elapsedMs };
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
  fixture.indexStatus = { documentCount: 2_021, needsRebuild: false };
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
  for (let index = 0; index < 2_016; index++) {
    const path = `${root}\\filler-${index}.txt`;
    fixture.files.set(path, `Synthetic filler record ${index}.`);
    nodes.push({ id: `node-filler-${index}`, kind: 'file', title: `filler-${index}.txt`, summary: '', path, modifiedAt: 1 });
  }
  fixture.maps = [{
    id: mapId,
    name: 'Synthetic 2021 source fixture',
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

function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!.toFixed(3));
}

describe('production tool gateway RLM headless fixture', () => {
  beforeEach(async () => {
    clearToolGatewayAuthorityForTests();
    sequence = 0;
    await initializeFixture();
  });

  afterEach(() => {
    disposePort?.();
    disposePort = undefined;
    clearToolGatewayAuthorityForTests();
  });

  afterAll(() => {
    if (process.env.RLM_HEADLESS_EMIT_RECEIPT !== '1') return;
    const report = {
      schemaVersion: 1,
      evidenceKind: 'mocked-synthetic-production-gateway-fixture',
      limitation: 'Does not attest a real selected map, native index, Tauri process, or SiYuan source.',
      buildIdentity: {
        gitHead: process.env.RLM_HEADLESS_GIT_HEAD ?? null,
        worktreeFingerprint: process.env.RLM_HEADLESS_WORKTREE_FINGERPRINT ?? null,
        buildMode: 'vitest-node-source',
        route: 'Vitest Node -> production tool gateway -> production RLM context port',
      },
      sourceIdentity: {
        kind: 'synthetic-local-folder-map',
        accountId: 'account-fixture',
        workspaceId: 'workspace-fixture',
        projectId: 'project-fixture',
        mapId,
        recordCount: 2_021,
        corpusId,
        privateSourceTextOmitted: true,
      },
      measurements: {
        repeatedSearchCount: searchSamples.length,
        searchP50Ms: percentile(searchSamples, 0.5),
        searchP95Ms: percentile(searchSamples, 0.95),
        searchSamplesMs: searchSamples,
      },
      quality: qualityReceipts,
      calls: callReceipts,
    };
    console.info(`RLM_HEADLESS_RECEIPT_JSON=${JSON.stringify(report)}`);
  });

  it('drives the five exact registered tools, compatibility investigate, and grounded synthesis', async () => {
    const search = await measuredCall('dedicated-search', 'vibespace_context_search', {
      query: `Read ${knownSources.charter.path}`,
      limit: 3,
    });
    expect(search.response).toMatchObject({ ok: true });
    const searchData = search.response.data as { items?: Array<{ pointer?: Record<string, unknown> }> };
    expect(searchData.items).toHaveLength(1);
    const pointer = searchData.items![0]!.pointer!;
    expect(pointer.recordId).toBeTruthy();

    const opened = await measuredCall('dedicated-open-issued-search-pointer', 'vibespace_context_open', { pointer });
    expect(opened.response).toMatchObject({ ok: true });
    expect(JSON.stringify(opened.response.data)).toContain('Mira Chen');

    const expanded = await measuredCall('dedicated-expand-same-issued-pointer', 'vibespace_context_expand', {
      pointer, beforeBytes: 256, afterBytes: 256,
    });
    expect(expanded.response).toMatchObject({ ok: true });
    expect(JSON.stringify(expanded.response.data)).toContain('Mira Chen');
    const expandedPointer = (expanded.response.data as { pointer?: Record<string, unknown> }).pointer;
    expect(expandedPointer).toMatchObject({
      recordId: pointer.recordId,
      contentHash: pointer.contentHash,
      sourceVersion: pointer.sourceVersion,
    });
    expect(expandedPointer?.id).toContain(':expand:');
    const replayedExpansion = await measuredCall('open-rejected-derived-expanded-pointer', 'vibespace_context_open', {
      pointer: expandedPointer,
    });
    expect(replayedExpansion.response).toMatchObject({ ok: false });

    const address = await measuredCall('dedicated-address-valid-fixture-corpus', 'vibespace_context_address', {
      corpusId, position: '2',
    });
    expect(address.response).toMatchObject({ ok: true, data: {
      status: 'complete',
      corpus: { corpusId },
      address: { position: '2', shard: '0' },
    } });

    const evidenceSearch = await measuredCall('dedicated-search-cross-file-evidence', 'vibespace_context_search', {
      query: 'Atlas steward reserve ceiling backoff owner', limit: 3,
    });
    expect(evidenceSearch.response).toMatchObject({ ok: true });
    const evidenceItems = (evidenceSearch.response.data as { items?: Array<{ pointer?: unknown }> }).items ?? [];
    const evidenceRecordIds = recordIds(evidenceItems.map((item) => item.pointer));
    expect(evidenceRecordIds).toHaveLength(2);

    const investigation = await measuredCall('compatibility-facade-investigate', 'vibespace_context', {
      operation: 'investigate',
      query: 'Who is the Atlas steward, what is the reserve ceiling, and who owns backoff?',
    });
    expect(investigation.response).toMatchObject({ ok: true });
    const investigationData = investigation.response.data as {
      answer?: string;
      citations?: Array<{ recordId?: string }>;
      trace?: { mode?: string; runId?: string };
    };
    const answer = investigationData.answer ?? '';
    const citations = investigationData.citations ?? [];
    const expectedFactChecks = {
      steward: answer.includes('Mira Chen'),
      reserveCeiling: answer.includes('48 units'),
      backoffOwner: answer.includes('Elian Park'),
    };
    const citationIds = citations.map((citation) => citation.recordId).filter((id): id is string => !!id);
    const expectedCitationChecks = {
      issuedSearchEvidence: evidenceRecordIds.length === 2 && evidenceRecordIds.every((id) => citationIds.includes(id)),
    };
    qualityReceipts.push(Object.freeze({
      label: 'cross-file-synthesis',
      exactFacts: expectedFactChecks,
      sourceCitations: expectedCitationChecks,
      citationCount: citations.length,
    }));
    expect(expectedFactChecks).toEqual({ steward: true, reserveCeiling: true, backoffOwner: true });
    expect(expectedCitationChecks).toEqual({ issuedSearchEvidence: true });

    const runId = investigationData.trace?.runId;
    expect(investigationData.trace?.mode).toBe('rlm');
    expect(typeof runId).toBe('string');
    expect(runId).toMatch(/^rlm-/u);
    const trace = await measuredCall('dedicated-trace-actual-completed-run', 'vibespace_context_trace', { runId });
    expect(trace.response).toMatchObject({ ok: true, data: { found: true, receipt: { runId, status: 'completed' } } });

    const noMatch = await measuredCall('dedicated-search-reported-query-on-synthetic-no-match', 'vibespace_context_search', {
      query: 'HEY PLEASE RUN RLM TOOLS ON THESE CONTEXT MAPS OKAY', limit: 3,
    });
    expect(noMatch.response).toMatchObject({ ok: true, data: { items: [] } });

    for (let index = 0; index < 10; index++) {
      const sample = await measuredCall(`large-map-search-sample-${index + 1}`, 'vibespace_context_search', {
        query: 'Atlas steward reserve ceiling backoff owner', limit: 3,
      });
      expect(sample.response).toMatchObject({ ok: true });
      searchSamples.push(sample.elapsedMs);
    }

    fixture.files.set(knownSources.charter.path, 'Project Atlas steward changed: Nora Vale.');
    const stale = await measuredCall('open-stale-issued-pointer', 'vibespace_context_open', { pointer });
    expect(stale.response).toMatchObject({ ok: false });

    expect(new Set([
      'vibespace_context_search', 'vibespace_context_open', 'vibespace_context_expand',
      'vibespace_context_address', 'vibespace_context_trace',
    ])).toEqual(new Set(callReceipts
      .filter((entry) => entry.label.startsWith('dedicated-'))
      .map((entry) => entry.tool)));
    expect(searchSamples).toHaveLength(10);
  });

  it('keeps genuine large-index unavailability explicit and does not issue lexical hits', async () => {
    fixture.indexStatus = { documentCount: 0, needsRebuild: true };
    fixture.lexicalCalls = 0;
    const unavailable = await measuredCall('index-unavailable-rebuild-required', 'vibespace_context_search', {
      query: 'Atlas steward reserve ceiling backoff owner', limit: 3,
    });
    expect(unavailable.response).toMatchObject({ ok: false, code: 'context_index_unavailable' });
    expect(fixture.lexicalCalls).toBe(0);

    fixture.indexStatus = { documentCount: 2_021, needsRebuild: false };
    const healthy = await measuredCall('healthy-index-searchable', 'vibespace_context_search', {
      query: 'Atlas steward reserve ceiling backoff owner', limit: 3,
    });
    expect(healthy.response).toMatchObject({ ok: true });
    expect((healthy.response.data as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('reports an index-status failure as unavailable without leaking native error details', async () => {
    fixture.indexThrows = true;
    const failed = await measuredCall('index-status-failed', 'vibespace_context_search', {
      query: 'Atlas steward reserve ceiling backoff owner', limit: 3,
    });
    expect(failed.response).toMatchObject({ ok: false, code: 'context_index_unavailable' });
    expect(JSON.stringify(callReceipts.at(-1)?.output)).not.toContain('fixture index is unavailable');
  });

  it('rejects a foreign account scope before map IO and preserves cancellation', async () => {
    useAuthStore.setState({ localUserId: 'account-foreign' });
    fixture.stats = 0;
    const foreign = await measuredCall('foreign-account-scope', 'vibespace_context_search', {
      query: 'Atlas steward', limit: 3,
    });
    expect(foreign.response).toMatchObject({ ok: false, code: 'authority_revoked' });
    expect(fixture.stats).toBe(0);

    useAuthStore.setState({ localUserId: 'account-fixture' });
    fixture.stats = 0;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await measuredCall('pre-cancelled-search', 'vibespace_context_search', {
      query: 'Atlas steward', limit: 3,
    }, controller.signal);
    expect(cancelled.response).toMatchObject({ ok: false, code: 'cancelled' });
    expect(fixture.stats).toBe(0);
  });
});

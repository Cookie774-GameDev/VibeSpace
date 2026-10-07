import { waitFor } from '@testing-library/react';
import { setStoredProjectRoot, projectStorageKey, ROOT_PREFIX } from '@/features/files/projectFiles';
import { useUIStore } from '@/stores/ui';
import { createContextEvidenceNavigation } from './contextEvidenceNavigation';
// @vitest-environment jsdom
// Synthetic production-gateway fixture only. This is not a native or user-map receipt.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
const evidenceDatabase = createJarvisDb(uniqueTestDbName('D01-owned-links'), TEST_INDEXED_DB);
let ownerController = new AbortController();
afterAll(async () => {
  await evidenceDatabase.delete();
});
import type { ProjectId, WorkspaceId } from '@/types/common';
import type { ToolGatewayTool } from '@/lib/harness/toolGatewayProtocol';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import {
  clearToolGatewayContextCitationItems,
  consumeToolGatewayContextCitationItems,
  registerToolGatewayFallbackCitations,
} from '@/lib/harness/toolGatewayCitations';
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
import {
  createProductionContextEvidenceRevalidator,
  createProductionRlmContextTool,
} from '@/features/context/contextRlmProduction';

const fixture = vi.hoisted(() => ({
  holdRead: undefined as (() => Promise<void>) | undefined,
  holdStat: undefined as ((includeSha: boolean) => Promise<void>) | undefined,
  files: new Map<string, string>(),
  selectedMapId: 'map-large-fixture',
  afterRegistration: undefined as (() => void) | undefined,
  afterChild: undefined as (() => void) | undefined,
  finalMutationSeen: 0,
  finalMutation: undefined as 'run' | 'foreign-record' | 'span' | undefined,
  maps: [] as unknown[],
  indexStatus: { documentCount: 64, needsRebuild: false },
  indexThrows: false,
  stats: 0,
  reads: 0,
  lexicalCalls: 0,
  childCalls: 0,
  runNonce: 0,
  runtimeWorktree: '',
  nativeToolMessageIds: true,
  includeProtectedAttempt: true,
  toolMessageId: 'msg_native_fixture',
  turnRequestId: 'turn-fixture',
}));

vi.mock('@/lib/harness/toolGatewayCitations', async (original) => {
  const actual = await original<typeof import('@/lib/harness/toolGatewayCitations')>();
  return {
    ...actual,
    registerToolGatewayFallbackCitations: (
      ...args: Parameters<typeof actual.registerToolGatewayFallbackCitations>
    ) => {
      const result = actual.registerToolGatewayFallbackCitations(...args);
      const after = fixture.afterRegistration;
      fixture.afterRegistration = undefined;
      after?.();
      return result;
    },
  };
});

vi.mock('@/lib/fs', async (original) => ({
  ...(await original<typeof import('@/lib/fs')>()),
  statProjectPath: async (path: string, includeSha: boolean) => {
    fixture.stats++;
    await fixture.holdStat?.(includeSha);
    const content = fixture.files.get(path);
    if (content === undefined) return { ok: false, error: 'permission_denied' };
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
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
    await fixture.holdRead?.();
    const content = fixture.files.get(path);
    return content === undefined
      ? { ok: false, error: 'permission_denied' }
      : { ok: true, path, content };
  },
}));

vi.mock('@/features/context/contextPersistence', async (original) => ({
  ...(await original<typeof import('@/features/context/contextPersistence')>()),
  reloadPersistedContextMaps: async (projectId: string) =>
    projectId === 'project-fixture' ? fixture.maps : [],
  loadPersistedContextMaps: async (projectId: string) =>
    projectId === 'project-fixture' ? fixture.maps : [],
  getActiveContextPersistenceState: (projectId: string | null) =>
    projectId === 'project-fixture'
      ? ({
          accountId: 'account-fixture',
          projectId: 'project-fixture',
          selectedMapId: fixture.selectedMapId,
          maps: fixture.maps,
        } as never)
      : null,
}));

// The production gateway imports persistence through this barrel. Keep its
// selected-map view explicit and assert it below before exercising trace.
vi.mock('@/features/context', async (original) => ({
  ...(await original<typeof import('@/features/context')>()),
  reloadPersistedContextMaps: async (projectId: string) =>
    projectId === 'project-fixture' ? fixture.maps : [],
  loadPersistedContextMaps: async (projectId: string) =>
    projectId === 'project-fixture' ? fixture.maps : [],
  getActiveContextPersistenceState: (projectId: string | null) =>
    projectId === 'project-fixture'
      ? ({
          accountId: 'account-fixture',
          projectId: 'project-fixture',
          selectedMapId: fixture.selectedMapId,
          maps: fixture.maps,
        } as never)
      : null,
}));

vi.mock('@/features/context/contextSearchPipeline', async (original) => ({
  ...(await original<typeof import('@/features/context/contextSearchPipeline')>()),
  createTauriContextLexicalSearchExecutor:
    () => async (request: { query: string; mapId: string }) => {
      fixture.lexicalCalls++;
      if (
        request.mapId !== 'map-large-fixture' ||
        /quasar-no-match|foreign-only/u.test(request.query)
      )
        return [];
      if (
        !/atlas|steward|reserve|backoff|mira|chen|el(i|ia)n|park/u.test(
          request.query.toLocaleLowerCase('en-US'),
        )
      )
        return [];
      const query = request.query.toLocaleLowerCase('en-US');
      const hits: Array<{ documentId: string; excerpt: string; score: number }> = [];
      if (/steward|mira|chen/u.test(query))
        hits.push({
          documentId: 'node-charter',
          excerpt: 'Synthetic Atlas charter hit.',
          score: 3,
        });
      if (/reserve|capacity|backoff|elian|park/u.test(query))
        hits.push({
          documentId: 'node-capacity',
          excerpt: 'Synthetic Atlas capacity hit.',
          score: 2,
        });
      if (/decision|gate/u.test(query))
        hits.push({
          documentId: 'node-decision',
          excerpt: 'Synthetic Atlas decision hit.',
          score: 1,
        });
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
  ...(await original<typeof import('@/features/context/contextRlmHistory')>()),
  loadProductionRlmHistory: async () => [],
}));

vi.mock('@/features/context/siyuanRlmProduction', () => ({
  getProductionSiyuanRlmPort: () => ({
    searchBlocks: async () => [],
    getBlock: async () => undefined,
  }),
}));

// Keep the actual runtime, child scheduling and terminal receipt. This seam only
// corrupts its final returned object to test the host's result/receipt join.
vi.mock('@/features/context/rlmRuntime', async (original) => {
  const actual = await original<typeof import('@/features/context/rlmRuntime')>();
  return {
    ...actual,
    createRlmRuntime: (...args: Parameters<typeof actual.createRlmRuntime>) => {
      const actualRuntime = actual.createRlmRuntime(...args);
      return {
        ...actualRuntime,
        investigate: async (...input: Parameters<typeof actualRuntime.investigate>) => {
          const result = await actualRuntime.investigate(...input);
          if (fixture.finalMutation) fixture.finalMutationSeen += 1;
          if (fixture.finalMutation === 'run')
            return { ...result, trace: { ...result.trace, runId: 'rlm-unrelated-final' } };
          if (fixture.finalMutation === 'foreign-record')
            return {
              ...result,
              citations: result.citations.map((pointer) => ({
                ...pointer,
                recordId: 'foreign-record',
              })),
            };
          if (fixture.finalMutation === 'span')
            return {
              ...result,
              citations: result.citations.map((pointer) => ({
                ...pointer,
                byteEnd: (pointer.byteEnd ?? 0) + 1,
              })),
            };
          return result;
        },
      };
    },
  };
});

vi.mock('@/lib/ai/adapters/codexRlmBoundChild', () => ({
  createRegisteredCodexRlmChild:
    () => async (request: import('@/features/context/rlmRuntime').RlmChildRequest) => {
      request.signal.throwIfAborted();
      fixture.childCalls++;
      const afterChild = fixture.afterChild;
      fixture.afterChild = undefined;
      fixture.holdRead = undefined;
      fixture.holdStat = undefined;
      afterChild?.();
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
  charter: {
    nodeId: 'node-charter',
    title: 'atlas-charter.txt',
    path: `${root}\\atlas-charter.txt`,
  },
  capacity: {
    nodeId: 'node-capacity',
    title: 'capacity-register.txt',
    path: `${root}\\capacity-register.txt`,
  },
  decision: {
    nodeId: 'node-decision',
    title: 'decision-log.txt',
    path: `${root}\\decision-log.txt`,
  },
  descriptor: {
    nodeId: 'node-address-descriptor',
    title: '.vibespace-large-address-v1.json',
    path: `${root}\\.vibespace-large-address-v1.json`,
  },
  addressShard: {
    nodeId: 'node-address-shard',
    title: 'address-shard.txt',
    path: `${root}\\address-shard.txt`,
  },
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
  expect(
    bindToolGatewaySessionAuthority('session-fixture', authority, ownerController.signal, {
      requestId: fixture.turnRequestId,
      chatId: 'chat-fixture',
      ...(fixture.nativeToolMessageIds ? { nativeToolMessageIds: true as const } : {}),
      ...(fixture.includeProtectedAttempt
        ? {
            protectedAttempt: {
              accountId: 'account-fixture',
              runId: `provider-attempt-fixture-${fixture.runNonce}`,
              requestId: fixture.turnRequestId,
              attemptNumber: 1,
            },
          }
        : {}),
    }),
  ).toBe(true);
  expect(readToolGatewayTurnIdentity('session-fixture', fixture.turnRequestId)).toMatchObject({
    requestId: fixture.turnRequestId,
    chatId: 'chat-fixture',
  });
  expect(
    bindToolGatewayObservedExecutionAuthority('session-fixture', authority, {
      executionIdentity: observedIdentity,
      performance: 'quality',
    }),
  ).toBe(true);
}

function gatewayCall(tool: ToolGatewayTool, args: Record<string, unknown>, signal?: AbortSignal) {
  return runtime.execute(
    parseToolGatewayRequest({
      protocolVersion: 1,
      requestId: `request-${++sequence}`,
      sessionId: 'session-fixture',
      messageId: fixture.toolMessageId,
      tool,
      args,
      directory: root,
      worktree: fixture.runtimeWorktree || root,
    }),
    signal,
  );
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
  const contentDigest = await sha256(
    JSON.stringify([
      [shard.index, shard.tokenStart, shard.tokenEnd, shard.file, shard.contentSha256],
    ]),
  );
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
    nodes.push({
      id: `node-filler-${index}`,
      kind: 'file',
      title: `filler-${index}.txt`,
      summary: '',
      path,
      modifiedAt: 1,
    });
  }
  fixture.maps = [
    {
      id: mapId,
      name: 'Synthetic64 source fixture',
      projectId: 'project-fixture',
      rootDir: root,
      status: 'active',
      sourceType: 'local_folder',
      updatedAt: 1,
      tree: { nodes },
    },
  ];
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
  disposePort = installToolGatewayRlmContextPort(
    createProductionRlmContextTool({ evidenceLinkDatabase: evidenceDatabase }),
  );
  runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
}

describe('issuer-backed durable evidence link association', () => {
  it('issues and dereferences with distinct runtime worktree and UI-root identities',async()=>{
    const projectRoot='D:/VibeSpace-Testing/Chat01-CH31-fixtures';
    setStoredProjectRoot('project-fixture',projectRoot);
    fixture.runtimeWorktree='/';
    const result=await gatewayCall('vibespace_context_search',{query:'Atlas steward',limit:2});
    expect(result.ok).toBe(true);
    const references=consumeToolGatewayContextCitationItems('session-fixture');
    const rows=await evidenceDatabase.settings.where('key').startsWith('context-evidence-link-v2:').toArray();
    const record=rows[0]!.value as import('./contextEvidenceLinks').ContextEvidenceLinkRecord;
    expect(record).toMatchObject({version:2,scope:{worktreeId:'/',projectRoot}});
    const reference=references.find(item=>item.source.uri===record.target.uri)!;
    expect(reference).toBeDefined();
    await evidenceDatabase.projects.put({id:'project-fixture',workspace_id:'workspace-fixture',name:'Owned',created_at:1,updated_at:1} as never);
    await evidenceDatabase.chats.put({id:'chat-fixture',workspace_id:'workspace-fixture',project_id:'project-fixture',title:'Owned',mode:'chat',active_agent_ids:[],created_at:1,updated_at:1} as never);
    await evidenceDatabase.messages.put({id:'message-fixture',chat_id:'chat-fixture',role:'assistant',parts:[{kind:'jarvis_source_ref',source:reference.source}],created_at:1,updated_at:1} as never);
    await evidenceDatabase.context_maps.put({...fixture.maps[0] as object,accountId:'account-fixture'} as never);
    useUIStore.setState({activeChatId:'chat-fixture',route:'chat'});
    const navigation=createContextEvidenceNavigation({database:evidenceDatabase,revalidate:createProductionContextEvidenceRevalidator()});
    try {
      const pending=navigation.open({chatId:'chat-fixture',messageId:'message-fixture',uri:record.target.uri});
      let ticket: ReturnType<typeof navigation.take>;
      await waitFor(()=>{ticket??=navigation.take('project-fixture');expect(ticket).toBeDefined();});
      expect(useUIStore.getState().route).toBe('context');
      expect(ticket!.target).toMatchObject({mapId,entityId:record.target.entityId,path:record.target.sourcePath});
      ticket!.complete();await pending;
    } finally {navigation.dispose();}
  });
  it.each(['same-window-ABA','delayed-storage-ABA','unrelated-root'] as const)(
    'captures UI-root continuity before held issuance: %s',async(change)=>{
      setStoredProjectRoot('project-fixture','D:/A');
      fixture.holdStat=async()=>{
        fixture.holdStat=undefined;
        if(change==='same-window-ABA'){
          setStoredProjectRoot('project-fixture','D:/B');setStoredProjectRoot('project-fixture','D:/A');
        }else if(change==='delayed-storage-ABA'){
          window.dispatchEvent(new StorageEvent('storage',{key:projectStorageKey(ROOT_PREFIX,'project-fixture'),oldValue:'D:/A',newValue:'D:/B'}));
        }else setStoredProjectRoot('unrelated-project','D:/B');
      };
      await gatewayCall('vibespace_context_search',{query:'Atlas steward',limit:2});
      const rows=await evidenceDatabase.settings.where('key').startsWith('context-evidence-link-v2:').toArray();
      if(change==='unrelated-root')expect(rows.length).toBeGreaterThan(0);
      else expect(rows).toHaveLength(0);
    });

  beforeEach(async () => {
    clearToolGatewayAuthorityForTests();
    clearToolGatewayContextCitationItems();
    ownerController = new AbortController();
    fixture.afterChild = undefined;
    fixture.finalMutation = undefined;
    fixture.finalMutationSeen = 0;
    fixture.afterRegistration = undefined;
    fixture.selectedMapId = mapId;
    fixture.nativeToolMessageIds = true;
    fixture.includeProtectedAttempt = true;
    fixture.toolMessageId = 'msg_native_fixture';
    fixture.turnRequestId = 'turn-fixture';
    sequence = 0;
    fixture.runtimeWorktree = '';
    setStoredProjectRoot('project-fixture','');
    await evidenceDatabase.settings.clear();
    await initializeFixture();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    disposePort?.();
    disposePort = undefined;
    clearToolGatewayAuthorityForTests();
  });
  it('retains only actual acknowledged search handles after session citation consumption', async () => {
    const response = await gatewayCall('vibespace_context_search', {
      query: 'Atlas steward',
      limit: 2,
    });
    expect(response.ok).toBe(true);
    const uris = (response.data as { canonicalProvenance: { evidenceUris: string[] } })
      .canonicalProvenance.evidenceUris;
    expect(uris.length).toBeGreaterThan(0);
    const references = consumeToolGatewayContextCitationItems('session-fixture');
    expect(references.map((item) => item.source.uri)).toEqual(uris);
    expect(consumeToolGatewayContextCitationItems('session-fixture')).toEqual([]);
    const stored = await evidenceDatabase.settings
      .where('key')
      .startsWith('context-evidence-link-v2:')
      .toArray();
    expect(stored).toHaveLength(uris.length);
    expect(
      stored.map((row) => (row.value as { target: { uri: string } }).target.uri).sort(),
    ).toEqual([...uris].sort());
    expect(JSON.stringify(stored)).not.toContain(sourceContent.charter);
  });
  it('retains actual open, expand and final-investigation associations', async () => {
    const search = await gatewayCall('vibespace_context_search', {
      query: 'Atlas steward',
      limit: 2,
    });
    const pointer = (search.data as { items: Array<{ pointer: unknown }> }).items[0]!.pointer;
    for (const operation of ['open', 'expand'] as const) {
      const result = await gatewayCall(`vibespace_context_${operation}`, { pointer });
      expect(result.ok).toBe(true);
      const uris = (result.data as { canonicalProvenance: { evidenceUris: string[] } })
        .canonicalProvenance.evidenceUris;
      const rows = await evidenceDatabase.settings
        .where('key')
        .startsWith('context-evidence-link-v2:')
        .toArray();
      expect(
        uris.every((uri) =>
          rows.some((row) => (row.value as { target: { uri: string } }).target.uri === uri),
        ),
      ).toBe(true);
    }
    const result = await gatewayCall('vibespace_context', {
      operation: 'investigate',
      query: 'What are the Atlas steward and reserve capacity facts?',
    });
    expect(result.ok).toBe(true);
    const uris = (result.data as { canonicalProvenance: { evidenceUris: string[] } })
      .canonicalProvenance.evidenceUris;
    expect(uris.length).toBeGreaterThan(0);
    const rows = await evidenceDatabase.settings
      .where('key')
      .startsWith('context-evidence-link-v2:')
      .toArray();
    expect(
      uris.every((uri) =>
        rows.some((row) => (row.value as { target: { uri: string } }).target.uri === uri),
      ),
    ).toBe(true);
  });

  it.each(['run', 'foreign-record', 'span'] as const)(
    'does not persist a forged final %s association',
    async (mutation) => {
      fixture.finalMutation = mutation;
      const result = await gatewayCall('vibespace_context', {
        operation: 'investigate',
        query: 'What is the Atlas steward?',
      });
      expect(fixture.finalMutationSeen).toBe(1);
      expect(result.ok).toBe(true);
      expect(
        (result.data as { canonicalProvenance?: unknown }).canonicalProvenance,
      ).toBeUndefined();
      expect(await evidenceDatabase.settings.count()).toBe(0);
    },
  );

  it('does not borrow a colliding foreign registry acknowledgement', async () => {
    const first = await gatewayCall('vibespace_context_search', {
      query: 'Atlas steward',
      limit: 2,
    });
    const pointer = (
      first.data as { items: Array<{ pointer: import('./losslessContext').ContextPointer }> }
    ).items[0]!.pointer;
    consumeToolGatewayContextCitationItems('session-fixture');
    await evidenceDatabase.settings.clear();
    expect(
      registerToolGatewayFallbackCitations(
        'session-fixture',
        [
          {
            pointerId: pointer.id,
            recordId: pointer.recordId,
            sourceRevision: pointer.sourceVersion,
            contentHash: pointer.contentHash,
          },
        ],
        { accountId: 'foreign', projectId: 'foreign' },
      ),
    ).toHaveLength(1);
    const result = await gatewayCall('vibespace_context_search', {
      query: 'Atlas steward',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { canonicalProvenance?: unknown }).canonicalProvenance).toBeUndefined();
    expect(await evidenceDatabase.settings.count()).toBe(0);
  });

  it('rechecks physical source freshness after registry acknowledgement and before retention', async () => {
    fixture.afterRegistration = () =>
      fixture.files.set(
        knownSources.charter.path,
        'Changed physical bytes after canonical admission.',
      );
    const result = await gatewayCall('vibespace_context_search', {
      query: 'Atlas steward',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    expect(await evidenceDatabase.settings.count()).toBe(0);
  });

  it.each(['session-release', 'account-ABA', 'selected-map-ABA', 'project-root-ABA', 'project-root-storage-ABA'] as const)(
    'rolls back an acknowledged write after %s following put success',
    async (transition) => {
      const put = evidenceDatabase.settings.put.bind(evidenceDatabase.settings);
      let observed = false;
      vi.spyOn(evidenceDatabase.settings, 'put').mockImplementation((...args) =>
        put(...args).then((value) => {
          observed = true;
          if (transition === 'session-release')
            releaseToolGatewaySessionAuthority('session-fixture');
          if (transition === 'account-ABA') {
            useAuthStore.setState({ localUserId: 'foreign' });
            useAuthStore.setState({ localUserId: 'account-fixture' });
          }
          if (transition === 'project-root-ABA') {
            setStoredProjectRoot('project-fixture','D:/replacement');
            setStoredProjectRoot('project-fixture','');
          }
          if (transition === 'project-root-storage-ABA') {
            window.dispatchEvent(new StorageEvent('storage',{
              key:projectStorageKey(ROOT_PREFIX,'project-fixture'),oldValue:null,newValue:'D:/replacement',
            }));
          }
          if (transition === 'selected-map-ABA') {
            fixture.selectedMapId = 'different-map';
            window.dispatchEvent(new CustomEvent('jarvis:context-tree-updated'));
            fixture.selectedMapId = mapId;
            window.dispatchEvent(new CustomEvent('jarvis:context-tree-updated'));
          }
          return value;
        }),
      );
      await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
      expect(observed).toBe(true);
      expect(await evidenceDatabase.settings.count()).toBe(0);
    },
  );

  it('leaves missing protected-turn authority without durable backing', async () => {
    releaseToolGatewaySessionAuthority('session-fixture');
    fixture.includeProtectedAttempt = false;
    bindSession();
    const result = await gatewayCall('vibespace_context_search', {
      query: 'Atlas steward',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { canonicalProvenance?: unknown }).canonicalProvenance).toBeUndefined();
    expect(await evidenceDatabase.settings.count()).toBe(0);
  });
  it('revalidates a persisted issuer target through a fresh repository after registry consumption', async () => {
    await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
    consumeToolGatewayContextCitationItems('session-fixture');
    const [row] = await evidenceDatabase.settings.toArray();
    const record = row!.value as import('./contextEvidenceLinks').ContextEvidenceLinkRecord;
    const revalidate = createProductionContextEvidenceRevalidator();
    const result = await revalidate({
      scope: record.scope,
      target: record.target,
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    expect(result).toMatchObject({
      mapId,
      entityId: 'node-charter',
      path: knownSources.charter.path,
      projectId: 'project-fixture',
    });
    expect(result).not.toHaveProperty('pointer');
    expect(result).not.toHaveProperty('content');
  });

  it.each(['file-change', 'same-size-hash-change', 'map-change', 'missing-entity', 'foreign-scope'] as const)(
    'fresh navigation target refuses %s',
    async (change) => {
      await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
      const [row] = await evidenceDatabase.settings.toArray();
      const record = row!.value as import('./contextEvidenceLinks').ContextEvidenceLinkRecord;
      if (change === 'file-change')
        fixture.files.set(
          knownSources.charter.path,
          'Changed current bytes with matching fixture timestamps.',
        );
      if (change === 'same-size-hash-change') {
        const original = fixture.files.get(knownSources.charter.path)!;
        const changed = (original.startsWith('X') ? 'Y' : 'X') + original.slice(1);
        expect(new TextEncoder().encode(changed).length).toBe(new TextEncoder().encode(original).length);
        fixture.files.set(knownSources.charter.path, changed);
      }
      if (change === 'map-change') (fixture.maps[0] as { updatedAt: number }).updatedAt++;
      if (change === 'missing-entity')
        (fixture.maps[0] as { tree: { nodes: Array<{ id: string }> } }).tree.nodes = (
          fixture.maps[0] as { tree: { nodes: Array<{ id: string }> } }
        ).tree.nodes.filter((node) => node.id !== 'node-charter');
      const scope =
        change === 'foreign-scope'
          ? { ...record.scope, accountId: 'foreign-account' }
          : record.scope;
      const result = await createProductionContextEvidenceRevalidator()({
        scope,
        target: record.target,
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(result).toBeUndefined();
    },
  );

  it('fresh navigation revalidation observes cancellation and does not manufacture a replacement pointer', async () => {
    await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
    const [row] = await evidenceDatabase.settings.toArray();
    const record = row!.value as import('./contextEvidenceLinks').ContextEvidenceLinkRecord;
    const controller = new AbortController();
    controller.abort();
    await expect(
      createProductionContextEvidenceRevalidator()({
        scope: record.scope,
        target: record.target,
        signal: controller.signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow();
  });

  it('keeps the saved Git commit binding when identical working bytes remain after a branch change', async () => {
    const map = fixture.maps[0] as { sourceType: string; github?: { resolvedCommitSha: string } };
    map.sourceType = 'github_repository';
    map.github = { resolvedCommitSha: 'a'.repeat(40) };
    await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
    const [row] = await evidenceDatabase.settings.toArray();
    const record = row!.value as import('./contextEvidenceLinks').ContextEvidenceLinkRecord;
    const revalidate = createProductionContextEvidenceRevalidator();
    expect(
      await revalidate({
        scope: record.scope,
        target: record.target,
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).toBeDefined();
    map.github = { resolvedCommitSha: 'b'.repeat(40) };
    expect(
      await revalidate({
        scope: record.scope,
        target: record.target,
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).toBeUndefined();
  });
  it.each(
    (['preflight', 'snapshot-hash', 'read', 'post-read-hash'] as const).flatMap((stage) =>
      (['current', 'abort', 'scope'] as const).map((mode) => ({ stage, mode })),
    ),
  )('fresh click stops new physical work after $mode at held $stage', async ({ stage, mode }) => {
    await gatewayCall('vibespace_context_search', { query: 'Atlas steward', limit: 2 });
    const [row] = await evidenceDatabase.settings.toArray();
    const record = row!
      .value as import('@/features/context/contextEvidenceLinks').ContextEvidenceLinkRecord;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let statOrdinal = 0;
    const pause = async () => {
      enter();
      await held;
    };
    fixture.holdRead = stage === 'read' ? pause : undefined;
    fixture.holdStat = async () => {
      statOrdinal++;
      if (
        (stage === 'preflight' && statOrdinal === 1) ||
        (stage === 'snapshot-hash' && statOrdinal === 2) ||
        (stage === 'post-read-hash' && statOrdinal === 3)
      )
        await pause();
    };
    const controller = new AbortController();
    let current = true;
    const pending = createProductionContextEvidenceRevalidator()({
      scope: record.scope,
      target: record.target,
      signal: controller.signal,
      assertCurrent() {
        if (!current) throw new Error('owned click scope revoked');
      },
    }).then(
      (value) => ({ value, error: false }),
      () => ({ value: undefined, error: true }),
    );
    await entered;
    const physicalAtPause = { stats: fixture.stats, reads: fixture.reads };
    if (mode === 'abort') controller.abort();
    if (mode === 'scope') current = false;
    release();
    const result = await pending;
    fixture.holdRead = undefined;
    fixture.holdStat = undefined;
    if (mode === 'current') {
      expect(result.error).toBe(false);
      expect(result.value).toMatchObject({ mapId, entityId: 'node-charter' });
    } else {
      expect(result.error).toBe(true);
      expect({ stats: fixture.stats, reads: fixture.reads }).toEqual(physicalAtPause);
    }
  });
});

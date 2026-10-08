import 'fake-indexeddb/auto';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ChatId, MessageId, ProjectId, WorkspaceId } from '@/types/common';
import type { ContextPersistenceState, ContextSelectionGuard } from './contextPersistence';
import type { ProjectContextTree } from './tree';
import { setStoredProjectRoot } from '@/features/files/projectFiles';
import { canonicalContextUri } from '@/lib/harness/toolGatewayCitations';
import type { Part } from '@/types/chat';
const io = vi.hoisted(() => ({
  state: null as ContextPersistenceState | null,
  service: null as ReturnType<
    typeof import('./contextPersistence').createContextPersistenceService
  > | null,
  nav: null as ReturnType<
    typeof import('./contextEvidenceNavigation').createContextEvidenceNavigation
  > | null,
  heldSelection: undefined as Promise<void> | undefined,
  selectingA: false,
  selectCalls: [] as string[],
  selectionSignals: [] as AbortSignal[],
  openResults: [] as string[],
  job: null as any,
  entries: [] as any[],
  entriesGate: undefined as Promise<void> | undefined,
  jobGate: undefined as Promise<void> | undefined,
  repair: vi.fn(),
  readTrees: {} as Record<string, ProjectContextTree>,
  readGate: undefined as Promise<void> | undefined,
  readStarted: [] as string[],
  equivalenceGate: undefined as Promise<void> | undefined,
  equivalenceReads: 0,
}));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ groups: [], flatOptions: [], loading: false }),
}));
vi.mock('./NightlySecondBrainPanel', () => ({ NightlySecondBrainPanel: () => null }));
vi.mock('./ContextAutoUpdateCheckbox', () => ({ ContextAutoUpdateCheckbox: () => null }));
vi.mock('./ContextGalaxy', () => ({ ContextGalaxy: () => null }));
vi.mock('./siyuan/SiyuanVaultSurface', () => ({
  SiyuanVaultSurface: () => null,
  SiyuanVaultLoading: () => null,
}));
vi.mock('./siyuanContextMapIntegration', () => ({
  productionSiyuanContextMaps: {
    prewarm: async () => {},
    read: async (_project: unknown, map: { id: string; tree: ProjectContextTree }) => {
      const tree = io.readTrees[map.id] ?? map.tree;
      io.readStarted.push(map.id);
      await io.readGate;
      return { tree };
    },
  },
}));
vi.mock('./siyuan/siyuanIndexJobStore', async (original) => ({
  ...(await original<typeof import('./siyuan/siyuanIndexJobStore')>()),
  readSiyuanIndexJob: async (_project:string,mapId:string) => {await io.jobGate;return mapId==='page-map-A' ? io.job : null;},
  readSiyuanIndexEntries: async () => { await io.entriesGate; return io.entries; },
}));
vi.mock('./contextSearchIndexing', () => ({createContextSearchIndexPopulationPort:()=>({repairEmptyMap:io.repair})}));
vi.mock('./contextPersistence', async (original) => ({
  ...(await original<typeof import('./contextPersistence')>()),
  ensureContextPersistence: () => io.service!.load('page-account', 'page-project'),
  getActiveContextPersistenceState: () => io.state,
  hasEquivalentPersistedContextTree: async (_project:string,mapId:string,tree:ProjectContextTree,expected:number,signal?:AbortSignal) => {
    const equivalent = await io.service!.hasEquivalentTree('page-account',tree,mapId,expected,signal);
    io.equivalenceReads += 1;
    await io.equivalenceGate;
    return equivalent;
  },
  savePersistedContextTree: (tree:ProjectContextTree,options:any) => io.service!.saveTree('page-account',tree,options),
  selectPersistedContextMap: async (
    projectId: string,
    mapId: string,
    guard?: ContextSelectionGuard,
  ) => {
    io.selectCalls.push(mapId);
    if (guard && mapId === 'page-map-A') {
      io.selectionSignals.push(guard.signal);
      io.selectingA = true;
      await io.heldSelection;
    }
    return io.service!.selectMap('page-account', projectId, mapId, guard);
  },
}));
vi.mock('./contextEvidenceNavigation', async (original) => ({
  ...(await original<typeof import('./contextEvidenceNavigation')>()),
  contextEvidenceNavigation: {
    open: (input: Parameters<NonNullable<typeof io.nav>['open']>[0]) => io.nav!.open(input).then(
      () => { io.openResults.push('completed'); },
      (error) => { io.openResults.push(String(error)); throw error; },
    ),
    take: (projectId: string | null) => io.nav!.take(projectId),
    subscribe: (listener: () => void) => io.nav!.subscribe(listener),
    cancel: () => io.nav?.cancel(),
  },
}));
import { createContextPersistenceService } from './contextPersistence';
import { createContextEvidenceNavigation } from './contextEvidenceNavigation';
import { createContextEvidenceLinkStore } from './contextEvidenceLinks';
import { ContextPage } from './ContextPage';
import { MessagePart } from '@/features/chat/MessagePart';
import { PageRouter } from '@/components/layout/PageRouter';
import { SidebarContextTree } from './SidebarContextTree';

let database: JarvisDexie;
let part: Part;
const scope = {
  accountId: 'page-account',
  accountSource: 'local' as const,
  workspaceId: 'page-workspace',
  projectId: 'page-project',
  chatId: 'page-chat',
  worktreeId: 'C:/owned-page',
  projectRoot: 'C:/owned-page',
};
function Shell() {
  const route = useUIStore((state) => state.route);
  return route === 'context' ? (
    <ContextPage />
  ) : (
    <MessagePart
      part={part}
      allParts={[part]}
      chatId={scope.chatId}
      messageId={'page-message' as MessageId}
    />
  );
}
beforeEach(async () => {
  localStorage.clear();
  io.state = null;
  io.heldSelection = undefined;
  io.selectingA = false;
  io.selectCalls = [];
  io.selectionSignals = [];
  io.openResults = [];
  io.job=null;io.entries=[];io.entriesGate=undefined;io.jobGate=undefined;io.repair.mockReset();io.repair.mockResolvedValue({status:"ready",documentCount:1,bodyBytes:4});
  io.readTrees = {};
  io.readGate = undefined;
  io.readStarted = [];
  io.equivalenceGate = undefined;
  io.equivalenceReads = 0;
  useAuthStore.setState({
    localUserId: scope.accountId,
    cloudSession: null,
    workspaceId: scope.workspaceId as WorkspaceId,
    projectId: scope.projectId as ProjectId,
  });
  useUIStore.setState({ activeChatId: scope.chatId, route: 'chat' });
  setStoredProjectRoot(scope.projectId, scope.worktreeId);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  database = createJarvisDb(uniqueTestDbName('D02-page'), TEST_INDEXED_DB);
  io.service = createContextPersistenceService(database, localStorage, (state) => {
    io.state = state;
    window.dispatchEvent(
      new CustomEvent('jarvis:context-tree-updated', { detail: { projectId: scope.projectId } }),
    );
  });
  await io.service.initialize(scope.accountId, scope.projectId);
  const tree: ProjectContextTree = {
    version: 1,
    projectId: scope.projectId,
    rootDir: scope.worktreeId,
    generatedAt: 1,
    model: 'local-fallback',
    fileCount: 1,
    totalBytes: 4,
    summary: 'Owned map',
    nodes: [
      {
        id: 'node-file',
        title: 'linked-file.txt',
        path: 'linked-file.txt',
        kind: 'file',
        summary: 'Owned source',
        modifiedAt: 1,
      },
    ],
  };
  const state = await io.service.saveTree(scope.accountId, tree, {
    mapId: 'page-map-A',
    name: 'Map A',
    sourceStatus: 'ready',
  });
  await io.service.saveTree(
    scope.accountId,
    { ...tree, rootDir: 'C:/owned-page-B' },
    { mapId: 'page-map-B', name: 'Map B', sourceStatus: 'ready' },
  );
  const map = state.maps.find((map) => map.id === 'page-map-A')!;
  const pointer = {
    id: 'page-pointer',
    recordId: 'page-record',
    byteStart: 0,
    byteEnd: 4,
    sourceVersion: `sha256:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
  };
  const uri = canonicalContextUri('evidence', pointer.id);
  await createContextEvidenceLinkStore(database).retain(
    scope,
    { runId: 'page-run', requestId: 'page-request', attemptNumber: 1 },
    [
      {
        uri,
        mapId: map.id,
        entityId: map.tree.nodes[0]!.id,
        rootDir: scope.worktreeId,
        sourcePath: `${scope.worktreeId}/linked-file.txt`,
        sourceKind: 'file_version',
        membershipRevision: `sha256:${'b'.repeat(64)}`,
        pointer,
      },
    ],
    { signal: new AbortController().signal, assertCurrent() {} },
  );
  part = {
    kind: 'jarvis_source_ref',
    source: {
      id: pointer.id,
      kind: 'context_node',
      label: 'Open verified Context source',
      uri,
      trust: 'app_verified',
      sensitivity: 'private',
    },
  };
  await database.projects.put({
    id: scope.projectId as ProjectId,
    workspace_id: scope.workspaceId as WorkspaceId,
    name: 'Owned',
    created_at: 1,
    updated_at: 1,
  });
  await database.chats.put({
    id: scope.chatId as ChatId,
    workspace_id: scope.workspaceId as WorkspaceId,
    project_id: scope.projectId as ProjectId,
    title: 'Owned',
    mode: 'chat',
    active_agent_ids: [],
    created_at: 1,
    updated_at: 1,
  });
  await database.messages.put({
    id: 'page-message' as MessageId,
    chat_id: scope.chatId as ChatId,
    role: 'assistant',
    parts: [part],
    created_at: 1,
    updated_at: 1,
  });
  io.nav = createContextEvidenceNavigation({
    database,
    revalidate: async (input) => {
      input.assertCurrent();
      return {
        accountId: scope.accountId,
        projectId: scope.projectId,
        mapId: map.id,
        entityId: map.tree.nodes[0]!.id,
        path: `${scope.worktreeId}/linked-file.txt`,
        mapUpdatedAt: map.updatedAt,
      };
    },
  });
});
afterEach(async () => {
  cleanup();
  io.nav?.dispose();
  vi.restoreAllMocks();
  await database.delete();
  localStorage.clear();
});

it.each([false, true])('opens the exact source node through the actual chip, route mount and guarded persistence (StrictMode=%s)', async (strictMode) => {
  render(strictMode ? <React.StrictMode><Shell /></React.StrictMode> : <Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() =>
    expect(screen.getByText('Opened linked-file.txt from chat Context.')).toBeTruthy(),
  );
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-A',
  );
  expect(io.selectCalls.filter((id) => id === 'page-map-A')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Map A/ })).toBeTruthy();
});

it('keeps historical missing backing inside the app without route or selection changes', async () => {
  await database.settings.where('key').startsWith('context-evidence-link-v2:').delete();
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(useUIStore.getState().route).toBe('chat');
  expect(io.selectCalls).toEqual([]);
  expect(screen.queryByRole('link', { name: 'Open verified Context source' })).toBeNull();
});

it('lets a newer real Map B choice defeat an older held evidence-link selection', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => {
    release = resolve;
  });
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.selectingA).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: /^Map B/ }));
  await waitFor(() => expect(io.selectCalls).toContain('page-map-B'));
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-B',
  );
  expect(screen.queryByText('Opened linked-file.txt from chat Context.')).toBeNull();
});

it('a newer workspace section choice cancels a held citation before its late completion', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => {
    release = resolve;
  });
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.selectingA).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-B',
  );
  expect(screen.queryByText('Opened linked-file.txt from chat Context.')).toBeNull();
});

it('a newer actual source-node choice defeats a held evidence-link selection', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => {
    release = resolve;
  });
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.selectingA).toBe(true));
  const sourceButtons = await screen.findAllByRole('button', { name: /linked-file\.txt/ });
  fireEvent.click(sourceButtons[0]!);
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-B',
  );
  expect(screen.queryByText('Opened linked-file.txt from chat Context.')).toBeNull();
});


it('a real StrictMode consumer unmount immediately revokes an already consumed held ticket', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => { release = resolve; });
  const mounted = render(<React.StrictMode><Shell /></React.StrictMode>);
  fireEvent.click(screen.getByRole('button', {name:'Open verified Context source'}));
  await waitFor(() => expect(io.selectingA).toBe(true));
  expect(io.selectionSignals).toHaveLength(1);
  expect(io.selectionSignals[0]!.aborted).toBe(false);
  mounted.unmount();
  expect(io.selectionSignals[0]!.aborted).toBe(true);
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve,10)); });
  expect((await io.service!.load(scope.accountId,scope.projectId)).selectedMapId).toBe('page-map-B');
});


type CitationScopeChange = 'route' | 'account' | 'root';
function interruptCitationScope(change: CitationScopeChange) {
  if (change === 'route') useUIStore.getState().setRoute('chat');
  if (change === 'account') useAuthStore.setState({localUserId:'other-page-account'});
  if (change === 'root') setStoredProjectRoot(scope.projectId,'C:/other-project-root');
}
function ChangeScopeBeforeClaim({change}: {change:CitationScopeChange}) {
  const route = useUIStore(state => state.route);
  React.useEffect(() => {
    if (route === 'context') interruptCitationScope(change);
  }, [change, route]);
  return <Shell />;
}

it.each(['route','account','root'] as const)(
  'a %s change before the queued initial claim prevents any source selection', async (change) => {
    render(<React.StrictMode><ChangeScopeBeforeClaim change={change} /></React.StrictMode>);
    fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
    await waitFor(() => expect(io.openResults).toHaveLength(1));
    expect(io.openResults[0]).not.toBe('completed');
    expect(io.selectCalls).toEqual([]);
    expect((await io.service!.load(scope.accountId,scope.projectId)).selectedMapId).toBe('page-map-B');
  },
);

it.each(['route','account','root'] as const)(
  'a %s change after a StrictMode claim revokes held selection immediately', async (change) => {
    let release!: () => void;
    io.heldSelection=new Promise(resolve => {release=resolve;});
    render(<React.StrictMode><Shell /></React.StrictMode>);
    fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
    await waitFor(() => expect(io.selectingA).toBe(true));
    expect(io.selectionSignals).toHaveLength(1);
    expect(io.selectionSignals[0]!.aborted).toBe(false);
    act(() => interruptCitationScope(change));
    expect(io.selectionSignals[0]!.aborted).toBe(true);
    await act(async () => {release();await new Promise(resolve=>setTimeout(resolve,10));});
    expect(io.openResults[0]).not.toBe('completed');
    expect((await io.service!.load(scope.accountId,scope.projectId)).selectedMapId).toBe('page-map-B');
  },
);

it('a real unmount before the queued initial claim cannot consume or revive after expiry',async()=>{
  io.nav!.dispose();
  const state = await io.service!.load(scope.accountId,scope.projectId);
  const map = state.maps.find(map=>map.id==='page-map-A')!;
  io.nav=createContextEvidenceNavigation({database,timeoutMs:150,revalidate:async(input)=>{
    input.assertCurrent();
    return {accountId:scope.accountId,projectId:scope.projectId,mapId:map.id,
      entityId:map.tree.nodes[0]!.id,path:`${scope.worktreeId}/linked-file.txt`,mapUpdatedAt:map.updatedAt};
  }});
  function UnmountContextBeforeClaim() {
    const route=useUIStore(state=>state.route);
    const [removed,setRemoved]=React.useState(false);
    React.useLayoutEffect(()=>{if(route==='context')setRemoved(true);},[route]);
    return removed ? null : <Shell />;
  }
  const mounted=render(<React.StrictMode><UnmountContextBeforeClaim /></React.StrictMode>);
  fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
  await waitFor(()=>expect(useUIStore.getState().route).toBe('context'));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  expect(mounted.container.innerHTML).toBe('');
  expect(io.selectCalls).toEqual([]);
  expect((await io.service!.load(scope.accountId,scope.projectId)).selectedMapId).toBe('page-map-B');
  await waitFor(()=>expect(io.openResults).toHaveLength(1));
  expect(io.openResults[0]).toContain('context_evidence_navigation_unavailable');
  mounted.unmount();
  render(<React.StrictMode><ContextPage /></React.StrictMode>);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  expect(io.selectCalls).toEqual([]);
  expect((await io.service!.load(scope.accountId,scope.projectId)).selectedMapId).toBe('page-map-B');
});


it('keeps a freshly opened canonical source visible after unchanged index hydration completes',async()=>{
  const {buildProjectContextTreeFromSiyuanIndex}=await import('./siyuan/siyuanSafeIndex');
  const initial=(await io.service!.load(scope.accountId,scope.projectId)).maps.find(map=>map.id==='page-map-A')!;
  io.entries=[{nodeId:'node-file',parentNodeId:null,title:'linked-file.txt',kind:'file',relativePath:'linked-file.txt',sourcePointer:'C:/owned-page/linked-file.txt',summary:'Owned source',sizeBytes:4,modifiedAt:1}];
  const built=buildProjectContextTreeFromSiyuanIndex(initial.tree,io.entries);
  const state=await io.service!.saveTree(scope.accountId,built,{mapId:initial.id,sourceStatus:'ready'});
  const map=state.maps.find(map=>map.id===initial.id)!;
  io.job={schemaVersion:1,scope:'fixture',accountId:scope.accountId,projectId:scope.projectId,mapId:map.id,canonicalRoot:map.rootDir,policyFingerprint:'fixture',status:'completed',phase:'completed',pauseReason:null,cursor:1,frontierLength:0,indexed:1,excluded:0,unreadable:0,summarized:0,summaryEligible:0,createdNodes:1,failed:0,skipped:0,inputTokens:0,outputTokens:0,totalTokens:0,tokenProvenance:'none',summaryProviderId:null,summaryConnectionId:null,summaryModelId:null,phaseStartedAt:1,rateSamples:[],discoverySamples:[],estimatedPercent:100,estimatedEtaSeconds:null,reconciledAt:1,pendingNativeNodeIds:[],startupDisposition:null,startupDispositionAt:null,pausedMs:0,startedAt:1,updatedAt:2,completedAt:2};
  let release!:()=>void;io.jobGate=new Promise(resolve=>{release=resolve;});
  io.nav!.dispose();
  io.nav=createContextEvidenceNavigation({database,revalidate:async input=>{input.assertCurrent();return {accountId:scope.accountId,projectId:scope.projectId,mapId:map.id,entityId:map.tree.nodes[0]!.id,path:`${scope.worktreeId}/linked-file.txt`,mapUpdatedAt:map.updatedAt};}});
  const before=await database.context_maps.get(map.id);
  render(<React.StrictMode><Shell /></React.StrictMode>);
  fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
  await waitFor(()=>expect(io.openResults).toEqual(['completed']));
  await act(async()=>{release();});
  await waitFor(()=>expect(io.repair).toHaveBeenCalled());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  expect(await database.context_maps.get(map.id)).toEqual(before);
  expect(screen.getByRole('heading',{name:'linked-file.txt'})).toBeTruthy();
});


async function prepareNativeSnapshot() {
  const { buildProjectContextTreeFromSiyuanIndex } = await import('./siyuan/siyuanSafeIndex');
  const initial = (await io.service!.load(scope.accountId, scope.projectId)).maps.find(
    (map) => map.id === 'page-map-A',
  )!;
  io.entries = [{
    nodeId: 'node-file', parentNodeId: null, title: 'linked-file.txt', kind: 'file',
    relativePath: 'linked-file.txt', sourcePointer: `${scope.worktreeId}/linked-file.txt`,
    summary: 'Owned source', sizeBytes: 4, modifiedAt: 1,
  }];
  const rawTree = buildProjectContextTreeFromSiyuanIndex(initial.tree, io.entries);
  const state = await io.service!.saveTree(scope.accountId, rawTree, {
    mapId: initial.id, sourceStatus: 'ready',
  });
  const map = state.maps.find((candidate) => candidate.id === initial.id)!;
  expect(rawTree.nodes[0]!.id).not.toBe(map.tree.nodes[0]!.id);
  io.job = {
    schemaVersion: 1, scope: 'fixture', accountId: scope.accountId,
    projectId: scope.projectId, mapId: map.id, canonicalRoot: map.rootDir,
    policyFingerprint: 'fixture', status: 'completed', phase: 'completed',
    pauseReason: null, cursor: 1, frontierLength: 0, indexed: 1, excluded: 0,
    unreadable: 0, summarized: 0, summaryEligible: 0, createdNodes: 1,
    failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    tokenProvenance: 'none', summaryProviderId: null, summaryConnectionId: null,
    summaryModelId: null, phaseStartedAt: 1, rateSamples: [], discoverySamples: [],
    estimatedPercent: 100, estimatedEtaSeconds: null, reconciledAt: 1,
    pendingNativeNodeIds: [], startupDisposition: null, startupDispositionAt: null,
    pausedMs: 0, startedAt: 1, updatedAt: 2, completedAt: 2,
  };
  io.readTrees[map.id] = rawTree;
  io.nav!.dispose();
  io.nav = createContextEvidenceNavigation({
    database,
    revalidate: async (input) => {
      input.assertCurrent();
      return {
        accountId: scope.accountId, projectId: scope.projectId, mapId: map.id,
        entityId: map.tree.nodes[0]!.id, path: `${scope.worktreeId}/linked-file.txt`,
        mapUpdatedAt: map.updatedAt,
      };
    },
  });
  return { map, rawTree };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each([false, true])('keeps the canonical saved source after a late raw-index SiYuan snapshot (deferred hydration=%s)', async (deferredHydration) => {
  const { map } = await prepareNativeSnapshot();
  const read = deferred();
  const hydration = deferred();
  io.readGate = read.promise;
  if (deferredHydration) io.jobGate = hydration.promise;
  const before = await database.context_maps.get(map.id);
  render(<React.StrictMode><Shell /></React.StrictMode>);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await act(async () => { hydration.resolve(); });
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  await waitFor(() => expect(io.repair).toHaveBeenCalled());
  if (deferredHydration) {
    await waitFor(() => expect(screen.getByRole('heading', { name: 'linked-file.txt' })).toBeTruthy());
  }
  await act(async () => { read.resolve(); });
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  expect(await database.context_maps.get(map.id)).toEqual(before);
  expect(screen.getByRole('heading', { name: 'linked-file.txt' })).toBeTruthy();
});

it.each(['summary', 'size', 'title'] as const)('preserves a genuinely changed native snapshot (%s)', async (changedField) => {
  const { map, rawTree } = await prepareNativeSnapshot();
  const nativeTree = structuredClone(rawTree);
  if (changedField === 'summary') nativeTree.nodes[0]!.summary = 'User-edited SiYuan content';
  if (changedField === 'size') nativeTree.nodes[0]!.sizeBytes = 123;
  if (changedField === 'title') nativeTree.nodes[0]!.title = 'Native source title';
  io.readTrees[map.id] = nativeTree;
  const read = deferred();
  io.readGate = read.promise;
  const before = await database.context_maps.get(map.id);
  render(<ContextPage />);
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  await waitFor(() => expect(io.repair).toHaveBeenCalled());
  await act(async () => { read.resolve(); });
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: nativeTree.nodes[0]!.title }));
  expect(screen.getByRole('heading', { name: nativeTree.nodes[0]!.title })).toBeTruthy();
  if (changedField === 'summary') expect(screen.getAllByText('User-edited SiYuan content').length).toBeGreaterThan(0);
  if (changedField === 'size') expect(screen.getAllByText('123 B').length).toBeGreaterThan(0);
  expect(await database.context_maps.get(map.id)).toEqual(before);
});

it('cannot replace a newer Map B view when an old native snapshot resolves', async () => {
  const { map } = await prepareNativeSnapshot();
  const read = deferred();
  io.readGate = read.promise;
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  io.readGate = undefined;
  fireEvent.click(screen.getByRole('button', { name: /^Map B/ }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Map B' })).toBeTruthy());
  await act(async () => { read.resolve(); });
  expect(screen.getByRole('heading', { name: 'Map B' })).toBeTruthy();
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe('page-map-B');
});

it.each(['project', 'unmount'] as const)('discards a delayed native snapshot after %s revocation', async (transition) => {
  const { map } = await prepareNativeSnapshot();
  const read = deferred();
  io.readGate = read.promise;
  const mounted = render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  if (transition === 'project') {
    await act(async () => { useAuthStore.setState({ projectId: 'another-project' as ProjectId }); });
  } else {
    mounted.unmount();
  }
  await act(async () => { read.resolve(); });
  expect(screen.queryByRole('heading', { name: 'linked-file.txt' })).toBeNull();
  expect(screen.queryByText('SiYuan Context Map ready.')).toBeNull();
});


it('cannot publish an old snapshot when the project changes during display equivalence', async () => {
  const { map } = await prepareNativeSnapshot();
  const read = deferred();
  io.readGate = read.promise;
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  await waitFor(() => expect(io.repair).toHaveBeenCalled());
  const readsBefore = io.equivalenceReads;
  const comparison = deferred();
  io.equivalenceGate = comparison.promise;
  await act(async () => { read.resolve(); });
  await waitFor(() => expect(io.equivalenceReads).toBeGreaterThan(readsBefore));
  await act(async () => { useAuthStore.setState({ projectId: 'another-project' as ProjectId }); });
  await act(async () => { comparison.resolve(); });
  expect(screen.queryByRole('heading', { name: 'linked-file.txt' })).toBeNull();
  expect(screen.queryByText('SiYuan Context Map ready.')).toBeNull();
});


function ActualLazyRouteShell({ sidebar }: { sidebar: boolean }) {
  const route = useUIStore((state) => state.route);
  return <>
    {sidebar ? <SidebarContextTree navOpen onOpenContext={() => useUIStore.getState().setRoute('context')} /> : null}
    {route === 'chat' ? (
      <MessagePart part={part} allParts={[part]} chatId={scope.chatId} messageId={'page-message' as MessageId} />
    ) : <PageRouter />}
  </>;
}

it.each([false, true])('retains the cited entity through actual lazy PageRouter mounting (sidebar=%s)', async (sidebar) => {
  const { map } = await prepareNativeSnapshot();
  const read = deferred();
  io.readGate = read.promise;
  const before = await database.context_maps.get(map.id);
  render(<React.StrictMode><ActualLazyRouteShell sidebar={sidebar} /></React.StrictMode>);
  if (sidebar) await screen.findByRole('button', { name: /Map A/ });
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  await act(async () => { read.resolve(); });
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'linked-file.txt' })).toBeTruthy();
  expect(await database.context_maps.get(map.id)).toEqual(before);
});

it('retains a cited file after a same-map persistence publication through the actual route', async () => {
  const { map } = await prepareNativeSnapshot();
  const read = deferred();
  io.readGate = read.promise;
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  await screen.findByRole('button', { name: /Map A/ });
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  await act(async () => { read.resolve(); });
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'linked-file.txt' })).toBeTruthy();
  const before = await database.context_maps.get(map.id);
  const readCount = io.readStarted.length;
  // A real load republishes an equivalent durable map using fresh objects.
  // It must not turn a previously selected source into the project root.
  await act(async () => { await io.service!.load(scope.accountId, scope.projectId); });
  await waitFor(() => expect(io.readStarted.length).toBeGreaterThan(readCount));
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  expect(await database.context_maps.get(map.id)).toEqual(before);
  expect(screen.getByRole('heading', { name: 'linked-file.txt' })).toBeTruthy();
});

it('drops the old cited selection when a genuinely changed native tree removes its entity', async () => {
  const { map, rawTree } = await prepareNativeSnapshot();
  const read = deferred();
  io.readGate = read.promise;
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  await screen.findByRole('button', { name: /Map A/ });
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.openResults).toEqual(['completed']));
  await waitFor(() => expect(io.readStarted).toContain(map.id));
  await act(async () => { read.resolve(); });
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'linked-file.txt' })).toBeTruthy();
  io.readTrees[map.id] = { ...rawTree, nodes: [{
    id: 'replacement-node', title: 'replacement.txt', kind: 'file',
    path: 'replacement.txt', summary: 'A genuinely changed native tree', sizeBytes: 8, modifiedAt: 2,
  }] };
  const count = io.readStarted.length;
  await act(async () => { await io.service!.load(scope.accountId, scope.projectId); });
  await waitFor(() => expect(io.readStarted.length).toBeGreaterThan(count));
  await waitFor(() => expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  expect(screen.queryByRole('heading', { name: 'linked-file.txt' })).toBeNull();
  expect(screen.getByRole('button', { name: 'replacement.txt' })).toBeTruthy();
});

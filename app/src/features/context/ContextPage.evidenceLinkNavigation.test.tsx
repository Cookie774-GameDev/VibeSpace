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
import type { ContextMapRecord, ProjectContextTree } from './tree';
import type { ProductionSiyuanRlmPort, SiyuanManagedDocument } from './siyuanRlmProduction';
import type { SiyuanContextMapSyncOptions } from './siyuanContextMapIntegration';
import { setStoredProjectRoot } from '@/features/files/projectFiles';
import { canonicalContextUri } from '@/lib/harness/toolGatewayCitations';
import type { Part } from '@/types/chat';
const io = vi.hoisted(() => ({
  state: null as ContextPersistenceState | null,
  persistenceGate: undefined as Promise<void> | undefined,
  realIntegration: null as ReturnType<typeof import('./siyuanContextMapIntegration').createSiyuanContextMapIntegration> | null,
  realJobs: false,
  populate: vi.fn(),
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
    sync: (project: string, map: ContextMapRecord, options: SiyuanContextMapSyncOptions) => io.realIntegration!.sync(project, map, {
      ...options, list: async path => ({ok: true, path, entries: [{ name: 'shared.txt', path: `${map.rootDir}/shared.txt`, isDir: false, size: 48, modifiedMs: 100 }]}),
    }),
    read: async (_project: unknown, map: { id: string; tree: ProjectContextTree }) => {
      if (io.realIntegration) return io.realIntegration.read(String(_project), map as ContextMapRecord);
      const tree = io.readTrees[map.id] ?? map.tree;
      io.readStarted.push(map.id);
      await io.readGate;
      return { tree };
    },
  },
}));
vi.mock('./siyuan/siyuanIndexJobStore', async (original) => {
  const actual = await original<typeof import('./siyuan/siyuanIndexJobStore')>();
  return {...actual,
    readSiyuanIndexJob: async (project:string,mapId:string) => {if(io.realJobs)return actual.readSiyuanIndexJob(project,mapId);await io.jobGate;return mapId==='page-map-A' ? io.job : null;},
    readSiyuanIndexEntries: async (project:string,mapId:string) => {if(io.realJobs)return actual.readSiyuanIndexEntries(project,mapId);await io.entriesGate;return io.entries;},
  };
});
vi.mock('./contextSearchIndexing', () => ({createContextSearchIndexPopulationPort:()=>({repairEmptyMap:io.repair,populateCreatedMap:io.populate})}));
vi.mock('./contextPersistence', async (original) => ({
  ...(await original<typeof import('./contextPersistence')>()),
  ensureContextPersistence: () => {
    const gate = io.persistenceGate;
    return gate ? gate.then(() => io.service!.load('page-account', 'page-project'))
      : io.service!.load('page-account', 'page-project');
  },
  getActiveContextPersistenceState: () => io.state,
  loadPersistedContextMaps: async (projectId:string) => (await io.service!.load('page-account',projectId)).maps,
  selectPersistedContextFile: (projectId:string,path:string,target?:{mapId:string;entityId:string}) => io.service!.selectFile('page-account',projectId,path,target),
  hasEquivalentPersistedContextTree: async (_project:string,mapId:string,tree:ProjectContextTree,expected:number,signal?:AbortSignal) => {
    const equivalent = await io.service!.hasEquivalentTree('page-account',tree,mapId,expected,signal);
    io.equivalenceReads += 1;
    await io.equivalenceGate;
    return equivalent;
  },
  savePersistedContextTree: (tree:ProjectContextTree,options:any) => io.service!.saveTree('page-account',tree,options),
  setPersistedContextSourceStatus: (project:string,mapId:string,status:'indexing'|'ready'|'error',expected:number,signal?:AbortSignal) => io.service!.setSourceStatus('page-account',project,mapId,status,expected,signal),
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
import { ContextPage, resolveContextDisplaySelection } from './ContextPage';
import { MessagePart } from '@/features/chat/MessagePart';
import { PageRouter } from '@/components/layout/PageRouter';
import { SidebarContextTree } from './SidebarContextTree';
import { createProductionTerminalCliRuntimeDependencies } from '@/features/terminals/terminalCliProduction';

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
  io.persistenceGate = undefined;
  io.realIntegration = null;io.realJobs = false;io.populate.mockReset();io.populate.mockResolvedValue({status:'ready',documentCount:1,bodyBytes:48});
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


async function prepareNativeSnapshot(indexingThenReady = false) {
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
  const saved = await io.service!.saveTree(scope.accountId, rawTree, {
    mapId: initial.id, sourceStatus: indexingThenReady ? 'indexing' : 'ready',
  });
  const indexedMap = saved.maps.find(candidate => candidate.id === initial.id)!;
  const state = indexingThenReady
    ? await io.service!.setSourceStatus(scope.accountId, scope.projectId, initial.id, 'ready', indexedMap.updatedAt)
    : saved;
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

async function prepareOverlappingSavedFile() {
  const original = await io.service!.load(scope.accountId, scope.projectId);
  const target = original.maps[1]!;
  const other = original.maps[0]!;
  for (const map of [target, other]) {
    await io.service!.saveTree(scope.accountId, {
      version: 1, projectId: scope.projectId, rootDir: map.rootDir,
      generatedAt: 1, model: 'siyuan-managed-v1', fileCount: 1, totalBytes: 4,
      summary: 'Owned C04 source', nodes: [{id:'c04-file',kind:'file',path:'shared.txt',
        title:map.id===target.id?'C04 target source':'C04 other source',summary:'',sizeBytes:4,modifiedAt:1}],
    }, {mapId:map.id,name:map.name,sourceStatus:'ready'});
  }
  const selected = await io.service!.selectFile(scope.accountId, scope.projectId, `${target.rootDir}/shared.txt`);
  expect(selected.selectedMapId).toBe(target.id);
  expect(selected.selectedFile).toBe('shared.txt');
  return { target, other };
}

it('restores the saved file within its persisted map when another map shares the relative path', async () => {
  await prepareOverlappingSavedFile();
  useUIStore.getState().setRoute('context');
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  await waitFor(() => expect(document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent).toBe('C04 target source'));
});

it('restores a new saved map selection even when its relative file path is unchanged', async () => {
  const { other } = await prepareOverlappingSavedFile();
  useUIStore.getState().setRoute('context');
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  const heading = () => document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent;
  await waitFor(() => expect(heading()).toBe('C04 target source'));
  await act(async () => {
    const selected=await io.service!.selectFile(scope.accountId,scope.projectId,`${other.rootDir}/shared.txt`);
    expect(selected.selectedMapId).toBe(other.id);
    expect(selected.selectedFile).toBe('shared.txt');
  });
  await waitFor(() => expect(heading()).toBe('C04 other source'));
});

it('clears a restored source when the active project scope is revoked', async () => {
  await prepareOverlappingSavedFile();
  useUIStore.getState().setRoute('context');
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  await waitFor(() => expect(screen.getByRole('heading',{name:'C04 target source'})).toBeTruthy());
  await act(async () => useAuthStore.getState().setProjectId('c04-foreign-project' as ProjectId));
  await waitFor(() => {
    expect(screen.queryByRole('heading',{name:'C04 target source'})).toBeNull();
    expect(screen.queryByRole('heading',{name:'C04 other source'})).toBeNull();
  });
});


it('restores the same saved file after an intervening map-only selection cleared it', async () => {
  const { target, other } = await prepareOverlappingSavedFile();
  useUIStore.getState().setRoute('context');
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  const heading = () => document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent;
  await waitFor(() => expect(heading()).toBe('C04 target source'));
  await act(async () => {
    const selected=await io.service!.selectMap(scope.accountId,scope.projectId,other.id);
    expect(selected.selectedFile).toBeNull();
  });
  await waitFor(() => expect(heading()).not.toBe('C04 target source'));
  await act(async () => {
    await io.service!.selectFile(scope.accountId,scope.projectId,`${target.rootDir}/shared.txt`);
  });
  await waitFor(() => expect(heading()).toBe('C04 target source'));
});


it.each(['citation','terminal'] as const)('opens the actual %s source after indexing-to-ready without a metadata-only graph write',async consumer=>{
  const {map}=await prepareNativeSnapshot(true);
  const before=await database.context_maps.get(map.id);
  const sourcesBefore=await database.context_sources.toArray();
  render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
  if(consumer==='citation')fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
  else {
    const dependencies=createProductionTerminalCliRuntimeDependencies();
    const resolved=await dependencies.resolveContextEntity(scope.projectId,map.tree.nodes[0]!.id);
    expect(resolved).toMatchObject({mapId:map.id,id:map.tree.nodes[0]!.id,path:'linked-file.txt'});
    await act(async()=>{await dependencies.openContextEntity(scope.projectId,resolved!);});
  }
  await waitFor(()=>expect(io.readStarted).toContain(map.id));
  await waitFor(()=>expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
  await waitFor(()=>expect(document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent).toBe('linked-file.txt'));
  expect(await database.context_maps.get(map.id)).toEqual(before);
  expect(await database.context_sources.toArray()).toEqual(sourcesBefore);
});

it.each(['citation','terminal'] as const)('preserves the actual %s selection when native read precedes completed-job hydration after readiness',async consumer=>{
  const {map}=await prepareNativeSnapshot(true);
  const read=deferred(),hydration=deferred();
  io.readGate=read.promise;io.entriesGate=hydration.promise;
  try {
    render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
    if(consumer==='citation') {
      fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
      await waitFor(()=>expect(io.openResults).toEqual(['completed']));
    } else {
      const dependencies=createProductionTerminalCliRuntimeDependencies();
      const resolved=(await dependencies.resolveContextEntity(scope.projectId,map.tree.nodes[0]!.id))!;
      await act(async()=>{await dependencies.openContextEntity(scope.projectId,resolved);});
    }
    await waitFor(()=>expect(io.readStarted).toContain(map.id));
    await act(async()=>{read.resolve();});
    await waitFor(()=>expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
    await waitFor(()=>expect(document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent).toBe('linked-file.txt'));
  } finally {read.resolve();hydration.resolve();}
});


async function retainC07Part(map:ContextMapRecord) {
  const node=map.tree.nodes.find(node=>node.kind==='file')!;
  const pointer={id:'c07-pointer',recordId:'c07-record',byteStart:0,byteEnd:4,sourceVersion:`sha256:${'a'.repeat(64)}`,contentHash:'a'.repeat(64)};
  const uri=canonicalContextUri('evidence',pointer.id);
  const target={uri,mapId:map.id,entityId:node.id,rootDir:map.rootDir,sourcePath:`${map.rootDir}/${node.path}`,sourceKind:'file_version' as const,membershipRevision:`sha256:${'b'.repeat(64)}`,pointer};
  await createContextEvidenceLinkStore(database).retain(scope,{runId:'c07-run',requestId:'c07-request',attemptNumber:1},[target],{signal:new AbortController().signal,assertCurrent(){}});
  part={kind:'jarvis_source_ref',source:{id:pointer.id,kind:'context_node',label:'Open verified Context source',uri,trust:'app_verified',sensitivity:'private'}};
  await database.messages.update('page-message' as MessageId,{parts:[part]});
  io.nav!.dispose();
  io.nav=createContextEvidenceNavigation({database,revalidate:async input=>{
    input.assertCurrent();
    return {accountId:scope.accountId,projectId:scope.projectId,mapId:map.id,entityId:node.id,path:target.sourcePath,mapUpdatedAt:map.updatedAt};
  }});
}

it.each(['terminal','citation'] as const)('C07 retains the first %s file selection after real create sync payload and durable readiness', async consumer => {
  // Use the production integration/scanner/checkpoints; only native transport
  // and filesystem discovery are deterministic boundaries in this code check.
  const actual = await vi.importActual<typeof import('./siyuanContextMapIntegration')>('./siyuanContextMapIntegration');
  const jobs = await vi.importActual<typeof import('./siyuan/siyuanIndexJobStore')>('./siyuan/siyuanIndexJobStore');
  const documents = new Map<string, SiyuanManagedDocument>();
  let sequence = 0;
  const port: ProductionSiyuanRlmPort = {
    searchBlocks: async () => [],
    getBlock: async (_project, id) => { const document = documents.get(id); if(!document)throw new Error('missing');return document; },
    listInboundBacklinks: async () => [],
    readManagedDocument: async (_project, lookup) => [...documents.values()].find(document => document.markdown.includes(lookup.marker)) ?? null,
    createManagedDocument: async (_project, path, markdown) => {
      const id = `20261008000000-${String(++sequence).padStart(7,'a')}`;
      const document = {id, notebookId:'20261008000000-notebk1', path, markdown};documents.set(id,document);return document;
    },
    updateManagedDocument: async (_project,id,expected,markdown) => {
      const document = documents.get(id);if(!document || document.markdown !== expected)throw new Error('siyuan_conflict');
      const updated={...document,markdown};documents.set(id,updated);return updated;
    },
    deleteManagedDocument: async (_project,id) => {documents.delete(id);},
    createManagedSnapshot: vi.fn(), stopActive: vi.fn(),
  };
  io.realIntegration = actual.createSiyuanContextMapIntegration(port);
  io.realJobs = true;
  const internals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const hydration=deferred();
  let clock=1_791_456_000_000;
  vi.spyOn(Date,'now').mockImplementation(()=>++clock);
  try {
    for(const map of io.state!.maps)await io.service!.deleteMap(scope.accountId,scope.projectId,map.id);
    useUIStore.getState().setRoute('context');
    render(<React.StrictMode><ActualLazyRouteShell sidebar /></React.StrictMode>);
    const root=await screen.findByRole('textbox',{name:'Context source folder'});
    fireEvent.change(root,{target:{value:'C:/owned-c07'}});
    fireEvent.click(screen.getByRole('radio',{name:'No summaries'}));
    fireEvent.click(screen.getByRole('button',{name:'Create Map'}));
    await waitFor(()=>expect(io.state!.maps.find(map=>map.status==='active')?.sourceStatus).toBe('ready'),{timeout:10_000});
    const created=io.state!.maps.find(map=>map.status==='active')!;
    await waitFor(()=>expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
    const job=await jobs.readSiyuanIndexJob(scope.projectId,created.id);
    expect(job).toMatchObject({status:'completed',phase:'completed',indexed:1,createdNodes:1,failed:0,pendingNativeNodeIds:[]});
    expect(job!.reconciledAt).not.toBeNull();
    const nativeRoot=[...documents.values()].find(document=>document.markdown.includes(`vibespace-context-map:v1 map=${created.id}`));
    expect(nativeRoot).toBeTruthy();
    const payload=/\bpayload=([A-Za-z0-9_-]+)\s*-->/u.exec(nativeRoot!.markdown)![1]!;
    const nativeTree=JSON.parse(atob(payload.replaceAll('-','+').replaceAll('_','/'))) as ProjectContextTree;
    const openedFile=created.tree.nodes.find(node=>node.kind==='file')!;
    const nativeEquivalent=await io.service!.hasEquivalentTree(scope.accountId,nativeTree,created.id,created.updatedAt);
    const timestampOnlyDiagnostic=await io.service!.hasEquivalentTree(scope.accountId,{...nativeTree,generatedAt:created.tree.generatedAt},created.id,created.updatedAt);
    expect(nativeEquivalent).toBe(false);
    expect(timestampOnlyDiagnostic).toBe(true);
    console.log('C07_CREATE_JOIN',JSON.stringify({mapId:created.id,jobStatus:job!.status,reconciledAt:job!.reconciledAt,nativeEquivalent,timestampOnlyDiagnostic,nativeGeneratedAt:nativeTree.generatedAt,persistedGeneratedAt:created.tree.generatedAt,nativeFileId:nativeTree.nodes[0]?.id,persistedFileId:openedFile.id}));
    if(consumer==='citation')await retainC07Part(created);
    await act(async()=>{useUIStore.getState().setRoute('chat');});
    io.repair.mockImplementation(async()=>{await hydration.promise;return {status:'ready',documentCount:1,bodyBytes:48};});
    const dependencies=createProductionTerminalCliRuntimeDependencies();
    const resolved=await dependencies.resolveContextEntity(scope.projectId,openedFile.id);
    expect(resolved).toMatchObject({mapId:created.id,id:openedFile.id,path:'shared.txt'});
    if(consumer==='terminal')await act(async()=>{await dependencies.openContextEntity(scope.projectId,resolved!);});
    else {fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));await waitFor(()=>expect(io.openResults).toEqual(['completed']));}
    await waitFor(()=>expect(screen.getByText('SiYuan Context Map ready.')).toBeTruthy());
    expect(io.state!.selectedMapId).toBe(created.id);
    if(consumer==='terminal')expect(io.state!.selectedFile).toBe('shared.txt');
    const transient=currentContextWorkspace();
    console.log('C07_TRANSIENT',JSON.stringify({consumer,displayId:transient?.tree.nodes[0]?.id,selectedId:transient?.selectedId}));
    await act(async()=>{hydration.resolve();});
    if(consumer==='terminal')await waitFor(()=>expect(currentContextWorkspace()?.tree.nodes[0]?.id).toBe(openedFile.id));
    else expect([nativeTree.nodes[0]!.id,openedFile.id]).toContain(currentContextWorkspace()?.tree.nodes[0]?.id);
    console.log('C07_OPEN_JOIN',JSON.stringify({consumer,displayId:currentContextWorkspace()?.tree.nodes[0]?.id,selectedId:currentContextWorkspace()?.selectedId,selectedMapId:io.state!.selectedMapId,selectedFile:io.state!.selectedFile,inspector:document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent}));
    const displayed=currentContextWorkspace()!;
    expect(displayed.map.id).toBe(created.id);
    expect(displayed.selected.path).toBe('shared.txt');
    expect(displayed.selected).toBe(displayed.tree.nodes[0]);
    const {contextEntityIdForTreeNode}=await import('./migration');
    expect(displayed.selected.id===openedFile.id?displayed.selected.id:contextEntityIdForTreeNode(created.id,displayed.selected.id)).toBe(openedFile.id);
    expect(displayed.selected.summary).toBe(nativeTree.nodes[0]!.summary);
    expect(displayed.tree.generatedAt).toBe(displayed.selected.id===openedFile.id?created.tree.generatedAt:nativeTree.generatedAt);
    await waitFor(()=>expect(document.querySelector('[data-monochrome-route="context"] [data-monochrome-surface="context-inspector"] h2')?.textContent).toBe('shared.txt'));
  } finally {
    hydration.resolve();
    cleanup();
    if(internals===undefined)delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;
    else (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__=internals;
    io.realIntegration=null;io.realJobs=false;
  }
},15_000);


it.each(['owned', 'canonical', 'native-manual', 'title', 'summary', 'size', 'mtime', 'generatedAt',
  'wrong-project', 'wrong-root', 'wrong-map', 'wrong-source', 'omitted-github-kind', 'omitted-file-kind', 'legacy-folder-kind', 'local-file', 'wrong-local-scope', 'inactive',
  'missing-member', 'deleted-native', 'kind', 'path', 'duplicate', 'canonical-raw-collision', 'canonical-kind', 'canonical-path', 'foreign-id'] as const)(
  'C07 projects only exact owned display identity (%s)', async scenario => {
    const map=structuredClone(io.state!.maps.find(map=>map.id==='page-map-A')!);
    const member=map.tree.nodes[0]!;
    const native:ProjectContextTree={...map.tree,generatedAt:1,nodes:[{
      id:'node-file',kind:'file',title:'Native title',summary:'Native text',path:'linked-file.txt',sizeBytes:4,modifiedAt:1,
    }]};
    const node=native.nodes[0]!;
    let selectedId=member.id;
    if(scenario==='canonical')node.id=member.id;
    if(scenario==='native-manual')selectedId=node.id;
    if(scenario==='title')node.title='New native title';
    if(scenario==='summary')node.summary='New native summary';
    if(scenario==='size')node.sizeBytes=99;
    if(scenario==='mtime')node.modifiedAt=99;
    if(scenario==='generatedAt')native.generatedAt=999;
    if(scenario==='wrong-project')native.projectId='other-project';
    if(scenario==='wrong-root')native.rootDir='C:/other-root';
    if(scenario==='wrong-map')map.id='page-map-B';
    if(scenario==='wrong-source')native.sourceType='github_repository';
    if(scenario==='omitted-github-kind'){map.sourceType='github_repository';delete native.sourceType;}
    if(scenario==='omitted-file-kind'){map.sourceType='local_file';delete native.sourceType;}
    if(scenario==='legacy-folder-kind')delete native.sourceType;
    if(scenario==='local-file'){map.sourceType='local_file';native.sourceType='local_file';map.localFileScope={version:1,rootDir:map.rootDir,filePath:map.rootDir+'/linked-file.txt'};native.localFileScope={...map.localFileScope};}
    if(scenario==='wrong-local-scope')native.localFileScope={version:1,rootDir:native.rootDir,filePath:native.rootDir+'/other.txt'};
    if(scenario==='inactive')map.status='deleted';
    if(scenario==='missing-member')map.tree.nodes=[];
    if(scenario==='deleted-native')native.nodes=[];
    if(scenario==='kind')node.kind='note';
    if(scenario==='path')node.path='renamed.txt';
    if(scenario==='duplicate')native.nodes.push({...node});
    if(scenario==='canonical-raw-collision')native.nodes.push({...node,id:member.id});
    if(scenario==='canonical-kind'){node.id=member.id;node.kind='note';}
    if(scenario==='canonical-path'){node.id=member.id;node.path='renamed.txt';}
    if(scenario==='foreign-id')node.id='page-map-B:node-file';
    const before=structuredClone({map,native});
    const selected=resolveContextDisplaySelection(map,native,selectedId);
    const positive=['owned','canonical','native-manual','title','summary','size','mtime','generatedAt','legacy-folder-kind','local-file'].includes(scenario);
    expect(selected).toBe(positive?node:null);
    expect({map,native}).toEqual(before);
    if(positive) {
      const {nodeToAttachment}=await import('./tree');
      expect(nodeToAttachment(native,selected!)).toEqual(nodeToAttachment(native,node));
      expect(selected!.id).toBe(node.id);
    }
  },
);

// Commit-time observer only: read the same workspace that owns the visible DOM.
function currentContextWorkspace() {
  const element=document.querySelector('[data-monochrome-surface="context-inspector"]');
  if(!element)return null;
  const key=Object.keys(element).find(key=>key.startsWith('__reactFiber$'));
  if(!key)return null;
  type Fiber={return:Fiber|null;alternate:Fiber|null;type?:{name?:string};memoizedProps:any;stateNode?:{current?:Fiber}};
  let fiber=(element as unknown as Record<string,Fiber>)[key]!;
  let root=fiber;while(root.return)root=root.return;
  if(root.stateNode?.current!==root && fiber.alternate)fiber=fiber.alternate;
  while(fiber && fiber.type?.name!=='ContextMapWorkspace')fiber=fiber.return!;
  return fiber?.memoizedProps as {map:ContextMapRecord;tree:ProjectContextTree;selected:import('./tree').ContextTreeNode;selectedId:string}|undefined;
}

it.each(['terminal','citation'] as const)('C07 never associates a held native tree with another same-root map (%s)', async consumer=>{
  const raw=(name:string):ProjectContextTree=>({version:1,projectId:scope.projectId,rootDir:scope.worktreeId,generatedAt:1,
    model:'siyuan-managed-v1',fileCount:1,totalBytes:4,summary:name,nodes:[{id:'same-raw-id',kind:'file',title:name,path:'shared.txt',summary:name,sizeBytes:4,modifiedAt:1}]});
  for(const id of ['page-map-A','page-map-B']) {
    const tree=raw(id==='page-map-A'?'Native A only':'Native B only');
    await io.service!.saveTree(scope.accountId,{...tree,generatedAt:2},{mapId:id,sourceStatus:'ready'});
    io.readTrees[id]=tree;
  }
  await io.service!.selectFile(scope.accountId,scope.projectId,'shared.txt',{
    mapId:'page-map-A',entityId:io.state!.maps.find(map=>map.id==='page-map-A')!.tree.nodes[0]!.id,
  });
  const commits:Array<{mapId:string;title:string;treeTitle:string}>=[];
  const mapB=io.state!.maps.find(map=>map.id==='page-map-B')!;
  await retainC07Part(mapB);
  useUIStore.getState().setRoute('context');
  render(<React.Profiler id="C07-owners" onRender={()=>{
    const props=currentContextWorkspace();if(props)commits.push({mapId:props.map.id,title:props.selected.title,treeTitle:props.tree.nodes[0]!.title});
  }}><ContextPage/><MessagePart part={part} allParts={[part]} chatId={scope.chatId} messageId={'page-message' as MessageId}/></React.Profiler>);
  await screen.findByRole('heading',{name:'Native A only'});
  const held=deferred();io.readGate=held.promise;
  try {
    if(consumer==='citation') {
      fireEvent.click(screen.getByRole('button',{name:'Open verified Context source'}));
      await waitFor(()=>expect(io.openResults).toEqual(['completed']));
    } else {
      const dependencies=createProductionTerminalCliRuntimeDependencies();
      const resolved=(await dependencies.resolveContextEntity(scope.projectId,mapB.tree.nodes[0]!.id))!;
      await act(async()=>{await dependencies.openContextEntity(scope.projectId,resolved);});
    }
    await waitFor(()=>expect(io.readStarted).toContain(mapB.id));
    await act(async()=>{held.resolve();});
    await screen.findByRole('heading',{name:'Native B only'});
    console.log('C07_OWNER_COMMITS',JSON.stringify(commits));
    expect(commits.filter(commit=>commit.mapId===mapB.id && commit.treeTitle==='Native A only')).toEqual([]);
  } finally {held.resolve();}
});


it('C07 does not adopt a held snapshot after workspace ABA before the current owner reads', async()=>{
  const {map}=await prepareNativeSnapshot();
  await io.service!.selectFile(scope.accountId,scope.projectId,'linked-file.txt',{mapId:map.id,entityId:map.tree.nodes[0]!.id});
  const old=deferred(),fresh=deferred();io.readGate=old.promise;io.jobGate=old.promise;
  useUIStore.getState().setRoute('context');
  render(<React.StrictMode><ActualLazyRouteShell sidebar/></React.StrictMode>);
  try {
    await act(async()=>{old.resolve();});
    await screen.findByRole('heading',{name:'linked-file.txt'});
    const reads=io.readStarted.length;
    io.readGate=old.promise;
    // New gates distinguish the departed owner from the returning owner.
    const departed=deferred();io.readGate=departed.promise;
    await act(async()=>{useAuthStore.setState({workspaceId:'c07-away' as WorkspaceId});});
    await waitFor(()=>expect(io.readStarted.length).toBeGreaterThan(reads));
    io.readGate=fresh.promise;
    await act(async()=>{useAuthStore.setState({workspaceId:scope.workspaceId as WorkspaceId});});
    await act(async()=>{departed.resolve();});
    expect(currentContextWorkspace()).toBeNull();
    await act(async()=>{fresh.resolve();});
    await screen.findByRole('heading',{name:'linked-file.txt'});
  } finally {old.resolve();fresh.resolve();}
});

it('C09 displays the scoped recovery notice when real persistence quarantines an incomplete graph', async () => {
  const ownedEntity = (await database.context_entities.where('mapId').equals('page-map-A').toArray())[0]!;
  await database.context_entities.update(ownedEntity.id, { summary: 'C09_QUARANTINED_PAYLOAD_SENTINEL' });
  await database.context_sources.where('mapId').equals('page-map-A').delete();
  const state = await io.service!.load(scope.accountId, scope.projectId);
  expect(state.maps.map(map => map.id)).toEqual(['page-map-B']);
  expect(state.recovery).toMatchObject({ issueCount: 1 });
  expect(state.recovery!.options.map(option => option.id)).toEqual(['retry', 'restore_backup', 'export_then_discard']);
  const quarantined = await database.context_quarantine.toArray();
  expect(quarantined).toHaveLength(1);
  expect(quarantined[0]).toMatchObject({ accountId: scope.accountId, mapId: 'page-map-A' });
  const preservedPayload = structuredClone(quarantined[0]!.raw);
  render(<ContextPage />);
  await screen.findByRole('button', { name: /^Map B/ });
  console.log('C09_RECOVERY_JOIN', JSON.stringify({
    account: state.accountId, project: state.projectId, issueCount: state.recovery?.issueCount,
    mapIds: state.maps.map(map => map.id), noticeCount: screen.queryAllByRole('status', { name: 'Context recovery options' }).length,
  }));
  expect(screen.queryByText('C09_QUARANTINED_PAYLOAD_SENTINEL')).toBeNull();
  expect((await database.context_quarantine.toArray())[0]!.raw).toEqual(preservedPayload);
  expect(await screen.findByRole('status', { name: 'Context recovery options' })).toBeTruthy();
});


async function quarantineC09Map() {
  await database.context_sources.where('mapId').equals('page-map-A').delete();
  const state = await io.service!.load(scope.accountId, scope.projectId);
  expect(state.recovery?.issueCount).toBe(1);
  return state;
}

it('C09 keeps a healthy page free of recovery warnings', async () => {
  const state = await io.service!.load(scope.accountId, scope.projectId);
  expect(state.recovery).toBeNull();
  render(<ContextPage />);
  await screen.findByRole('button', { name: /^Map B/ });
  expect(screen.queryByRole('status', { name: 'Context recovery options' })).toBeNull();
});

it('C09 keeps the scoped informational notice visible when focusing a healthy neighbor', async () => {
  await quarantineC09Map();
  render(<ContextPage />);
  await screen.findByRole('status', { name: 'Context recovery options' });
  fireEvent.click(await screen.findByRole('button', { name: /^Map B/ }));
  await screen.findByRole('button', { name: 'Back to Context Maps' });
  expect(screen.getAllByRole('status', { name: 'Context recovery options' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /Restore backup|Retry recovery|Export then discard/ })).toBeNull();
});

it.each(['account', 'project', 'workspace'] as const)('C09 hides prior recovery immediately across %s ownership and a held late read, including return ABA', async dimension => {
  await quarantineC09Map();
  const commits: Array<{ account: string | null; workspace: unknown; project: unknown; notices: number }> = [];
  render(<React.Profiler id="c09-owner" onRender={() => {
    const state = useAuthStore.getState();
    commits.push({ account: state.localUserId, workspace: state.workspaceId, project: state.projectId,
      notices: screen.queryAllByRole('status', { name: 'Context recovery options' }).length });
  }}><ContextPage /></React.Profiler>);
  await screen.findByRole('status', { name: 'Context recovery options' });
  let release!: () => void;
  io.persistenceGate = new Promise<void>(resolve => { release = resolve; });
  await act(async () => {
    if (dimension === 'account') useAuthStore.setState({ localUserId: 'c09-foreign-account' });
    if (dimension === 'project') useAuthStore.setState({ projectId: 'c09-foreign-project' as ProjectId });
    if (dimension === 'workspace') useAuthStore.setState({ workspaceId: 'c09-foreign-workspace' as WorkspaceId, projectId: 'c09-foreign-project' as ProjectId });
  });
  expect(screen.queryByRole('status', { name: 'Context recovery options' })).toBeNull();
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(screen.queryByRole('status', { name: 'Context recovery options' })).toBeNull();
  const foreign = commits.filter(commit => commit.account !== scope.accountId || commit.workspace !== scope.workspaceId || commit.project !== scope.projectId);
  expect(foreign.length).toBeGreaterThan(0);
  expect(foreign.every(commit => commit.notices === 0)).toBe(true);
  io.persistenceGate = undefined;
  await act(async () => { useAuthStore.setState({ localUserId: scope.accountId, workspaceId: scope.workspaceId as WorkspaceId, projectId: scope.projectId as ProjectId }); });
  await screen.findByRole('status', { name: 'Context recovery options' });
  expect((await database.context_quarantine.toArray())).toHaveLength(1);
});


it('C09 hides an old summary on a workspace-only transition before the next scoped read completes', async () => {
  await quarantineC09Map();
  const commits: Array<{ workspace: unknown; notices: number }> = [];
  render(<React.Profiler id="c09-workspace" onRender={() => {
    commits.push({ workspace: useAuthStore.getState().workspaceId,
      notices: screen.queryAllByRole('status', { name: 'Context recovery options' }).length });
  }}><ContextPage /></React.Profiler>);
  await screen.findByRole('status', { name: 'Context recovery options' });
  let release!: () => void;
  io.persistenceGate = new Promise<void>(resolve => { release = resolve; });
  await act(async () => { useAuthStore.setState({ workspaceId: 'c09-other-workspace' as WorkspaceId }); });
  expect(screen.queryByRole('status', { name: 'Context recovery options' })).toBeNull();
  const foreign = commits.filter(commit => commit.workspace !== scope.workspaceId);
  expect(foreign.length).toBeGreaterThan(0);
  expect(foreign.every(commit => commit.notices === 0)).toBe(true);
  await act(async () => {
    useAuthStore.setState({ workspaceId: scope.workspaceId as WorkspaceId });
    io.persistenceGate = undefined;
    release();
  });
  await screen.findByRole('status', { name: 'Context recovery options' });
});

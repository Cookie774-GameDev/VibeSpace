import * as React from 'react';
import Dexie from 'dexie';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { ContextPersistenceState } from './contextPersistence';
import type { ContextMapRecord, ProjectContextTree } from './tree';

const io = vi.hoisted(() => ({
  state: null as ContextPersistenceState | null,
  service: null as any,
  job: null as any,
  entries: [] as any[],
  saves: [] as Array<{ expected: number | undefined; before: number | undefined }>,
  errors: [] as any[],
  jobReads: 0,
  authListeners: new Set<(next: any, previous: any) => void>(),
  sync: vi.fn(),
  populate: vi.fn(),
  repair: vi.fn(),
  stage: vi.fn(),
  commit: vi.fn(),
  abort: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  localUserId: 'account-creation',
  cloudSession: null,
  projectId: 'project-creation',
  workspaceId: 'workspace-creation',
  apiKeys: {},
  defaultProvider: 'local',
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign((selector: any) => selector(auth), {
    getState: () => auth,
    subscribe: (listener: any) => {
      io.authListeners.add(listener);
      return () => io.authListeners.delete(listener);
    },
  }),
}));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ groups: [], flatOptions: [], loading: false }),
}));
vi.mock('@/features/dev-console', () => ({
  devConsole: { log: (event: any) => io.errors.push(event) },
}));
vi.mock('@/lib/notifications', () => ({
  notifyDone: vi.fn(),
  detectAndNotifyConnectorAuthLoss: vi.fn(),
}));
vi.mock('./NightlySecondBrainPanel', () => ({ NightlySecondBrainPanel: () => null }));
vi.mock('./ContextAutoUpdateCheckbox', () => ({ ContextAutoUpdateCheckbox: () => null }));
vi.mock('./ContextGalaxy', () => ({ ContextGalaxy: () => null }));
vi.mock('./siyuan/SiyuanVaultSurface', () => ({
  SiyuanVaultSurface: () => null,
  SiyuanVaultLoading: () => null,
}));
vi.mock('./contextPersistence', async (original) => ({
  ...(await original<typeof import('./contextPersistence')>()),
  ensureContextPersistence: (projectId: string) =>
    io.service.initialize(auth.localUserId, projectId),
  getActiveContextPersistenceState: () => io.state,
  hasEquivalentPersistedContextTree: (_projectId: string, mapId: string, tree: ProjectContextTree, expected: number, signal?: AbortSignal) =>
    io.service.hasEquivalentTree(auth.localUserId, tree, mapId, expected, signal),
  setPersistedContextSourceStatus: async (
    projectId: string,
    mapId: string,
    status: 'indexing' | 'ready' | 'error',
    expected: number,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    return io.service.setSourceStatus(auth.localUserId, projectId, mapId, status, expected, signal);
  },
  savePersistedContextTree: async (tree: ProjectContextTree, options: any = {}) => {
    io.saves.push({
      expected: options.expectedUpdatedAt,
      before: io.state?.maps.find((map) => map.id === options.mapId)?.updatedAt,
    });
    return io.service.saveTree(auth.localUserId, tree, options);
  },
}));
vi.mock('./contextSearchIndexing', () => ({
  createContextSearchIndexPopulationPort: () => ({
    populateCreatedMap: io.populate,
    repairEmptyMap: io.repair,
    stageChangedMap: io.stage,
  }),
}));
vi.mock('./siyuanContextMapIntegration', () => ({
  productionSiyuanContextMaps: {
    prewarm: async () => {},
    sync: (...args: any[]) => io.sync(...args),
    read: async (_project: string, map: ContextMapRecord) => ({ tree: map.tree }),
  },
}));
vi.mock('./siyuan/siyuanIndexJobStore', async (original) => ({
  ...(await original<typeof import('./siyuan/siyuanIndexJobStore')>()),
  readSiyuanIndexJob: async () => {
    io.jobReads++;
    return io.job;
  },
  readSiyuanIndexEntries: async () => io.entries,
}));
import { createContextPersistenceService } from './contextPersistence';
import { ContextPage } from './ContextPage';
let database: JarvisDexie;
let databaseName: string;
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let syncGate: ReturnType<typeof deferred>;
let indexGate: ReturnType<typeof deferred>;
let clock = 1_790_000_000_000;
beforeEach(async () => {
  localStorage.clear();
  io.state = null;
  io.job = null;
  io.saves = [];
  io.errors = [];
  io.jobReads = 0;
  io.authListeners.clear();
  auth.projectId = 'project-creation';
  auth.workspaceId = 'workspace-creation';
  io.sync.mockReset();
  io.populate.mockReset();
  io.repair.mockReset();
  io.stage.mockReset();
  io.commit.mockReset();
  io.abort.mockReset();
  io.stage.mockResolvedValue({ commit: io.commit, abort: io.abort });
  io.commit.mockResolvedValue(undefined);
  io.abort.mockResolvedValue(undefined);
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  databaseName = uniqueTestDbName('creation-actual-page');
  database = createJarvisDb(databaseName, TEST_INDEXED_DB);
  await database.open();
  io.service = createContextPersistenceService(database, localStorage, (state) => {
    io.state = state;
    window.dispatchEvent(
      new CustomEvent('jarvis:context-tree-updated', { detail: { projectId: auth.projectId } }),
    );
  });
  io.entries = [
    {
      nodeId: 'path:dispatch.txt',
      parentNodeId: null,
      title: 'dispatch.txt',
      kind: 'file',
      relativePath: 'dispatch.txt',
      sourcePointer: 'C:/fixture/dispatch.txt',
      summary: null,
      sizeBytes: 42,
      modifiedAt: 100,
    },
  ];
  syncGate = deferred();
  indexGate = deferred();
  io.populate.mockImplementation(async (_account, map: ContextMapRecord) => {
    if (map.tree.fileCount) await indexGate.promise;
    return { status: 'ready', documentCount: map.tree.fileCount, bodyBytes: 42, mapId: map.id };
  });
  io.repair.mockImplementation(async () => {
    await indexGate.promise;
    return { status: 'ready', documentCount: 1, bodyBytes: 42 };
  });
  io.sync.mockImplementation(async (_project, map: ContextMapRecord) => {
    io.job = {
      schemaVersion: 1,
      scope: 'fixture',
      accountId: auth.localUserId,
      projectId: auth.projectId,
      mapId: map.id,
      canonicalRoot: 'C:/fixture',
      policyFingerprint: 'fixture',
      status: 'running',
      phase: 'creating_nodes',
      pauseReason: null,
      cursor: 1,
      frontierLength: 0,
      indexed: 1,
      excluded: 0,
      unreadable: 0,
      summarized: 0,
      summaryEligible: 0,
      createdNodes: 0,
      failed: 0,
      skipped: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenProvenance: 'none',
      summaryProviderId: null,
      summaryConnectionId: null,
      summaryModelId: null,
      phaseStartedAt: clock,
      rateSamples: [],
      discoverySamples: [],
      estimatedPercent: 90,
      estimatedEtaSeconds: null,
      reconciledAt: clock,
      pendingNativeNodeIds: [],
      startupDisposition: null,
      startupDispositionAt: null,
      pausedMs: 0,
      startedAt: clock,
      updatedAt: clock,
      completedAt: null,
    };
    await syncGate.promise;
    return { tree: map.tree };
  });
});
afterEach(async () => {
  await act(async () => {
    syncGate.resolve();
    indexGate.resolve();
    await new Promise((done) => setTimeout(done, 30));
  });
  cleanup();
  database.close();
  await new Dexie(databaseName, TEST_INDEXED_DB).delete();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function startCreationAndFinishGraph() {
  render(<ContextPage />);
  const root = await screen.findByRole('textbox', { name: 'Context source folder' });
  fireEvent.change(root, { target: { value: 'C:/fixture' } });
  fireEvent.click(screen.getByRole('radio', { name: 'No summaries' }));
  act(() => window.dispatchEvent(new Event('jarvis:context:create-map')));
  await waitFor(() => expect(io.sync).toHaveBeenCalledOnce());
  await waitFor(() => expect(io.jobReads).toBeGreaterThan(0));
  const previousReads = io.jobReads;
  io.job = {
    ...io.job,
    status: 'completed',
    phase: 'completed',
    createdNodes: 1,
    estimatedPercent: 100,
    completedAt: ++clock,
    updatedAt: clock,
  };
  await waitFor(() => expect(io.jobReads).toBeGreaterThan(previousReads), { timeout: 7_000 });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}
it('lets only the active create flow persist and populate after graph completion', async () => {
  await startCreationAndFinishGraph();
  const savesBeforeOwnerResumes = io.saves.length;
  await act(async () => {
    syncGate.resolve();
  });
  await waitFor(() =>
    expect(
      io.errors.some((event) => event.level === 'error') ||
        io.populate.mock.calls.some((call) => call[1].tree.fileCount === 1),
    ).toBe(true),
  );
  expect(io.errors.filter((event) => event.level === 'error')).toEqual([]);
  expect(savesBeforeOwnerResumes).toBe(1);
  expect(io.repair).not.toHaveBeenCalled();
  expect(io.populate.mock.calls.filter((call) => call[1].tree.fileCount === 1)).toHaveLength(1);
  indexGate.resolve();
}, 15_000);

it('keeps durable source readiness pending after graph completion until text indexing finishes', async () => {
  await startCreationAndFinishGraph();
  expect(io.state!.maps[0]!.sourceStatus).toBe('indexing');
  expect(screen.getByTestId('siyuan-progress-state').textContent).not.toContain('Complete');
  await act(async () => {
    syncGate.resolve();
  });
  await waitFor(() =>
    expect(io.populate.mock.calls.some((call) => call[1].tree.fileCount === 1)).toBe(true),
  );
  expect(io.state!.maps[0]!.sourceStatus).toBe('indexing');
  await act(async () => {
    indexGate.resolve();
  });
  await waitFor(() => expect(io.state!.maps[0]!.sourceStatus).toBe('ready'));
}, 15_000);

it('retains a failed text index durably and retries only through explicit scoped reconciliation', async () => {
  await startCreationAndFinishGraph();
  await act(async () => {
    syncGate.resolve();
  });
  await waitFor(() =>
    expect(io.populate.mock.calls.some((call) => call[1].tree.fileCount === 1)).toBe(true),
  );
  await act(async () => {
    indexGate.reject(new Error('fixture index unavailable'));
  });
  await waitFor(() => expect(io.state!.maps[0]!.sourceStatus).toBe('error'));
  expect(io.job.status).toBe('completed');
  expect(io.stage).not.toHaveBeenCalled();
  expect(screen.getByTestId('siyuan-progress-state').textContent).toContain('repair');
  cleanup();
  render(<ContextPage />);
  await screen.findByRole('button', { name: 'Redo from checkpoint' });
  expect(io.stage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Redo from checkpoint' }));
  await waitFor(() => expect(io.state!.maps[0]!.sourceStatus).toBe('ready'));
  expect(io.stage).toHaveBeenCalledOnce();
  expect(io.commit).toHaveBeenCalledOnce();
  expect(io.stage.mock.calls[0]![5]).toEqual({ reconcileMembership: true });
  expect(io.sync).toHaveBeenCalledOnce();
}, 15_000);

it('aborts a source-index owner on workspace ABA and refuses late readiness', async () => {
  await startCreationAndFinishGraph();
  await act(async () => {
    syncGate.resolve();
  });
  await waitFor(() =>
    expect(io.populate.mock.calls.some((call) => call[1].tree.fileCount === 1)).toBe(true),
  );
  const signal = io.populate.mock.calls.find(
    (call) => call[1].tree.fileCount === 1,
  )![2] as AbortSignal;
  const ownedListeners = [...io.authListeners];
  const before = { ...auth };
  auth.workspaceId = 'another-workspace';
  for (const listener of io.authListeners) listener({ ...auth }, before);
  const middle = { ...auth };
  auth.workspaceId = before.workspaceId;
  for (const listener of io.authListeners) listener({ ...auth }, middle);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    indexGate.resolve();
  });
  expect(io.state!.maps[0]!.sourceStatus).toBe('indexing');
  expect(io.stage).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(ownedListeners.every((listener) => !io.authListeners.has(listener))).toBe(true),
  );
}, 15_000);

it('cancels text indexing without cancelling the completed graph or publishing late readiness', async () => {
  await startCreationAndFinishGraph();
  await act(async () => {
    syncGate.resolve();
  });
  await waitFor(() =>
    expect(io.populate.mock.calls.some((call) => call[1].tree.fileCount === 1)).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(io.state!.maps[0]!.sourceStatus).toBe('error'));
  await act(async () => {
    indexGate.resolve();
  });
  expect(io.job.status).toBe('completed');
  expect(io.state!.maps[0]!.sourceStatus).toBe('error');
  expect(io.stage).not.toHaveBeenCalled();
  expect(io.authListeners.size).toBe(0);
}, 15_000);

it('resumes a durably pending source after reopen through the scoped transaction', async () => {
  const tree: ProjectContextTree = {
    version: 1,
    projectId: auth.projectId,
    rootDir: 'C:/fixture',
    generatedAt: clock,
    model: 'siyuan-managed-v1',
    fileCount: 1,
    totalBytes: 42,
    summary: 'fixture',
    nodes: [
      {
        id: 'path:dispatch.txt',
        title: 'dispatch.txt',
        kind: 'file',
        path: 'dispatch.txt',
        summary: '',
        sizeBytes: 42,
        modifiedAt: 100,
      },
    ],
    recommendedEntryPoints: [],
  };
  const state = await io.service.saveTree(auth.localUserId, tree, { sourceStatus: 'indexing' });
  const pendingSync = io.sync(auth.projectId, state.maps[0]);
  syncGate.resolve();
  await pendingSync;
  io.job = {
    ...io.job,
    phase: 'completed',
    status: 'completed',
    createdNodes: 1,
    completedAt: ++clock,
  };
  render(<ContextPage />);
  await waitFor(() => expect(io.state!.maps[0]!.sourceStatus).toBe('ready'));
  expect(io.stage).toHaveBeenCalledOnce();
  expect(io.commit).toHaveBeenCalledOnce();
  expect(io.populate).not.toHaveBeenCalled();
  expect(io.repair).not.toHaveBeenCalled();
  expect(io.state!.maps[0]!.id).toBe(state.maps[0]!.id);
  await waitFor(() => expect(io.authListeners.size).toBe(0));
});

// Independent reviewer regressions, preserved from C04 review-r2.
function independentPendingTree(root = 'C:/fixture', empty = false): ProjectContextTree {
  return { version: 1, projectId: auth.projectId, rootDir: root, generatedAt: clock,
    model: 'siyuan-managed-v1', fileCount: empty ? 0 : 1, totalBytes: empty ? 0 : 42,
    summary: 'Independent fixture', recommendedEntryPoints: [], nodes: empty ? [] : [{
      id: 'path:dispatch.txt', title: 'dispatch.txt', kind: 'file', path: 'dispatch.txt',
      summary: '', sizeBytes: 42, modifiedAt: 100,
    }] };
}
async function independentCompletedJob(map: ContextMapRecord) {
  const pending = io.sync(auth.projectId, map); syncGate.resolve(); await pending;
  io.job = { ...io.job, phase: 'completed', status: 'completed', createdNodes: 1,
    indexed: 1, completedAt: ++clock, updatedAt: clock };
}

it('independent Context C04 hydration preserves a newer map selection while its old map write finishes', async () => {
  const initial = await io.service.saveTree(auth.localUserId, independentPendingTree('C:/fixture', true),
    { mapId: 'review-map-a', sourceStatus: 'indexing' });
  const mapA = initial.maps.find((map: ContextMapRecord) => map.id === 'review-map-a')!;
  await independentCompletedJob(mapA);
  await io.service.saveTree(auth.localUserId, independentPendingTree('C:/other'),
    { mapId: 'review-map-b', sourceStatus: 'ready' });
  await io.service.selectMap(auth.localUserId, auth.projectId, 'review-map-a');
  const started = deferred(); const release = deferred();
  const originalSave = io.service.saveTree.bind(io.service);
  io.service = { ...io.service, saveTree: async (account: string, tree: ProjectContextTree, options: any) => {
    if (options?.mapId === 'review-map-a') { started.resolve(); await release.promise; }
    return originalSave(account, tree, options);
  } };
  render(<ContextPage />);
  try {
    await started.promise;
    await act(async () => { await io.service.selectMap(auth.localUserId, auth.projectId, 'review-map-b'); });
    expect(io.state?.selectedMapId).toBe('review-map-b');
    await act(async () => { release.resolve(); });
    await waitFor(() => expect(io.stage).toHaveBeenCalledOnce());
    await waitFor(() => expect(io.state?.maps.find(map => map.id === 'review-map-a')?.sourceStatus).toBe('ready'));
    expect(io.state?.selectedMapId).toBe('review-map-b');
  } finally { release.resolve(); }
}, 15_000);

it('independent Context C04 recovered pending indexing rejects workspace ABA before committing', async () => {
  const initial = await io.service.saveTree(auth.localUserId, independentPendingTree(),
    { mapId: 'review-recovery', sourceStatus: 'indexing' });
  const map = initial.maps.find((item: ContextMapRecord) => item.id === 'review-recovery')!;
  await independentCompletedJob(map);
  const release = deferred();
  io.stage.mockImplementationOnce(async () => { await release.promise; return { commit: io.commit, abort: io.abort }; });
  render(<ContextPage />);
  try {
    await waitFor(() => expect(io.stage).toHaveBeenCalledOnce());
    const signal = io.stage.mock.calls[0]![4] as AbortSignal;
    const before = { ...auth }; auth.workspaceId = 'independent-other';
    for (const listener of io.authListeners) listener({ ...auth }, before);
    const middle = { ...auth }; auth.workspaceId = before.workspaceId;
    for (const listener of io.authListeners) listener({ ...auth }, middle);
    expect(signal.aborted).toBe(true);
    await act(async () => { release.resolve(); });
    await waitFor(() => expect(io.abort).toHaveBeenCalledOnce());
    expect(io.commit).not.toHaveBeenCalled();
    expect(io.state?.maps.find(item => item.id === map.id)?.sourceStatus).toBe('indexing');
    await waitFor(() => expect(io.authListeners.size).toBe(0));
  } finally { release.resolve(); }
});


it('completed unchanged index hydration is idempotent across two Context mounts',async()=>{
  indexGate.resolve();
  const {buildProjectContextTreeFromSiyuanIndex}=await import('./siyuan/siyuanSafeIndex');
  const built=buildProjectContextTreeFromSiyuanIndex(independentPendingTree(),io.entries);
  const initial=await io.service.saveTree(auth.localUserId,built,{mapId:'idempotent-map',sourceStatus:'ready'});
  const map=initial.maps.find((map:ContextMapRecord)=>map.id==='idempotent-map')!;
  await independentCompletedJob(map);
  const beforeMap=await database.context_maps.get(map.id);
  const beforeSources=await database.context_sources.where('[accountId+mapId]').equals([auth.localUserId,map.id]).toArray();
  const first=render(<ContextPage />);
  await waitFor(()=>expect(io.repair).toHaveBeenCalledOnce());
  first.unmount();
  render(<ContextPage />);
  await waitFor(()=>expect(io.repair).toHaveBeenCalledTimes(2));
  expect(io.saves).toEqual([]);
  expect(await database.context_maps.get(map.id)).toEqual(beforeMap);
  expect(await database.context_sources.where('[accountId+mapId]').equals([auth.localUserId,map.id]).toArray()).toEqual(beforeSources);
});


it.each(['add','remove','source-time'] as const)('completed hydration still persists a genuine %s change',async(change)=>{
  indexGate.resolve();
  const {buildProjectContextTreeFromSiyuanIndex}=await import('./siyuan/siyuanSafeIndex');
  const built=buildProjectContextTreeFromSiyuanIndex(independentPendingTree(),io.entries);
  const initial=await io.service.saveTree(auth.localUserId,built,{mapId:'changed-map',sourceStatus:'ready'});
  const map=initial.maps.find((map:ContextMapRecord)=>map.id==='changed-map')!;
  await independentCompletedJob(map);
  const before=await database.context_maps.get(map.id);
  if(change==='add')io.entries.push({...io.entries[0],nodeId:'path:added.txt',title:'added.txt',relativePath:'added.txt',sourcePointer:'C:/fixture/added.txt'});
  if(change==='remove')io.entries=[];
  if(change==='source-time')io.entries[0].modifiedAt++;
  io.job={...io.job,indexed:io.entries.length,createdNodes:io.entries.length,updatedAt:++clock};
  render(<ContextPage />);
  await waitFor(()=>expect(io.saves).toHaveLength(1));
  await waitFor(async()=>expect((await database.context_maps.get(map.id))!.knowledgeRevision).toBe(before!.knowledgeRevision+1));
  const latest=await io.service.loadMap(auth.localUserId,auth.projectId,map.id);
  expect(latest!.tree.fileCount).toBe(io.entries.length);
  if(change==='source-time')expect(latest!.tree.nodes[0]!.modifiedAt).toBe(io.entries[0].modifiedAt);
});

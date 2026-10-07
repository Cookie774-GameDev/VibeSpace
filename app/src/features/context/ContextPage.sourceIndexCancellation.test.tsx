import "fake-indexeddb/auto";
import * as React from "react";
import Dexie from "dexie";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createJarvisDb, type JarvisDexie } from "@/lib/db";
import { TEST_INDEXED_DB, uniqueTestDbName } from "@/test/indexedDb";
import type { ContextPersistenceState } from "./contextPersistence";
import type { ContextMapRecord, ProjectContextTree } from "./tree";

const io = vi.hoisted(() => ({
  state: null as ContextPersistenceState | null,
  service: null as any,
  job: null as any,
  entries: [] as any[],
  saves: [] as Array<{
    expected: number | undefined;
    before: number | undefined;
  }>,
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
  localUserId: "account-creation",
  cloudSession: null,
  projectId: "project-creation",
  workspaceId: "workspace-creation",
  apiKeys: {},
  defaultProvider: "local",
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: Object.assign((selector: any) => selector(auth), {
    getState: () => auth,
    subscribe: (listener: any) => {
      io.authListeners.add(listener);
      return () => io.authListeners.delete(listener);
    },
  }),
}));
vi.mock("@/lib/ai/useAccessibleChatModels", () => ({
  useAccessibleChatModels: () => ({
    groups: [],
    flatOptions: [],
    loading: false,
  }),
}));
vi.mock("@/features/dev-console", () => ({
  devConsole: { log: (event: any) => io.errors.push(event) },
}));
vi.mock("@/lib/notifications", () => ({
  notifyDone: vi.fn(),
  detectAndNotifyConnectorAuthLoss: vi.fn(),
}));
vi.mock("./NightlySecondBrainPanel", () => ({
  NightlySecondBrainPanel: () => null,
}));
vi.mock("./ContextAutoUpdateCheckbox", () => ({
  ContextAutoUpdateCheckbox: () => null,
}));
vi.mock("./ContextGalaxy", () => ({ ContextGalaxy: () => null }));
vi.mock("./siyuan/SiyuanVaultSurface", () => ({
  SiyuanVaultSurface: () => null,
  SiyuanVaultLoading: () => null,
}));
vi.mock("./contextPersistence", async (original) => ({
  ...(await original<typeof import("./contextPersistence")>()),
  ensureContextPersistence: (projectId: string) =>
    io.service.initialize(auth.localUserId, projectId),
  getActiveContextPersistenceState: () => io.state,
  setPersistedContextSourceStatus: async (
    projectId: string,
    mapId: string,
    status: "indexing" | "ready" | "error",
    expected: number,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    return io.service.setSourceStatus(
      auth.localUserId,
      projectId,
      mapId,
      status,
      expected,
      signal,
    );
  },
  savePersistedContextTree: async (
    tree: ProjectContextTree,
    options: any = {},
  ) => {
    io.saves.push({
      expected: options.expectedUpdatedAt,
      before: io.state?.maps.find((map) => map.id === options.mapId)?.updatedAt,
    });
    return io.service.saveTree(auth.localUserId, tree, options);
  },
}));
vi.mock("./contextSearchIndexing", () => ({
  createContextSearchIndexPopulationPort: () => ({
    populateCreatedMap: io.populate,
    repairEmptyMap: io.repair,
    stageChangedMap: io.stage,
  }),
}));
vi.mock("./siyuanContextMapIntegration", () => ({
  productionSiyuanContextMaps: {
    prewarm: async () => {},
    sync: (...args: any[]) => io.sync(...args),
    read: async (_project: string, map: ContextMapRecord) => ({
      tree: map.tree,
    }),
  },
}));
import { createContextPersistenceService } from "./contextPersistence";
import { ContextPage } from "./ContextPage";
import {
  createSiyuanIndexJob,
  checkpointSiyuanIndexJob,
  readSiyuanIndexJob,
  readSiyuanIndexEntries,
} from "./siyuan/siyuanIndexJobStore";
import {
  createSiyuanMapManifest,
  readSiyuanMapManifest,
  writeSiyuanMapManifest,
} from "./siyuan/siyuanMapManifest";
import {
  buildProjectContextTreeFromSiyuanIndex,
  siyuanIndexPolicyFingerprint,
} from "./siyuan/siyuanSafeIndex";
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
let retryCommitGate: ReturnType<typeof deferred> | undefined;
let clock = 1_790_000_000_000;
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("vibespace-siyuan-index-jobs");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  localStorage.clear();
  io.state = null;
  io.job = null;
  io.saves = [];
  io.errors = [];
  io.jobReads = 0;
  io.authListeners.clear();
  auth.projectId = "project-creation";
  auth.workspaceId = "workspace-creation";
  io.sync.mockReset();
  io.populate.mockReset();
  io.repair.mockReset();
  io.stage.mockReset();
  io.commit.mockReset();
  io.abort.mockReset();
  io.stage.mockResolvedValue({ commit: io.commit, abort: io.abort });
  io.commit.mockResolvedValue(undefined);
  io.abort.mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  databaseName = uniqueTestDbName("creation-actual-page");
  database = createJarvisDb(databaseName, TEST_INDEXED_DB);
  await database.open();
  io.service = createContextPersistenceService(
    database,
    localStorage,
    (state) => {
      io.state = state;
      window.dispatchEvent(
        new CustomEvent("jarvis:context-tree-updated", {
          detail: { projectId: auth.projectId },
        }),
      );
    },
  );
  io.entries = [
    {
      nodeId: "path:dispatch.txt",
      parentNodeId: null,
      title: "dispatch.txt",
      kind: "file",
      relativePath: "dispatch.txt",
      sourcePointer: "C:/fixture/dispatch.txt",
      summary: null,
      sizeBytes: 42,
      modifiedAt: 100,
    },
  ];
  syncGate = deferred();
  indexGate = deferred();
  io.populate.mockImplementation(async (_account, map: ContextMapRecord) => {
    if (map.tree.fileCount) await indexGate.promise;
    return {
      status: "ready",
      documentCount: map.tree.fileCount,
      bodyBytes: 42,
      mapId: map.id,
    };
  });
  io.repair.mockImplementation(async () => {
    await indexGate.promise;
    return { status: "ready", documentCount: 1, bodyBytes: 42 };
  });
  io.sync.mockImplementation(async (_project, map: ContextMapRecord) => {
    io.job = {
      schemaVersion: 1,
      scope: "fixture",
      accountId: auth.localUserId,
      projectId: auth.projectId,
      mapId: map.id,
      canonicalRoot: "C:/fixture",
      policyFingerprint: "fixture",
      status: "running",
      phase: "creating_nodes",
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
      tokenProvenance: "none",
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

async function seedNativeCancelledState() {
  const nodes = Array.from({ length: 64 }, (_, index) => ({
    id: `path:file-${index}.txt`,
    title: `file-${index}.txt`,
    kind: "file" as const,
    path: `file-${index}.txt`,
    summary: "",
    sizeBytes: 128_000,
    modifiedAt: 100,
  }));
  const baseTree: ProjectContextTree = {
    version: 1,
    projectId: auth.projectId,
    rootDir: "C:/fixture",
    generatedAt: ++clock,
    model: "siyuan-managed-v1",
    fileCount: 64,
    totalBytes: 8_192_000,
    summary: "Owned canceled source-index fixture",
    nodes,
    recommendedEntryPoints: [],
  };
  const entries = nodes.map((node) => ({
    nodeId: node.id,
    parentNodeId: null,
    title: node.title,
    kind: node.kind,
    relativePath: node.path,
    sourcePointer: `${baseTree.rootDir}/${node.path}`,
    summary: null,
    sizeBytes: node.sizeBytes,
    modifiedAt: node.modifiedAt,
  }));
  const tree = buildProjectContextTreeFromSiyuanIndex(baseTree, entries);
  const state = await io.service.saveTree(auth.localUserId, tree, {
    sourceStatus: "indexing",
  });
  const map = state.maps[0]!;
  const originalManifest = createSiyuanMapManifest(map, auth.projectId, {
    mode: "none",
  });
  const manifest = {
    ...originalManifest,
    revision: 4,
    status: "ready" as const,
    notebookId: "20261007000000-notebk1",
    rootDocumentId: "20261007000000-cancel1",
    counts: { indexed: 66, excluded: 0, unreadable: 0, summarized: 0 },
  };
  writeSiyuanMapManifest(manifest);
  const job = {
    ...createSiyuanIndexJob({
      accountId: auth.localUserId,
      projectId: auth.projectId,
      mapId: map.id,
      canonicalRoot: map.rootDir,
      policyFingerprint: siyuanIndexPolicyFingerprint(
        map.rootDir,
        manifest.summaryPolicy,
        manifest.sourcePolicy.excludedPaths,
      ),
      now: ++clock,
    }),
    phase: "completed" as const,
    status: "cancelled" as const,
    cursor: 1,
    frontierLength: 1,
    indexed: 66,
    createdNodes: 66,
    reconciledAt: clock,
    completedAt: null,
  };
  await checkpointSiyuanIndexJob({ job, appendedEntries: entries });
  return { map, job, manifest };
}

it("offers explicit source recovery after reopening the exact native completed/cancelled checkpoint", async () => {
  const h = await seedNativeCancelledState();
  expect(await readSiyuanIndexEntries(auth.projectId, h.map.id)).toHaveLength(
    64,
  );
  render(<ContextPage />);
  await screen.findByText(/Cancelled.*66 of 66 items saved/);
  expect(io.state!.maps[0]!.sourceStatus).toBe("indexing");
  expect(await readSiyuanIndexJob(auth.projectId, h.map.id)).toMatchObject({
    phase: "completed",
    status: "cancelled",
  });
  expect(io.sync).not.toHaveBeenCalled();
  expect(io.stage).not.toHaveBeenCalled();
  expect(io.populate).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "Redo from checkpoint",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("retries only source indexing explicitly and preserves the graph, manifest and map identity across reopen", async () => {
  const h = await seedNativeCancelledState();
  const commit = deferred();
  retryCommitGate = commit;
  io.commit.mockImplementation(() => commit.promise);
  render(<ContextPage />);
  await screen.findByText(/Cancelled.*66 of 66 items saved/);
  expect(io.stage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Redo from checkpoint" }));
  await waitFor(() => expect(io.stage).toHaveBeenCalledOnce());
  expect(io.state!.maps[0]!.sourceStatus).toBe("indexing");
  expect(io.sync).not.toHaveBeenCalled();
  expect(io.populate).not.toHaveBeenCalled();
  expect(io.repair).not.toHaveBeenCalled();
  // Hydration reprojects raw checkpoint IDs through the map namespace using the existing CAS save.
  expect(io.saves.every((save) => save.expected === save.before)).toBe(true);
  expect(io.state!.maps[0]!.tree.nodes).toEqual(h.map.tree.nodes);
  expect(await readSiyuanIndexEntries(auth.projectId, h.map.id)).toHaveLength(
    64,
  );
  await act(async () => {
    commit.resolve();
  });
  await waitFor(() => expect(io.state!.maps[0]!.sourceStatus).toBe("ready"));
  expect(io.state!.maps[0]!.id).toBe(h.map.id);
  expect(io.state!.maps[0]!.tree.nodes).toEqual(h.map.tree.nodes);
  expect(readSiyuanMapManifest(auth.projectId, h.map.id)).toEqual(h.manifest);
  expect(await readSiyuanIndexJob(auth.projectId, h.map.id)).toMatchObject({
    phase: "completed",
    status: "completed",
    createdNodes: 66,
  });
  cleanup();
  render(<ContextPage />);
  expect(
    (await screen.findByTestId("siyuan-progress-state")).textContent,
  ).toContain("Complete");
  expect(io.state!.maps[0]!.sourceStatus).toBe("ready");
  expect(io.stage).toHaveBeenCalledOnce();
});

it.each(["localUserId", "workspaceId", "projectId"] as const)(
  "refuses explicit retry after %s ABA without reviving the durable job",
  async (field) => {
    const h = await seedNativeCancelledState();
    render(<ContextPage />);
    await screen.findByText(/Cancelled.*66 of 66 items saved/);
    fireEvent.click(
      screen.getByRole("button", { name: "Redo from checkpoint" }),
    );
    const before = { ...auth };
    auth[field] = "another-scope";
    for (const listener of io.authListeners) listener({ ...auth }, before);
    const middle = { ...auth };
    auth[field] = before[field];
    for (const listener of io.authListeners) listener({ ...auth }, middle);
    await waitFor(() => expect(io.authListeners.size).toBe(0));
    expect(await readSiyuanIndexJob(auth.projectId, h.map.id)).toMatchObject({
      status: "cancelled",
      updatedAt: h.job.updatedAt,
    });
    expect(io.stage).not.toHaveBeenCalled();
    expect(io.sync).not.toHaveBeenCalled();
    expect(io.state!.maps[0]!.sourceStatus).toBe("indexing");
  },
);

it("refuses a retry when the current manifest no longer authorizes the completed graph", async () => {
  const h = await seedNativeCancelledState();
  render(<ContextPage />);
  await screen.findByText(/Cancelled.*66 of 66 items saved/);
  writeSiyuanMapManifest({
    ...h.manifest,
    sourceRoot: "C:/foreign-root",
    revision: 5,
  });
  fireEvent.click(screen.getByRole("button", { name: "Redo from checkpoint" }));
  await waitFor(() => expect(io.authListeners.size).toBe(0));
  expect(await readSiyuanIndexJob(auth.projectId, h.map.id)).toMatchObject({
    status: "cancelled",
    updatedAt: h.job.updatedAt,
  });
  expect(io.stage).not.toHaveBeenCalled();
  expect(io.sync).not.toHaveBeenCalled();
});

it.each(["localUserId", "workspaceId", "projectId"] as const)(
  "refuses stale rendered retry authority after %s changed before the click",
  async (field) => {
    const h = await seedNativeCancelledState();
    render(<ContextPage />);
    await screen.findByText(/Cancelled.*66 of 66 items saved/);
    const previous = auth[field];
    try {
      auth[field] = "different-current-scope";
      fireEvent.click(
        screen.getByRole("button", { name: "Redo from checkpoint" }),
      );
      await waitFor(() => expect(io.authListeners.size).toBe(0));
      expect(await readSiyuanIndexJob(h.job.projectId, h.map.id)).toMatchObject(
        { status: "cancelled", updatedAt: h.job.updatedAt },
      );
      expect(io.stage).not.toHaveBeenCalled();
    } finally {
      auth[field] = previous;
    }
  },
);
afterEach(async () => {
  await act(async () => {
    syncGate.resolve();
    indexGate.resolve();
    retryCommitGate?.resolve();
    retryCommitGate = undefined;
    await new Promise((done) => setTimeout(done, 30));
  });
  cleanup();
  database.close();
  await new Dexie(databaseName, TEST_INDEXED_DB).delete();
  vi.restoreAllMocks();
  localStorage.clear();
});

// Exact independent reviewer regression.
it("review: refuses an unsupported durable checkpoint version before derivative admission", async () => {
  const h = await seedNativeCancelledState();
  await checkpointSiyuanIndexJob({ job: { ...h.job, schemaVersion: 2 } as never });
  const before = await readSiyuanIndexJob(auth.projectId, h.map.id);
  expect(before!.schemaVersion).toBe(2);
  const { toast } = await import("@/components/ui/toast");
  const errors = vi.spyOn(toast, "error");
  render(<ContextPage />);
  await screen.findByText(/Cancelled.*66 of 66 items saved/);
  fireEvent.click(screen.getByRole("button", { name: "Redo from checkpoint" }));
  await waitFor(async () => {
    const current = await readSiyuanIndexJob(auth.projectId, h.map.id);
    expect(current?.status === "completed" || errors.mock.calls.length > 0).toBe(true);
  });
  const current = await readSiyuanIndexJob(auth.projectId, h.map.id);
  expect(current?.status, JSON.stringify({ schemaVersion: current?.schemaVersion, status: current?.status, stageCalls: io.stage.mock.calls.length })).toBe("cancelled");
  expect(current).toEqual(before);
  expect(io.stage).not.toHaveBeenCalled();
  expect(io.state!.maps[0]!.sourceStatus).toBe("indexing");
});

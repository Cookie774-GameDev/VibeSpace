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
import { useAuthStore } from "@/stores/auth";
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
  auth.localUserId = "account-creation";
  auth.projectId = "project-creation";
  auth.workspaceId = "workspace-creation";
  useAuthStore.setState({ localUserId: auth.localUserId, cloudSession: null,
    workspaceId: auth.workspaceId as any, projectId: auth.projectId as any });
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

const picker = vi.hoisted(() => ({
  files: vi.fn(),
  folder: vi.fn(),
  stat: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/features/files/projectFiles", async (original) => ({
  ...(await original<typeof import("@/features/files/projectFiles")>()),
  chooseProjectFiles: (...args: any[]) => picker.files(...args),
  chooseProjectFolder: (...args: any[]) => picker.folder(...args),
}));
import { scanSiyuanFilesystemIndex } from "./siyuan/siyuanSafeIndex";
const selected = "C:/fixture/selected.txt";
beforeEach(() => {
  picker.files.mockReset().mockResolvedValue([selected]);
  picker.folder.mockReset().mockResolvedValue("C:/folder");
  picker.stat
    .mockReset()
    .mockImplementation(async (path: string) => ({
      ok: true,
      path,
      kind: "file",
      size: 5,
      modifiedMs: 1,
    }));
  picker.list
    .mockReset()
    .mockImplementation(async (path: string) => ({
      ok: true,
      path,
      entries: ["selected.txt", "sibling.txt"].map((name) => ({
        name,
        path: path + "/" + name,
        isDir: false,
        size: 5,
        modifiedMs: 1,
      })),
    }));
});
async function openPage() {
  render(<ContextPage />);
  await waitFor(() => expect(io.state).not.toBeNull());
}
async function chooseFile() {
  const previousCalls = picker.files.mock.calls.length;
  const button = document.querySelector('[data-warm-source="local_file"]');
  expect(button).not.toBeNull();
  fireEvent.click(button!);
  await waitFor(() =>
    expect(picker.files).toHaveBeenCalledTimes(previousCalls + 1),
  );
  fireEvent.click(screen.getByRole("button", { name: "Maps" }));
}
async function createJoinedMap() {
  const previousReady =
    io.state?.maps.filter(
      (m) => m.status === "active" && m.sourceStatus === "ready",
    ).length ?? 0;
  indexGate.resolve();
  io.sync.mockImplementation(
    async (project: string, map: ContextMapRecord, options: any) => {
      const policy = {
        mode: "none" as const,
        selectedExtensions: [],
        selectedPaths: [],
      };
      const index = await scanSiyuanFilesystemIndex(map, policy, {
        signal: options.signal,
        stat: picker.stat,
        list: picker.list,
      });
      const job = {
        ...createSiyuanIndexJob({
          accountId: auth.localUserId,
          projectId: project,
          mapId: map.id,
          canonicalRoot: map.rootDir,
          policyFingerprint: siyuanIndexPolicyFingerprint(
            map.rootDir,
            policy,
            [],
            map.localFileScope,
          ),
        }),
        phase: "completed" as const,
        status: "completed" as const,
        indexed: index.entries.length,
        createdNodes: index.entries.length,
        frontierLength: 0,
        cursor: 1,
        completedAt: clock,
      };
      await checkpointSiyuanIndexJob({ job, appendedEntries: index.entries });
      return {
        tree: buildProjectContextTreeFromSiyuanIndex(map.tree, index.entries),
      };
    },
  );
  await act(async () => {
    window.dispatchEvent(new Event("jarvis:context:create-map"));
  });
  await waitFor(() =>
    expect(
      io.state?.maps.filter(
        (m) => m.status === "active" && m.sourceStatus === "ready",
      ).length,
    ).toBe(previousReady + 1),
  );
  return io.state!.maps.filter((m) => m.status === "active");
}
it("actual Local file selection persists only the picked file through creation and synthetic discovery", async () => {
  await openPage();
  await chooseFile();
  await screen.findByDisplayValue("C:/fixture");
  fireEvent.click(screen.getByRole("radio", { name: "No summaries" }));
  const maps = await createJoinedMap();
  expect(maps).toHaveLength(1);
  expect(maps[0]).toMatchObject({
    sourceType: "local_file",
    localFileScope: { version: 1, rootDir: "C:/fixture", filePath: selected },
    rootDir: "C:/fixture",
  });
  expect(maps[0]!.tree.nodes.map((n) => n.path)).toEqual(["selected.txt"]);
  expect(picker.list).not.toHaveBeenCalled();
  expect(picker.stat).toHaveBeenCalledWith(selected, false, {
    root: "C:/fixture",
    strictProjectBoundary: true,
  });
  expect(io.sync.mock.calls[0][2].summaryPolicy.mode).toBe("none");
});
it("picker cancellation does not replace the current source with a parent-folder grant", async () => {
  picker.files.mockResolvedValueOnce([]);
  await openPage();
  await chooseFile();
  expect(
    document.querySelector<HTMLInputElement>("#context-project-folder")?.value,
  ).toBe("");
  expect(io.state!.maps).toEqual([]);
  expect(picker.stat).not.toHaveBeenCalled();
});
it("a late file picker cannot replace an explicit newer folder choice", async () => {
  let resolve!: (paths: string[]) => void;
  picker.files.mockImplementationOnce(
    () =>
      new Promise<string[]>((r) => {
        resolve = r;
      }),
  );
  await openPage();
  await chooseFile();
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  await screen.findByDisplayValue("C:/folder");
  await act(async () => {
    resolve([selected]);
  });
  expect(
    document.querySelector<HTMLInputElement>("#context-project-folder")?.value,
  ).toBe("C:/folder");
  const maps = await createJoinedMap();
  expect(maps[0]!.sourceType).not.toBe("local_file");
  expect(maps[0]!.localFileScope).toBeUndefined();
  expect(picker.list).toHaveBeenCalled();
  expect(picker.stat).not.toHaveBeenCalled();
});
it("a late file picker cannot transfer its permission across account scope", async () => {
  let resolve!: (paths: string[]) => void;
  picker.files.mockImplementationOnce(
    () =>
      new Promise<string[]>((r) => {
        resolve = r;
      }),
  );
  await openPage();
  await chooseFile();
  const previous = { ...auth };
  auth.localUserId = "foreign-account";
  act(() => useAuthStore.setState({ localUserId: auth.localUserId }));
  await act(async () => {
    resolve([selected]);
  });
  expect(
    document.querySelector<HTMLInputElement>("#context-project-folder")?.value,
  ).toBe("");
  expect(io.state!.maps).toEqual([]);
  auth.localUserId = previous.localUserId;
  act(() => useAuthStore.setState({ localUserId: previous.localUserId }));
});

it("a cancelled replacement picker preserves the previous selected file", async () => {
  await openPage();
  await chooseFile();
  await screen.findByDisplayValue("C:/fixture");
  picker.files.mockResolvedValueOnce([]);
  await chooseFile();
  const maps = await createJoinedMap();
  expect(maps[0]!.localFileScope?.filePath).toBe(selected);
  expect(picker.list).not.toHaveBeenCalled();
});
it("repeated creation uses distinct maps with the same exact file scope", async () => {
  await openPage();
  await chooseFile();
  await screen.findByDisplayValue("C:/fixture");
  const first = await createJoinedMap();
  const second = await createJoinedMap();
  expect(second).toHaveLength(2);
  expect(new Set(second.map((m) => m.id)).size).toBe(2);
  expect(second.every((m) => m.localFileScope?.filePath === selected)).toBe(
    true,
  );
  expect(second.some((m) => m.id === first[0]!.id)).toBe(true);
  expect(picker.list).not.toHaveBeenCalled();
});
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

it('refuses a legacy file-node drag without exporting data or throwing from the UI callback', async () => {
  const ts = await import('typescript');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const actualTree = await import('./tree');
  const source = readFileSync(resolve(__dirname, 'ContextPage.tsx'), 'utf8');
  const syntax = ts.createSourceFile('ContextPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = syntax.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'useContextDrag');
  expect(node).toBeDefined();
  const code = ts.transpileModule(node!.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const warning = vi.fn();
  const hook = new Function('React', 'nodeToAttachment', 'contextNodeFilePath', 'toast', 'CONTEXT_MIME', 'serializeContextAttachment', 'formatContextAttachmentForTerminal', code + '\nreturn useContextDrag;')(
    { useCallback: (callback: unknown) => callback }, actualTree.nodeToAttachment, actualTree.contextNodeFilePath,
    { warning }, actualTree.CONTEXT_MIME, actualTree.serializeContextAttachment, actualTree.formatContextAttachmentForTerminal,
  );
  const tree: ProjectContextTree = { version:1, projectId:auth.projectId, rootDir:'C:/fixture', generatedAt:1,
    sourceType:'local_file', model:'siyuan-managed-v1',fileCount:1,totalBytes:3,summary:'',nodes:[] };
  const event = { preventDefault:vi.fn(),dataTransfer:{setData:vi.fn(),effectAllowed:''} };
  const drag = hook(tree,{id:'file',kind:'file',title:'selected.txt',path:'selected.txt',summary:''});
  expect(()=>drag(event)).not.toThrow();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.dataTransfer.setData).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledOnce();
});


it.each(['localUserId','workspaceId','projectId'] as const)('latches real auth %s ABA while the Local file picker is pending',async field=>{
 let settle!:(paths:string[])=>void;picker.files.mockImplementationOnce(()=>new Promise<string[]>(resolve=>{settle=resolve;}));
 await openPage();await chooseFile();const original=useAuthStore.getState()[field];
 await act(async()=>{useAuthStore.setState({[field]:'revoked-picker-owner'});useAuthStore.setState({[field]:original});});
 await act(async()=>{settle([selected]);});
 expect(document.querySelector<HTMLInputElement>('#context-project-folder')?.value).toBe('');
 expect(io.state!.maps).toEqual([]);expect(picker.stat).not.toHaveBeenCalled();expect(picker.list).not.toHaveBeenCalled();
});
it.each(['cancel','unmount'] as const)('disposes only the pending picker subscription on %s',async boundary=>{
 let settle!:(paths:string[])=>void;picker.files.mockImplementationOnce(()=>new Promise<string[]>(resolve=>{settle=resolve;}));
 await openPage();const original=useAuthStore.subscribe.bind(useAuthStore);const stops:Array<ReturnType<typeof vi.fn>>=[];
 vi.spyOn(useAuthStore,'subscribe').mockImplementation(listener=>{const stop=vi.fn(original(listener));stops.push(stop);return stop;});
 await chooseFile();expect(stops.length).toBeGreaterThan(0);const pendingStop=stops[0]!;
 if(boundary==='unmount')cleanup();
 await act(async()=>{settle([]);});expect(pendingStop).toHaveBeenCalledOnce();
});

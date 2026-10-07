import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisDb, type JarvisDexie } from "@/lib/db";
import { TEST_INDEXED_DB, uniqueTestDbName } from "@/test/indexedDb";
import { createContextPersistenceService } from "./contextPersistence";
import { convertContextMapRecordV1ToSnapshotV2 } from "./migration";
import { createContextGraphRepository } from "./repository";
import {
  contextNodeFilePath,
  nodeToAttachment,
  contextMapCollectionKey,
  loadStoredContextMaps,
  saveContextTree,
  type ContextMapRecord,
  type ProjectContextTree,
} from "./tree";
import { readContextLocalFileScope } from "./contextLocalFileScope";

const ACCOUNT = "account-n11";
const PROJECT = "project-n11";
const scope = {
  version: 1 as const,
  rootDir: "/owned/docs",
  filePath: "/owned/docs/selected.txt",
};
const source = {
  kind: "local_file" as const,
  label: "selected.txt",
  localFileScope: scope,
};
function tree(at = 1000): ProjectContextTree {
  return {
    version: 1,
    projectId: PROJECT,
    rootDir: scope.rootDir,
    generatedAt: at,
    model: "siyuan-managed-v1",
    fileCount: 1,
    totalBytes: 20,
    summary: "Owned synthetic file",
    nodes: [
      {
        id: "file-selected",
        kind: "file",
        title: "selected.txt",
        path: "selected.txt",
        summary: "",
        sizeBytes: 20,
        modifiedAt: at,
      },
    ],
  };
}
let database: JarvisDexie;
let databaseName: string;
beforeEach(async () => {
  localStorage.clear();
  databaseName = uniqueTestDbName("n11-local-file");
  database = createJarvisDb(databaseName, TEST_INDEXED_DB);
  await database.open();
});
afterEach(async () => {
  database.close();
  await new Dexie(databaseName, TEST_INDEXED_DB).delete();
  localStorage.clear();
});

describe("N11 durable selected-file scope", () => {
  it.each([true, false])(
    "keeps the legacy-format projection explicit and bounded (has scope: %s)",
    (hasScope) => {
      const map = {
        id: "map-projection",
        projectId: PROJECT,
        rootDir: scope.rootDir,
        name: "Synthetic",
        status: "active",
        createdAt: 1000,
        updatedAt: 2000,
        sourceType: "local_file",
        sourceStatus: "ready",
        tree: tree(),
        ...(hasScope ? { localFileScope: scope } : {}),
      };
      localStorage.setItem(
        contextMapCollectionKey(PROJECT),
        JSON.stringify({
          version: 1,
          projectId: PROJECT,
          selectedMapId: map.id,
          maps: [map],
        }),
      );
      const before = localStorage.getItem(contextMapCollectionKey(PROJECT));
      const loaded = loadStoredContextMaps(PROJECT)[0]!;
      expect(loaded.sourceType).toBe("local_file");
      expect(loaded.sourceStatus).toBe(
        hasScope ? "ready" : "permission_required",
      );
      if (hasScope)
        expect(loaded).toMatchObject({
          localFileScope: scope,
          tree: { sourceType: "local_file", localFileScope: scope },
        });
      else
        expect(() => readContextLocalFileScope(loaded)).toThrow(
          "context_local_file_scope_required",
        );
      expect(localStorage.getItem(contextMapCollectionKey(PROJECT))).toBe(
        before,
      );
    },
  );
  it("round-trips the exact file separately from its native reader directory root", async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize(ACCOUNT, PROJECT);
    await service.saveTree(ACCOUNT, tree(), { mapId: "map-file", source });
    const state = await createContextPersistenceService(
      database,
      localStorage,
    ).load(ACCOUNT, PROJECT);
    expect(state.maps[0]).toMatchObject({
      sourceType: "local_file",
      rootDir: scope.rootDir,
      localFileScope: scope,
      tree: {
        rootDir: scope.rootDir,
        sourceType: "local_file",
        localFileScope: scope,
      },
    });
    const row = (await database.context_sources.toArray())[0]!;
    expect(row).toMatchObject({
      kind: "local_file",
      localFile: scope.filePath,
      localFileScope: scope,
    });
    expect(row.localRoot).toBeUndefined();
  });
  it("preserves the file descriptor through completion and a subsequent refresh", async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize(ACCOUNT, PROJECT);
    const initial = await service.saveTree(ACCOUNT, tree(), {
      mapId: "map-file",
      source,
      sourceStatus: "indexing",
    });
    const first = initial.maps[0]!;
    const completed = await service.saveTree(
      ACCOUNT,
      { ...first.tree, generatedAt: Date.now() },
      { mapId: first.id, expectedUpdatedAt: first.updatedAt },
    );
    const current = completed.maps[0]!;
    const refreshed = await service.saveTree(
      ACCOUNT,
      { ...current.tree, generatedAt: Date.now() + 1 },
      {
        mapId: current.id,
        expectedUpdatedAt: current.updatedAt,
        requireExisting: true,
        select: false,
      },
    );
    expect(refreshed.maps[0]).toMatchObject({
      sourceType: "local_file",
      sourceLabel: "selected.txt",
      rootDir: scope.rootDir,
      localFileScope: scope,
    });
    expect((await database.context_sources.toArray())[0]).toMatchObject({
      localFile: scope.filePath,
      localFileScope: scope,
    });
  });
  it("rejects a sibling in a new file tree before durable writes", async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize(ACCOUNT, PROJECT);
    const malicious = tree();
    malicious.nodes.push({
      ...malicious.nodes[0]!,
      id: "file-sibling",
      title: "sibling.txt",
      path: "sibling.txt",
    });
    await expect(
      service.saveTree(ACCOUNT, malicious, { mapId: "map-file", source }),
    ).rejects.toThrow("context_local_file_path_denied");
    expect(await database.context_maps.count()).toBe(0);
    expect(await database.context_sources.count()).toBe(0);
  });
  it("keeps a legacy local-file source byte-preserved and explicitly unavailable", async () => {
    const legacy: ContextMapRecord = {
      id: "map-legacy",
      projectId: PROJECT,
      rootDir: scope.rootDir,
      name: "Legacy file",
      status: "active",
      createdAt: 1000,
      updatedAt: 2000,
      sourceType: "local_file",
      tree: tree(),
    };
    const snapshot = convertContextMapRecordV1ToSnapshotV2(
      legacy,
      ACCOUNT,
      legacy.id,
      { sourceStatus: "ready" },
    );
    await createContextGraphRepository(database).putSnapshot(ACCOUNT, snapshot);
    const before = JSON.stringify(await database.context_sources.toArray());
    const state = await createContextPersistenceService(
      database,
      localStorage,
    ).load(ACCOUNT, PROJECT);
    expect(state.maps[0]).toMatchObject({
      sourceType: "local_file",
      sourceStatus: "permission_required",
    });
    expect(() => readContextLocalFileScope(state.maps[0]!)).toThrow(
      "context_local_file_scope_required",
    );
    expect(JSON.stringify(await database.context_sources.toArray())).toBe(
      before,
    );
  });
  it("keeps two independently created maps of the same selected file distinct", async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize(ACCOUNT, PROJECT);
    await service.saveTree(ACCOUNT, tree(), { mapId: "map-one", source });
    const state = await service.saveTree(ACCOUNT, tree(2000), {
      mapId: "map-two",
      source,
    });
    expect(new Set(state.maps.map((x) => x.id))).toEqual(
      new Set(["map-one", "map-two"]),
    );
    for (const map of state.maps)
      expect(map).toMatchObject({
        sourceType: "local_file",
        localFileScope: scope,
      });
    expect(await database.context_sources.count()).toBe(2);
  });
  it("does not turn a rejected scope replacement into folder or sibling authority", async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize(ACCOUNT, PROJECT);
    await service.saveTree(ACCOUNT, tree(), { mapId: "map-file", source });
    const before = JSON.stringify(await database.context_sources.toArray());
    await expect(
      service.saveTree(ACCOUNT, tree(2000), {
        mapId: "map-file",
        source: { kind: "local_folder", label: "Folder" },
      }),
    ).rejects.toThrow("context_persistence_file_scope_changed");
    expect(JSON.stringify(await database.context_sources.toArray())).toBe(
      before,
    );
  });
  it("does not write a new source on a pre-cancelled save", async () => {
    const service = createContextPersistenceService(database, localStorage);
    await service.initialize(ACCOUNT, PROJECT);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.saveTree(ACCOUNT, tree(), {
        mapId: "map-file",
        source,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await database.context_maps.count()).toBe(0);
  });
  it("binds root attachments to the selected file and refuses stale sibling attachments", async () => {
    const bounded = {
      ...tree(),
      sourceType: "local_file" as const,
      localFileScope: scope,
    };
    const root = {
      id: "root",
      kind: "root" as const,
      title: "Selected file map",
      summary: "",
    };
    expect(contextNodeFilePath(bounded, root)).toBe(scope.filePath);
    expect(nodeToAttachment(bounded, root).path).toBe(scope.filePath);
    const sibling = { ...bounded.nodes[0]!, path: "sibling.txt" };
    expect(() => nodeToAttachment(bounded, sibling)).toThrow(
      "context_local_file_path_denied",
    );
    expect(() => contextNodeFilePath(bounded, sibling)).toThrow(
      "context_local_file_path_denied",
    );
    expect(contextNodeFilePath(tree(), sibling)).toBe(
      "/owned/docs/sibling.txt",
    );
  });
});


describe('N11 legacy writer scope preservation',()=>{
  it('refuses a same-map scope replacement before altering stored bytes',()=>{
    const first=saveContextTree({...tree(),sourceType:'local_file',localFileScope:scope})!;
    const key=contextMapCollectionKey(PROJECT);const before=localStorage.getItem(key);
    expect(()=>saveContextTree({...tree(),sourceType:'local_file',localFileScope:{...scope,filePath:'/owned/docs/sibling.txt'}},{mapId:first.id})).toThrow('context_local_file_scope_changed');
    expect(localStorage.getItem(key)).toBe(before);
  });
  it('refuses stale sibling nodes before a legacy stored-map update',()=>{
    const first=saveContextTree({...tree(),sourceType:'local_file',localFileScope:scope})!;
    const key=contextMapCollectionKey(PROJECT);const before=localStorage.getItem(key);
    expect(()=>saveContextTree({...tree(),sourceType:'local_file',localFileScope:scope,nodes:[{id:'other',title:'sibling.txt',path:'sibling.txt',kind:'file',summary:''}]},{mapId:first.id})).toThrow('context_local_file_path_denied');
    expect(localStorage.getItem(key)).toBe(before);
  });
});

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextMapRecord } from "../tree";
import {
  scanSiyuanFilesystemIndex,
  siyuanIndexPolicyFingerprint,
} from "./siyuanSafeIndex";
import {
  checkpointSiyuanIndexJob,
  createSiyuanIndexJob,
  readSiyuanIndexJob,
  replaceSiyuanIndexJob,
} from "./siyuanIndexJobStore";
const root = "/owned/docs";
const selected = root + "/selected.txt";
const policy = {
  mode: "none" as const,
  selectedExtensions: [],
  selectedPaths: [],
};
const scope = { version: 1 as const, rootDir: root, filePath: selected };
const authority = {
  accountId: "account-n11",
  projectId: "project-n11",
  mapId: "map-file",
};
const metadata = () => ({
  ok: true as const,
  path: selected,
  kind: "file" as const,
  size: 20,
  modifiedMs: 1000,
});
function record(): ContextMapRecord {
  return {
    id: authority.mapId,
    projectId: authority.projectId,
    rootDir: root,
    name: "Owned file",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    sourceType: "local_file",
    localFileScope: scope,
    tree: {
      version: 1,
      projectId: authority.projectId,
      rootDir: root,
      generatedAt: 1000,
      model: "siyuan-metadata-index-v1",
      fileCount: 0,
      totalBytes: 0,
      summary: "",
      nodes: [],
    },
  };
}
function ports() {
  return {
    stat: vi.fn(async () => metadata()),
    list: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      entries: ["selected.txt", "sibling.txt"].map((name) => ({
        name,
        path: root + "/" + name,
        isDir: false,
        size: 20,
        modifiedMs: 1000,
      })),
    })),
    listBatch: vi.fn(async () => {
      throw new Error("Unexpected directory batch");
    }),
  };
}
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const q = indexedDB.deleteDatabase("vibespace-siyuan-index-jobs");
    q.onsuccess = () => resolve();
    q.onerror = () => reject(q.error);
    q.onblocked = () => reject(new Error("test_database_blocked"));
  });
});

describe("N11 one-file discovery", () => {
  it("uses only the selected-file stat and emits one real scanner entry", async () => {
    const p = ports();
    const result = await scanSiyuanFilesystemIndex(record(), policy, p);
    expect(result.entries.map((x) => x.relativePath)).toEqual(["selected.txt"]);
    expect(result.entries[0]).toMatchObject({
      kind: "file",
      sourcePointer: selected,
      sizeBytes: 20,
      summary: null,
    });
    expect(result.summarized).toBe(0);
    expect(p.list).not.toHaveBeenCalled();
    expect(p.listBatch).not.toHaveBeenCalled();
    expect(p.stat).toHaveBeenCalledExactlyOnceWith(selected, false, {
      root,
      strictProjectBoundary: true,
    });
  });
  it("retains folder discovery when no file scope is present", async () => {
    const p = ports();
    const folder = {
      ...record(),
      sourceType: "local_folder" as const,
      localFileScope: undefined,
    };
    const result = await scanSiyuanFilesystemIndex(folder, policy, {
      stat: p.stat,
      list: p.list,
    });
    expect(result.entries.map((x) => x.relativePath)).toEqual([
      "selected.txt",
      "sibling.txt",
    ]);
    expect(p.stat).not.toHaveBeenCalled();
    expect(p.list).toHaveBeenCalledOnce();
  });
  it("refuses a legacy file record before any discovery IO", async () => {
    const p = ports();
    await expect(
      scanSiyuanFilesystemIndex(
        { ...record(), localFileScope: undefined },
        policy,
        p,
      ),
    ).rejects.toThrow("context_local_file_scope_required");
    expect(p.stat).not.toHaveBeenCalled();
    expect(p.list).not.toHaveBeenCalled();
    expect(p.listBatch).not.toHaveBeenCalled();
  });
  it.each(["not_found", "outside_root", "symlink_blocked"] as const)(
    "preserves %s failure without listing a replacement",
    async (code) => {
      const p = ports();
      p.stat = vi.fn(async () => ({
        ok: false as const,
        path: selected,
        error: { code },
      })) as any;
      await expect(
        scanSiyuanFilesystemIndex(record(), policy, p),
      ).rejects.toThrow("siyuan_local_file_unavailable:" + code);
      expect(p.list).not.toHaveBeenCalled();
      expect(p.listBatch).not.toHaveBeenCalled();
    },
  );
  it("does not turn a directory at the selected path into recursive authority", async () => {
    const p = ports();
    p.stat = vi.fn(async () => ({
      ...metadata(),
      kind: "directory" as const,
    })) as any;
    await expect(
      scanSiyuanFilesystemIndex(record(), policy, p),
    ).rejects.toThrow("siyuan_local_file_not_a_file");
    expect(p.list).not.toHaveBeenCalled();
  });
  it("refuses a mismatched stat receipt before emitting a node", async () => {
    const p = ports();
    p.stat = vi.fn(async () => ({
      ...metadata(),
      path: root + "/sibling.txt",
    }));
    await expect(
      scanSiyuanFilesystemIndex(record(), policy, p),
    ).rejects.toThrow("context_local_file_path_denied");
  });
  it("honors exclusions without substituting a sibling", async () => {
    const p = ports();
    const result = await scanSiyuanFilesystemIndex(record(), policy, {
      ...p,
      excludedPaths: [selected],
    });
    expect(result.entries).toEqual([]);
    expect(result.excluded).toBe(1);
    expect(p.list).not.toHaveBeenCalled();
  });
  it("cancels before stat without reading source metadata", async () => {
    const p = ports();
    const c = new AbortController();
    c.abort();
    await expect(
      scanSiyuanFilesystemIndex(record(), policy, { ...p, signal: c.signal }),
    ).rejects.toThrow("siyuan_index_cancelled");
    expect(p.stat).not.toHaveBeenCalled();
  });
  it("observes cancellation after stat before emitting or discovering more", async () => {
    const p = ports();
    const c = new AbortController();
    p.stat = vi.fn(async () => {
      c.abort();
      return metadata();
    });
    await expect(
      scanSiyuanFilesystemIndex(record(), policy, { ...p, signal: c.signal }),
    ).rejects.toThrow("siyuan_index_cancelled");
    expect(p.list).not.toHaveBeenCalled();
  });
  it("binds file identity into its checkpoint without changing folder fingerprints", () => {
    const folder = siyuanIndexPolicyFingerprint(root, policy, []);
    const file = siyuanIndexPolicyFingerprint(root, policy, [], scope);
    expect(file).not.toBe(folder);
    expect(file).not.toBe(
      siyuanIndexPolicyFingerprint(root, policy, [], {
        ...scope,
        filePath: root + "/sibling.txt",
      }),
    );
    expect(JSON.parse(folder)).not.toHaveProperty("localFileScope");
  });
  it("refuses a folder-era checkpoint without rewriting it into file authority", async () => {
    const job = createSiyuanIndexJob({
      ...authority,
      canonicalRoot: root,
      policyFingerprint: siyuanIndexPolicyFingerprint(root, policy, []),
      now: 1000,
    });
    await replaceSiyuanIndexJob(job, {
      path: root,
      relativePath: "",
      parentNodeId: null,
    });
    const before = await readSiyuanIndexJob(
      authority.projectId,
      authority.mapId,
    );
    const p = ports();
    await expect(
      scanSiyuanFilesystemIndex(record(), policy, {
        ...p,
        durableJob: authority,
      }),
    ).rejects.toThrow("siyuan_index_resume_authority_mismatch");
    expect(
      await readSiyuanIndexJob(authority.projectId, authority.mapId),
    ).toEqual(before);
    expect(p.stat).not.toHaveBeenCalled();
    expect(p.list).not.toHaveBeenCalled();
  });
  it("refuses a retained sibling entry even under an otherwise matching file fingerprint", async () => {
    const job = createSiyuanIndexJob({
      ...authority,
      canonicalRoot: root,
      policyFingerprint: siyuanIndexPolicyFingerprint(root, policy, [], scope),
      now: 1000,
    });
    await replaceSiyuanIndexJob(job, {
      path: root,
      relativePath: "",
      parentNodeId: null,
    });
    await checkpointSiyuanIndexJob({
      job: { ...job, phase: "creating_nodes", indexed: 1, updatedAt: 2000 },
      appendedEntries: [
        {
          nodeId: "path:sibling.txt",
          parentNodeId: null,
          title: "sibling.txt",
          kind: "file",
          relativePath: "sibling.txt",
          sourcePointer: root + "/sibling.txt",
          summary: null,
          sizeBytes: 20,
          modifiedAt: 1000,
        },
      ],
    });
    const before = await readSiyuanIndexJob(
      authority.projectId,
      authority.mapId,
    );
    const p = ports();
    await expect(
      scanSiyuanFilesystemIndex(record(), policy, {
        ...p,
        durableJob: authority,
      }),
    ).rejects.toThrow("siyuan_local_file_checkpoint_scope_invalid");
    expect(
      await readSiyuanIndexJob(authority.projectId, authority.mapId),
    ).toEqual(before);
    expect(p.stat).not.toHaveBeenCalled();
    expect(p.list).not.toHaveBeenCalled();
  });
  it.each(["C:/", "/"])(
    "retains the selected-file directory root %s for stat admission",
    async (rootDir) => {
      const filePath = rootDir + "selected.txt";
      const r = {
        ...record(),
        rootDir,
        localFileScope: { version: 1 as const, rootDir, filePath },
        tree: { ...record().tree, rootDir },
      };
      const stat = vi.fn(async () => ({
        ok: true as const,
        path: filePath,
        kind: "file" as const,
        size: 3,
        modifiedMs: 1,
      }));
      const list = vi.fn(async () => {
        throw new Error("directory listing forbidden");
      });
      const result = await scanSiyuanFilesystemIndex(r, policy, { stat, list });
      expect(result.entries.map((e) => e.relativePath)).toEqual([
        "selected.txt",
      ]);
      expect(stat).toHaveBeenCalledExactlyOnceWith(filePath, false, {
        root: rootDir,
        strictProjectBoundary: true,
      });
      expect(list).not.toHaveBeenCalled();
    },
  );
});

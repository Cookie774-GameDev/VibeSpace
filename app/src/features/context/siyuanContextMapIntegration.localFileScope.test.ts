import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ProductionSiyuanRlmPort } from "./siyuanRlmProduction";
import type { ContextMapRecord } from "./tree";
import { createSiyuanContextMapIntegration } from "./siyuanContextMapIntegration";
import {
  buildSiyuanSafeIndex,
  type SiyuanSafeIndex,
} from "./siyuan/siyuanSafeIndex";
import { readSiyuanMapManifest } from "./siyuan/siyuanMapManifest";
const root = "/owned/docs";
const file = root + "/selected.txt";
const scope = { version: 1 as const, rootDir: root, filePath: file };
const policy = {
  mode: "none" as const,
  selectedExtensions: [],
  selectedPaths: [],
};
function record(): ContextMapRecord & { projectId: string } {
  return {
    id: "map-n11-integration",
    projectId: "project-n11",
    name: "Selected file",
    rootDir: root,
    sourceType: "local_file",
    localFileScope: scope,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    tree: {
      version: 1,
      projectId: "project-n11",
      rootDir: root,
      generatedAt: 1,
      model: "siyuan-metadata-index-v1",
      summary: "",
      fileCount: 0,
      totalBytes: 0,
      nodes: [],
    },
  };
}
function index(name = "selected.txt"): SiyuanSafeIndex {
  return {
    entries: [
      {
        nodeId: "path:" + name,
        parentNodeId: null,
        title: name,
        kind: "file",
        relativePath: name,
        sourcePointer: root + "/" + name,
        summary: null,
        sizeBytes: 5,
        modifiedAt: 1,
      },
    ],
    excluded: 0,
    unreadable: 0,
    summarized: 0,
  };
}
function port(
  existing: { markdown: string } | null = null,
): ProductionSiyuanRlmPort {
  let sequence = 0;
  let documents = existing
    ? [
        {
          id: "doc-1",
          notebookId: "notebook-1",
          path: "/old",
          markdown: existing.markdown,
        },
      ]
    : [];
  return {
    searchBlocks: vi.fn(async () => []),
    getBlock: vi.fn(async (_projectId, id) => {
      const found = documents.find((document) => document.id === id);
      if (!found) throw new Error("missing");
      return found;
    }),
    listInboundBacklinks: vi.fn(async () => []),
    readManagedDocument: vi.fn(
      async (_projectId, lookup) =>
        documents.find((document) =>
          document.markdown.includes(lookup.marker),
        ) ?? null,
    ),
    createManagedDocument: vi.fn(async (_projectId, path, markdown) => {
      sequence += 1;
      const document = {
        id: `created-${sequence}`,
        notebookId: "notebook-1",
        path,
        markdown,
      };
      documents.push(document);
      return document;
    }),
    updateManagedDocument: vi.fn(
      async (_projectId, id, _expected, markdown) => {
        documents = documents.map((document) =>
          document.id === id ? { ...document, markdown } : document,
        );
        return documents.find((document) => document.id === id)!;
      },
    ),
    deleteManagedDocument: vi.fn(async (_projectId, id) => {
      documents = documents.filter((document) => document.id !== id);
    }),
    createManagedSnapshot: vi.fn(),
    stopActive: vi.fn(),
  };
}

beforeEach(async () => {
  localStorage.clear();
  await new Promise<void>((resolve, reject) => {
    const q = indexedDB.deleteDatabase("vibespace-siyuan-index-jobs");
    q.onsuccess = () => resolve();
    q.onerror = () => reject(q.error);
    q.onblocked = () => reject(new Error("blocked"));
  });
});
afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
});
describe("N11 managed map scope boundary", () => {
  it("refuses legacy file sync before manifest or managed-document work", async () => {
    const p = port();
    const r = { ...record(), localFileScope: undefined };
    await expect(
      createSiyuanContextMapIntegration(p).sync(r.projectId, r, {
        summaryPolicy: policy,
      }),
    ).rejects.toThrow("context_local_file_scope_required");
    expect(p.readManagedDocument).not.toHaveBeenCalled();
    expect(p.createManagedDocument).not.toHaveBeenCalled();
    expect(readSiyuanMapManifest(r.projectId, r.id)).toBeNull();
  });
  it("refuses legacy file reopen before managed-document reads", async () => {
    const p = port();
    const r = { ...record(), localFileScope: undefined };
    await expect(
      createSiyuanContextMapIntegration(p).read(r.projectId, r),
    ).rejects.toThrow("context_local_file_scope_required");
    expect(p.readManagedDocument).not.toHaveBeenCalled();
  });
  it("refuses a stale sibling pre-scan before writing manifest or native documents", async () => {
    const p = port();
    const r = record();
    await expect(
      createSiyuanContextMapIntegration(p).sync(r.projectId, r, {
        summaryPolicy: policy,
        automaticRefresh: true,
        preScannedIndex: index("sibling.txt"),
      }),
    ).rejects.toThrow("siyuan_local_file_checkpoint_scope_invalid");
    expect(p.createManagedDocument).not.toHaveBeenCalled();
    expect(p.readManagedDocument).not.toHaveBeenCalled();
    expect(readSiyuanMapManifest(r.projectId, r.id)).toBeNull();
  });
  it("retains the exact file descriptor in sync and reopened graph", async () => {
    const p = port();
    const r = record();
    r.tree.nodes = [
      {
        id: "file",
        title: "selected.txt",
        path: "selected.txt",
        kind: "file",
        summary: "",
      },
    ];
    const integration = createSiyuanContextMapIntegration(p);
    const made = await integration.sync(r.projectId, r, {
      summaryPolicy: policy,
      preScannedIndex: index(),
    });
    expect(made.tree).toMatchObject({
      rootDir: root,
      sourceType: "local_file",
      localFileScope: scope,
    });
    const opened = await integration.read(r.projectId, {
      ...r,
      tree: made.tree,
    });
    expect(opened?.tree).toMatchObject({
      rootDir: root,
      sourceType: "local_file",
      localFileScope: scope,
    });
    expect(opened?.tree.nodes.map((n) => n.path)).toEqual(["selected.txt"]);
  });
  it("rejects cancelled file sync before any managed-document operation", async () => {
    const p = port();
    const r = record();
    const c = new AbortController();
    c.abort();
    await expect(
      createSiyuanContextMapIntegration(p).sync(r.projectId, r, {
        summaryPolicy: policy,
        signal: c.signal,
      }),
    ).rejects.toThrow("siyuan_index_cancelled");
    expect(p.readManagedDocument).not.toHaveBeenCalled();
    expect(p.createManagedDocument).not.toHaveBeenCalled();
  });
  it("keeps ordinary folder graph nodes and does not add file authority", () => {
    const r = {
      ...record(),
      sourceType: "local_folder" as const,
      localFileScope: undefined,
    };
    r.tree.nodes = ["selected.txt", "sibling.txt"].map((path) => ({
      id: path,
      title: path,
      path,
      kind: "file" as const,
      summary: "",
    }));
    expect(
      buildSiyuanSafeIndex(r, policy).entries.map((n) => n.relativePath),
    ).toEqual(["selected.txt", "sibling.txt"]);
  });
  it("rejects retained sibling metadata before constructing a safe file index", () => {
    const r = record();
    r.tree.nodes = [
      {
        id: "wrong",
        title: "sibling.txt",
        path: "sibling.txt",
        kind: "file",
        summary: "",
      },
    ];
    expect(() => buildSiyuanSafeIndex(r, policy)).toThrow(
      "context_local_file_path_denied",
    );
  });
  it("flattens the selected file under a harmless tree root without granting the directory", () => {
    const r = record();
    r.tree.nodes = [
      {
        id: "root",
        title: "docs",
        kind: "root",
        summary: "",
        children: [
          {
            id: "file",
            title: "selected.txt",
            path: "selected.txt",
            kind: "file",
            summary: "",
          },
        ],
      },
    ];
    const actual = buildSiyuanSafeIndex(r, policy);
    expect(actual.entries).toHaveLength(1);
    expect(actual.entries[0]).toMatchObject({
      kind: "file",
      parentNodeId: null,
      sourcePointer: file,
    });
  });
  it("passes the one-file stat port through actual native-capability synchronization", async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const p = port();
    const r = record();
    const stat = vi.fn(async () => ({
      ok: true as const,
      path: file,
      kind: "file" as const,
      size: 5,
      modifiedMs: 1,
    }));
    const list = vi.fn(async () => {
      throw new Error("directory listing denied by test");
    });
    const made = await createSiyuanContextMapIntegration(p).sync(
      r.projectId,
      r,
      { summaryPolicy: policy, stat, list },
    );
    expect(made.tree.nodes.map((n) => n.path)).toEqual(["selected.txt"]);
    expect(list).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledWith(file, false, {
      root,
      strictProjectBoundary: true,
    });
  });
  it("does not share a held sync across different selected files with the same map id", async () => {
    const p = port();
    const original = p.readManagedDocument;
    let release!: () => void;
    let entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.readManagedDocument = vi.fn(
      async (...args: Parameters<typeof original>) => {
        entered();
        await held;
        return original(...args);
      },
    );
    const r = record();
    const integration = createSiyuanContextMapIntegration(p);
    const first = integration.sync(r.projectId, r, { summaryPolicy: policy });
    await seen;
    const changed = {
      ...r,
      localFileScope: { ...scope, filePath: root + "/sibling.txt" },
    };
    await expect(
      integration.sync(r.projectId, changed, { summaryPolicy: policy }),
    ).rejects.toThrow("context_local_file_scope_changed");
    release();
    await first;
  });
});

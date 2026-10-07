import { describe, expect, it, vi } from "vitest";
import type { FsPathStatResult, FsReadResult } from "@/lib/fs";
import {
  createContextSearchIndexPopulationPort,
  type ContextSearchIndexMap,
} from "./contextSearchIndexing";
import type { ContextSearchIndexPort } from "./contextSearchPipeline";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
function map(): ContextSearchIndexMap {
  return {
    id: "n11-map",
    projectId: "project-1",
    rootDir: "C:\\repo",
    status: "active",
    updatedAt: 1,
    sourceType: "local_file",
    localFileScope: {
      version: 1,
      rootDir: "C:/repo",
      filePath: "C:/repo/a.txt",
    },
    tree: { nodes: [{ id: "a", title: "a.txt", kind: "file", path: "a.txt" }] },
  };
}
function nativePort(initialCount = 0) {
  let count = initialCount;
  const port: ContextSearchIndexPort = {
    status: vi.fn(async () => ({
      documentCount: count,
      indexId: "index-1",
      engine: "tantivy-0.22.1",
      schemaVersion: 1,
      recoveredCorruption: false,
      needsRebuild: false,
    })),
    replaceDocuments: vi.fn(async (_accountId, _mapId, documents) => {
      count += documents.length;
      return { affectedDocuments: documents.length, documentCount: count };
    }),
    deleteDocuments: vi.fn(async (_accountId, _mapId, documentIds) => {
      count = Math.max(0, count - documentIds.length);
      return { affectedDocuments: documentIds.length, documentCount: count };
    }),
  };
  return port;
}

function dependencies(contents: Record<string, string>, port = nativePort()) {
  const encoder = new TextEncoder();
  const stat = vi.fn(async (path: string): Promise<FsPathStatResult> => {
    const content = contents[path];
    if (content === undefined)
      return { ok: false, path, error: { code: "not_found" } };
    return {
      ok: true,
      path,
      kind: "file",
      size: encoder.encode(content).byteLength,
      modifiedMs: path.endsWith("a.txt") ? 10 : 20,
      sha256: `sha256:${path.endsWith("a.txt") ? HASH_A : HASH_B}`,
    };
  });
  const read = vi.fn(
    async (path: string): Promise<FsReadResult> => ({
      ok: true,
      path,
      content: contents[path]!,
    }),
  );
  const hash = vi.fn(async (content: string) =>
    content === contents["C:\\repo\\a.txt"]
      ? (`sha256:${HASH_A}` as const)
      : (`sha256:${HASH_B}` as const),
  );
  return { port, stat, read, hash };
}

describe("N11 search body admission", () => {
  it("indexes the selected file using its retained parent root", async () => {
    const d = dependencies({ "C:\\repo\\a.txt": "alpha" });
    await createContextSearchIndexPopulationPort(d).populateCreatedMap(
      "account-1",
      map(),
    );
    expect(d.read).toHaveBeenCalledExactlyOnceWith(
      "C:\\repo\\a.txt",
      1024 * 1024 + 1,
      { root: "C:\\repo", strictProjectBoundary: true },
    );
  });
  it("denies a sibling node before status, stat, read or mutations", async () => {
    const d = dependencies({ "C:\\repo\\b.txt": "beta" });
    const r = map();
    r.tree.nodes = [{ id: "b", title: "b.txt", kind: "file", path: "b.txt" }];
    await expect(
      createContextSearchIndexPopulationPort(d).populateCreatedMap(
        "account-1",
        r,
      ),
    ).rejects.toThrow("context_local_file_path_denied");
    expect(d.port.status).not.toHaveBeenCalled();
    expect(d.stat).not.toHaveBeenCalled();
    expect(d.read).not.toHaveBeenCalled();
  });
  it("denies legacy missing scope before derivative-store access", async () => {
    const d = dependencies({});
    const r = map();
    delete r.localFileScope;
    await expect(
      createContextSearchIndexPopulationPort(d).populateCreatedMap(
        "account-1",
        r,
      ),
    ).rejects.toThrow("context_local_file_scope_required");
    expect(d.port.status).not.toHaveBeenCalled();
    expect(d.stat).not.toHaveBeenCalled();
  });
  it("rechecks scope after held stat before reading bytes", async () => {
    const r = map();
    const d = dependencies({ "C:\\repo\\a.txt": "alpha" });
    const original = d.stat;
    d.stat = vi.fn(async (...args: Parameters<typeof original>) => {
      const value = await original(...args);
      r.localFileScope = {
        version: 1,
        rootDir: "C:/repo",
        filePath: "C:/repo/b.txt",
      };
      return value;
    });
    await expect(
      createContextSearchIndexPopulationPort(d).populateCreatedMap(
        "account-1",
        r,
      ),
    ).rejects.toThrow("context_local_file_path_denied");
    expect(d.read).not.toHaveBeenCalled();
    expect(d.hash).not.toHaveBeenCalled();
  });
  it("rejects a foreign read acknowledgement before hashing", async () => {
    const d = dependencies({ "C:\\repo\\a.txt": "alpha" });
    d.read = vi.fn(async () => ({
      ok: true as const,
      path: "C:\\repo\\b.txt",
      content: "alpha",
    }));
    await expect(
      createContextSearchIndexPopulationPort(d).populateCreatedMap(
        "account-1",
        map(),
      ),
    ).rejects.toThrow("context_local_file_path_denied");
    expect(d.hash).not.toHaveBeenCalled();
  });
});

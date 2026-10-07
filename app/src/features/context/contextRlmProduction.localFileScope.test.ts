import { currentMembershipDigest } from "./contextIssuedEvidenceRegistry";
import { describe, expect, it, vi } from "vitest";
import { sha256Text } from "@/lib/fs";
import { createContextMapRlmRepository } from "./contextRlmProduction";
type M = Awaited<
  ReturnType<Parameters<typeof createContextMapRlmRepository>[0]["loadMaps"]>
>[number];
const root = "/owned/docs";
const file = root + "/selected.txt";
const body = "The selected source confirms orchid.";
const scope = {
  accountId: "account-n11",
  workspaceId: "workspace-n11",
  projectId: "project-n11",
};
async function fixture() {
  const hash = await sha256Text(body);
  let map: M = {
    id: "map-n11-rlm",
    projectId: scope.projectId,
    rootDir: root,
    status: "active",
    updatedAt: 1,
    sourceType: "local_file",
    localFileScope: { version: 1, rootDir: root, filePath: file },
    tree: {
      nodes: [
        {
          id: "file",
          kind: "file",
          title: "selected.txt",
          path: "selected.txt",
          summary: "",
          sizeBytes: body.length,
          modifiedAt: 1,
        },
      ],
    },
  };
  const deps = {
    loadMaps: vi.fn(async () => [map]),
    stat: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      kind: "file" as const,
      size: body.length,
      createdMs: 1,
      modifiedMs: 1,
      sha256: hash,
    })),
    read: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      content: body,
    })),
    lexicalSearch: vi.fn(async () => []),
  };
  return {
    deps,
    map,
    repo: createContextMapRlmRepository(deps),
    replace: (next: M) => {
      map = next;
    },
  };
}
describe("N11 physical RLM file scope", () => {
  it("searches and reads the selected file with the original parent directory boundary", async () => {
    const f = await fixture();
    const hits = await f.repo.search(scope, "orchid");
    expect(hits).toHaveLength(1);
    expect(f.deps.read.mock.calls.every(([path]) => path === file)).toBe(true);
    const r = await f.repo.getRecord(hits[0]!.recordId);
    expect(r).toBeDefined();
    expect(await f.repo.readSource(r!)).toBeDefined();
  });
  it.each(["search", "listRecords"] as const)(
    "refuses sibling nodes before %s physical IO",
    async (action) => {
      const f = await fixture();
      f.map.tree.nodes = [
        {
          id: "other",
          kind: "file",
          title: "sibling.txt",
          path: "sibling.txt",
          summary: "",
        },
      ];
      await expect(
        action === "search"
          ? f.repo.search(scope, "orchid")
          : f.repo.listRecords(scope),
      ).rejects.toThrow("context_local_file_path_denied");
      expect(f.deps.stat).not.toHaveBeenCalled();
      expect(f.deps.read).not.toHaveBeenCalled();
    },
  );
  it("does not reinterpret a legacy local-file map as a folder", async () => {
    const f = await fixture();
    delete f.map.localFileScope;
    await expect(f.repo.search(scope, "orchid")).rejects.toThrow(
      "context_local_file_scope_required",
    );
    expect(f.deps.stat).not.toHaveBeenCalled();
    expect(f.deps.read).not.toHaveBeenCalled();
  });
  it("rejects a previously issued record after the durable selected-file scope changes", async () => {
    const f = await fixture();
    const records = await f.repo.listRecords(scope);
    expect(records).toHaveLength(1);
    f.replace({
      ...f.map,
      localFileScope: {
        version: 1,
        rootDir: root,
        filePath: root + "/sibling.txt",
      },
    });
    f.deps.stat.mockClear();
    f.deps.read.mockClear();
    await expect(f.repo.readSource(records[0]!)).rejects.toThrow(
      "context_local_file_scope_changed",
    );
    expect(f.deps.stat).not.toHaveBeenCalled();
    expect(f.deps.read).not.toHaveBeenCalled();
  });
  it("does not hash after a held read observes durable file-scope revocation", async () => {
    const f = await fixture();
    const records = await f.repo.listRecords(scope);
    const original = f.deps.read;
    f.deps.read.mockImplementation(async (path) => {
      f.replace({ ...f.map, status: "deleted" });
      return { ok: true, path, content: body };
    });
    f.deps.stat.mockClear();
    await expect(f.repo.readSource(records[0]!)).rejects.toThrow(
      "context_local_file_scope_changed",
    );
    expect(f.deps.stat).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledOnce();
  });
  it("binds selected-file identity into the issued-evidence membership", async () => {
    const f = await fixture();
    const first = await f.repo.currentMapMembershipRevision!(scope, f.map.id);
    f.replace({
      ...f.map,
      localFileScope: {
        version: 1,
        rootDir: root,
        filePath: root + "/sibling.txt",
      },
    });
    const next = await f.repo.currentMapMembershipRevision!(scope, f.map.id);
    expect(next).not.toBe(first);
  });
  it("preserves a normal folder with two distinct physical sources", async () => {
    const f = await fixture();
    f.map.sourceType = "local_folder";
    delete f.map.localFileScope;
    f.map.tree.nodes = [
      ...f.map.tree.nodes,
      {
        id: "other",
        kind: "file",
        title: "sibling.txt",
        path: "sibling.txt",
        summary: "",
      },
    ];
    expect(await f.repo.listRecords(scope)).toHaveLength(2);
  });
});


describe("N11 membership refusal propagation", () => {
  it("returns the exact registry digest format and leaves folder digests unchanged", async () => {
    const f = await fixture();
    const fileRevision = await f.repo.currentMapMembershipRevision!(scope, f.map.id);
    expect(fileRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    f.map.sourceType = "local_folder";
    delete f.map.localFileScope;
    const folderRevision = await currentMembershipDigest(scope, f.map);
    expect(folderRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await f.repo.currentMapMembershipRevision!(scope, f.map.id)).toBe(folderRevision);
    expect(f.deps.stat).not.toHaveBeenCalled();
    expect(f.deps.read).not.toHaveBeenCalled();
  });

  it.each(["duplicate ID", "node bound"] as const)(
    "keeps an upstream %s refusal undefined before physical IO",
    async (reason) => {
      const f = await fixture();
      const node = f.map.tree.nodes[0]!;
      f.map.tree.nodes = reason === "duplicate ID"
        ? [node, { ...node }]
        : Array.from({ length: 4097 }, (_, index) => ({ ...node, id: `node-${index}` }));
      expect(await currentMembershipDigest(scope, f.map)).toBeUndefined();
      expect(await f.repo.currentMapMembershipRevision!(scope, f.map.id)).toBeUndefined();
      expect(f.deps.stat).not.toHaveBeenCalled();
      expect(f.deps.read).not.toHaveBeenCalled();
    },
  );

  it("does not turn an invalid selected-file descriptor into a membership digest", async () => {
    const f = await fixture();
    delete f.map.localFileScope;
    await expect(f.repo.currentMapMembershipRevision!(scope, f.map.id))
      .rejects.toThrow("context_local_file_scope_required");
    expect(f.deps.stat).not.toHaveBeenCalled();
    expect(f.deps.read).not.toHaveBeenCalled();
  });
});


it("rejects selected-file membership cancelled during its final scope hash", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let count = 0;
  let saved: ArrayBuffer | undefined;
  let release!: (value: ArrayBuffer) => void;
  const held = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    const value = await original(algorithm, data);
    if (++count === 2) { saved = value; return held; }
    return value;
  });
  const request = f.repo.currentMapMembershipRevision!(scope, f.map.id, controller.signal);
  const observed = request.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error) => ({ kind: "rejected" as const, error }),
  );
  try {
    await vi.waitFor(() => expect(saved).toBeDefined());
    controller.abort();
    release(saved!);
    expect((await observed).kind).toBe("rejected");
    expect(f.deps.stat).not.toHaveBeenCalled();
    expect(f.deps.read).not.toHaveBeenCalled();
  } finally {
    release(saved ?? new ArrayBuffer(32));
    await observed;
    spy.mockRestore();
  }
});

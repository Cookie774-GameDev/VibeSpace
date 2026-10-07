import { describe, expect, it, vi } from "vitest";
import {
  contextAutoFingerprint,
  createContextAutoUpdater,
  type ContextAutoUpdatePorts,
  type ContextAutoUpdateSetting,
} from "./contextAutoUpdate";
import { scanSiyuanFilesystemIndex } from "./siyuan/siyuanSafeIndex";
import type { ContextMapRecord } from "./tree";
const root = "/owned/docs";
const file = root + "/selected.txt";
const policy = {
  mode: "none" as const,
  selectedExtensions: [],
  selectedPaths: [],
};
function fixture() {
  let map: ContextMapRecord = {
    id: "map-n11-auto",
    projectId: "project-n11",
    rootDir: root,
    name: "Selected",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    sourceType: "local_file",
    localFileScope: { version: 1, rootDir: root, filePath: file },
    tree: {
      version: 1,
      projectId: "project-n11",
      rootDir: root,
      generatedAt: 1,
      model: "siyuan-managed-v1",
      summary: "",
      fileCount: 1,
      totalBytes: 3,
      nodes: [
        {
          id: "path:selected.txt",
          title: "selected.txt",
          path: "selected.txt",
          kind: "file",
          summary: "",
          sizeBytes: 3,
          modifiedAt: 1,
        },
      ],
    },
  };
  const setting: ContextAutoUpdateSetting = {
    kind: "context-auto-update-v1",
    accountId: "account-n11",
    workspaceId: "workspace-n11",
    projectId: "project-n11",
    mapId: map.id,
    enabled: true,
    consentRevision: 1,
    fingerprint: contextAutoFingerprint(map),
    indexIdentityVersion: 1,
    baseline: [
      {
        id: "path:selected.txt",
        path: "selected.txt",
        kind: "file",
        title: "selected.txt",
        size: 3,
        modified: 1,
      },
    ],
    lastSuccessAt: 1,
  };
  const stat = vi.fn(async () => ({
    ok: false as const,
    path: file,
    error: { code: "not_found" as const },
  }));
  const list = vi.fn(async () => {
    throw new Error("no sibling enumeration");
  });
  const ports: ContextAutoUpdatePorts = {
    readMap: vi.fn(async () => map),
    readSetting: vi.fn(async () => setting),
    fingerprint: contextAutoFingerprint,
    active: () => true,
    now: () => 2000,
    scan: (r, signal) =>
      scanSiyuanFilesystemIndex(r, policy, { signal, stat, list }),
    stage: vi.fn(),
    sync: vi.fn(),
    saveTree: vi.fn(),
    saveSetting: vi.fn(),
  };
  return {
    map,
    setting,
    ports,
    stat,
    list,
    change: (r: ContextMapRecord) => {
      map = r;
    },
  };
}
describe("N11 selected-file refresh", () => {
  it("separates file consent fingerprints without changing ordinary folder fingerprints", () => {
    const f = fixture();
    expect(
      contextAutoFingerprint({
        ...f.map,
        localFileScope: {
          version: 1,
          rootDir: root,
          filePath: root + "/sibling.txt",
        },
      }),
    ).not.toBe(contextAutoFingerprint(f.map));
    expect(
      JSON.parse(
        contextAutoFingerprint({
          ...f.map,
          sourceType: "local_folder",
          localFileScope: undefined,
        }),
      ),
    ).toEqual([root, "local_folder", []]);
  });
  it("keeps legacy fingerprint rendering total but refuses the scan before IO", async () => {
    const f = fixture();
    delete f.map.localFileScope;
    expect(() => contextAutoFingerprint(f.map)).not.toThrow();
    f.setting.fingerprint = contextAutoFingerprint(f.map);
    await expect(
      createContextAutoUpdater(f.ports).tick(new AbortController().signal),
    ).rejects.toThrow("context_local_file_scope_required");
    expect(f.stat).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });
  it.each(["not_found", "outside_root"] as const)(
    "preserves last good metadata on %s without choosing a sibling",
    async (code) => {
      const f = fixture();
      f.stat = vi.fn(async () => ({
        ok: false as const,
        path: file,
        error: { code },
      })) as any;
      f.ports.scan = (r, signal) =>
        scanSiyuanFilesystemIndex(r, policy, {
          signal,
          stat: f.stat,
          list: f.list,
        });
      const before = JSON.stringify(f.setting);
      await expect(
        createContextAutoUpdater(f.ports).tick(new AbortController().signal),
      ).rejects.toThrow("siyuan_local_file_unavailable:" + code);
      expect(f.list).not.toHaveBeenCalled();
      expect(f.ports.stage).not.toHaveBeenCalled();
      expect(f.ports.saveTree).not.toHaveBeenCalled();
      expect(f.ports.saveSetting).not.toHaveBeenCalled();
      expect(JSON.stringify(f.setting)).toBe(before);
    },
  );
  it("rejects a sibling-bearing refresh result before planning deletion or content reads", async () => {
    const f = fixture();
    f.ports.scan = vi.fn(async () => ({
      entries: [
        {
          nodeId: "path:sibling.txt",
          parentNodeId: null,
          title: "sibling.txt",
          kind: "file" as const,
          relativePath: "sibling.txt",
          sourcePointer: root + "/sibling.txt",
          summary: null,
          sizeBytes: 3,
          modifiedAt: 1,
        },
      ],
      excluded: 0,
      unreadable: 0,
      summarized: 0,
    }));
    await expect(
      createContextAutoUpdater(f.ports).tick(new AbortController().signal),
    ).rejects.toThrow("siyuan_local_file_checkpoint_scope_invalid");
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
  });
});

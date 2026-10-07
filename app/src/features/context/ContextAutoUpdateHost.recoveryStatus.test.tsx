import "fake-indexeddb/auto";
import * as React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, openDb } from "@/lib/db";
import { useAuthStore } from "@/stores/auth";
import type { ProjectId, WorkspaceId } from "@/types/common";
import type { ContextMapRecord } from "./tree";
import type {
  ContextAutoUpdatePorts,
  ContextAutoUpdateSetting,
} from "./contextAutoUpdate";
import { contextAutoUpdateKey } from "./contextAutoUpdate";
import { ContextAutoUpdateHost } from "./ContextAutoUpdateHost";
import { ContextAutoUpdateCheckbox } from "./ContextAutoUpdateCheckbox";

const io = vi.hoisted(() => ({
  ports: null as ContextAutoUpdatePorts | null,
  results: [] as string[],
  tickCount: 0,
  nextTickGate: undefined as Promise<void> | undefined,
  releaseTick: undefined as (() => void) | undefined,
}));

// Keep the production host, updater engine, setting store and visible checkbox.
// Only the native/file/map ports at the factory boundary are synthetic.
vi.mock("@/features/context/contextAutoUpdate", async (original) => {
  const actual = await original<typeof import("./contextAutoUpdate")>();
  return {
    ...actual,
    createProductionContextAutoUpdater: async () => {
      const updater = await actual.createProductionContextAutoUpdater(scope);
      return {
        tick: async (signal: AbortSignal) => {
          if (++io.tickCount > 1) await io.nextTickGate;
          const result = await updater.tick(signal);
          io.results.push(result);
          return result;
        },
      };
    },
  };
});
vi.mock("@/features/context/contextPersistence", async (original) => ({
  ...(await original<typeof import("./contextPersistence")>()),
  captureContextPersistenceScope: async () => ({
    loadMap: () => io.ports!.readMap(),
    saveExistingTree: async () => {
      throw new Error("unchanged scan must not save a tree");
    },
  }),
}));
vi.mock("@/features/context/siyuan/siyuanMapManifest", async (original) => ({
  ...(await original<typeof import("./siyuan/siyuanMapManifest")>()),
  readSiyuanMapManifest: () => ({
    status: "ready",
    sourceRoot: "C:/owned-synthetic",
    sourcePolicy: { excludedPaths: [] },
  }),
}));
vi.mock("@/features/context/siyuan/siyuanIndexJobStore", async (original) => ({
  ...(await original<typeof import("./siyuan/siyuanIndexJobStore")>()),
  readSiyuanIndexJob: async () => ({
    status: "completed",
    accountId: "recovery-account",
    canonicalRoot: "C:/owned-synthetic",
  }),
}));
vi.mock("@/features/context/siyuan/siyuanSafeIndex", async (original) => ({
  ...(await original<typeof import("./siyuan/siyuanSafeIndex")>()),
  scanSiyuanFilesystemIndex: (
    map: ContextMapRecord,
    _summary: unknown,
    options: { signal: AbortSignal },
  ) => io.ports!.scan(map, options.signal),
}));
vi.mock("@/features/context/contextSearchIndexing", async (original) => ({
  ...(await original<typeof import("./contextSearchIndexing")>()),
  createContextSearchIndexPopulationPort: () => ({
    stageChangedMap: (...args: unknown[]) => {
      throw new Error(`unchanged scan must not stage ${args.length}`);
    },
  }),
}));
vi.mock("@/features/dev-console", () => ({ devConsole: { log: vi.fn() } }));

const scope = {
  accountId: "recovery-account",
  workspaceId: "recovery-workspace",
  projectId: "recovery-project",
  mapId: "recovery-map",
};
const key = contextAutoUpdateKey(scope);
const metadata = {
  id: "path:source.txt",
  path: "source.txt",
  kind: "file",
  title: "source.txt",
  size: 3,
  modified: 2,
};
let map: ContextMapRecord;
let scanCount = 0;

beforeEach(async () => {
  await openDb();
  await db.settings.clear();
  await db.context_maps.clear();
  vi.restoreAllMocks();
  io.results = [];
  io.tickCount = 0;
  io.nextTickGate = undefined;
  scanCount = 0;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  useAuthStore.setState({
    localUserId: scope.accountId,
    cloudSession: null,
    workspaceId: scope.workspaceId as WorkspaceId,
    projectId: scope.projectId as ProjectId,
  });
  map = {
    id: scope.mapId,
    projectId: scope.projectId,
    rootDir: "C:/owned-synthetic",
    name: "Recovery fixture",
    status: "active",
    sourceType: "local_folder",
    createdAt: 1,
    updatedAt: 2,
    tree: {
      version: 1,
      projectId: scope.projectId,
      rootDir: "C:/owned-synthetic",
      generatedAt: 2,
      model: "siyuan",
      fileCount: 1,
      totalBytes: 3,
      summary: "",
      nodes: [
        {
          id: metadata.id,
          title: metadata.title,
          path: metadata.path,
          kind: "file",
          summary: "",
          sizeBytes: 3,
          modifiedAt: 2,
        },
      ],
    },
  };
  await db.context_maps.put({
    version: 2,
    id: map.id,
    accountId: scope.accountId,
    projectId: scope.projectId,
    name: map.name,
    status: "active",
    sourceIds: [],
    summary: "",
    recommendedEntryPoints: [],
    statistics: {
      sourceCount: 1,
      entityCount: 1,
      edgeCount: 0,
      noteCount: 0,
      attachmentCount: 0,
      staleSourceCount: 0,
    },
    createdAt: 1,
    updatedAt: 2,
    knowledgeRevision: 1,
  });
  const fingerprint = JSON.stringify([
    "c:/owned-synthetic",
    "local_folder",
    [],
  ]);
  const setting: ContextAutoUpdateSetting = {
    ...scope,
    kind: "context-auto-update-v1",
    enabled: true,
    consentRevision: 1,
    fingerprint,
    baseline: [metadata],
    baselineMapRevision: 2,
    indexIdentityVersion: 1,
    status: "watching",
    lastSuccessAt: 42,
  };
  await db.settings.put({ key, value: setting, updated_at: 42 });
  io.ports = {
    readSetting: async () =>
      (await db.settings.get(key))?.value as ContextAutoUpdateSetting,
    readMap: async () => map,
    fingerprint: () => fingerprint,
    active: () => true,
    now: () => Date.now(),
    scan: vi.fn<ContextAutoUpdatePorts["scan"]>(async () => {
      scanCount += 1;
      if (scanCount === 1) {
        map = { ...map, updatedAt: 3 };
        await db.context_maps.update(map.id, { updatedAt: 3 });
      }
      return {
        entries: [
          {
            nodeId: metadata.id,
            parentNodeId: null,
            title: metadata.title,
            kind: "file",
            relativePath: metadata.path,
            sourcePointer: "C:/owned-synthetic/source.txt",
            summary: null,
            sizeBytes: 3,
            modifiedAt: 2,
          },
        ],
        excluded: 0,
        unreadable: 0,
        summarized: 0,
      };
    }),
    stage: vi.fn(async () => {
      throw new Error("unchanged scan must not stage");
    }),
    sync: vi.fn(async () => {
      throw new Error("unchanged scan must not sync");
    }),
    saveTree: vi.fn(async () => {
      throw new Error("unchanged scan must not save a tree");
    }),
    saveSetting: vi.fn(async (value) => {
      await db.settings.put({ key, value, updated_at: Date.now() });
    }),
  };
});

afterEach(async () => {
  cleanup();
  io.releaseTick?.();
  io.releaseTick = undefined;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  await db.settings.clear();
});

it("clears the current failed status after a verified healthy unchanged scan without claiming an index commit", async () => {
  const { failed, resume } = await mountFailedHost(true);
  // Confirm that this is a visible failure, not merely an unused stored field.
  expect(
    await screen.findByText(/context_auto_update_scope_changed/),
  ).toBeTruthy();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    resume();
  });
  await waitFor(() => expect(io.results).toContain("idle"));
  const afterIdle = (await db.settings.get(key))!;
  expect(scanCount).toBeGreaterThanOrEqual(2);
  await waitFor(async () =>
    expect((await db.settings.get(key))?.value).toMatchObject({
      status: "watching",
    }),
  );
  const recovered = (await db.settings.get(key))!;
  expect(recovered.value).toMatchObject({
    enabled: true,
    consentRevision: 1,
    lastSuccessAt: 42,
    baselineMapRevision: 2,
    baseline: [metadata],
  });
  expect((recovered.value as ContextAutoUpdateSetting).error).toBeUndefined();
  expect(recovered.updated_at).toBeGreaterThanOrEqual(failed.updated_at);
  expect(io.ports!.stage).not.toHaveBeenCalled();
  expect(io.ports!.sync).not.toHaveBeenCalled();
  expect(io.ports!.saveTree).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByText(/context_auto_update_scope_changed/)).toBeNull(),
  );
  const previousScans = scanCount;
  io.results = [];
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(scanCount).toBeGreaterThan(previousScans));
  await waitFor(() => expect(io.results).toContain("idle"));
  expect(await db.settings.get(key)).toEqual(recovered);
});

async function mountFailedHost(withCheckbox = false) {
  let release!: () => void;
  io.nextTickGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  io.releaseTick = release;
  const view = render(
    <>
      <ContextAutoUpdateHost />
      {withCheckbox ? (
        <ContextAutoUpdateCheckbox
          accountId={scope.accountId}
          workspaceId={scope.workspaceId}
          map={map}
        />
      ) : null}
    </>,
  );
  await waitFor(async () =>
    expect((await db.settings.get(key))?.value).toMatchObject({
      status: "failed",
      error: "context_auto_update_scope_changed",
    }),
  );
  return {
    view,
    failed: (await db.settings.get(key))!,
    resume: () => {
      io.nextTickGate = undefined;
      release();
    },
  };
}

it.each([
  "newer-error",
  "newer-same-error",
  "consent",
  "disabled",
  "map-revision",
  "foreign-map-owner",
  "account-ABA",
] as const)(
  "preserves newer authority/state after the healthy scan with %s",
  async (mode) => {
    const { failed, resume, view } = await mountFailedHost();
    let reads = 0;
    let changed = false;
    let expected = failed;
    io.ports!.readMap = async () => {
      const observed = map;
      if (++reads === 2) {
        changed = true;
        if (mode === "account-ABA") {
          useAuthStore.setState({ localUserId: "another-account" });
          useAuthStore.setState({ localUserId: scope.accountId });
          view.unmount();
        } else if (mode === "foreign-map-owner") {
          await db.context_maps.update(map.id, {
            accountId: "foreign-account",
          });
        } else if (mode === "map-revision") {
          map = { ...map, updatedAt: 4 };
          await db.context_maps.update(map.id, { updatedAt: 4 });
        } else {
          const old = failed.value as ContextAutoUpdateSetting;
          const value = {
            ...old,
            ...(mode === "newer-error"
              ? { error: "context_auto_update_discovery_incomplete" }
              : {}),
            ...(mode === "consent"
              ? { consentRevision: old.consentRevision + 1 }
              : {}),
            ...(mode === "disabled" ? { enabled: false } : {}),
          };
          expected = { ...failed, value, updated_at: failed.updated_at + 1 };
          await db.settings.put(expected);
        }
      }
      return observed;
    };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      resume();
    });
    await waitFor(() => expect(changed).toBe(true));
    if (mode !== "account-ABA")
      await waitFor(() => expect(io.results).toContain("idle"));
    expect(await db.settings.get(key)).toEqual(expected);
  },
);

it.each(["scope-ABA", "dispose"] as const)(
  "aborts a queued recovery write on %s",
  async (mode) => {
    const { view, failed, resume } = await mountFailedHost();
    const put = db.settings.put.bind(db.settings);
    let revoked = false;
    vi.spyOn(db.settings, "put").mockImplementation((row, ...rest) =>
      put(row, ...rest).then((result) => {
        if (
          !revoked &&
          row.key === key &&
          (row.value as ContextAutoUpdateSetting).status === "watching"
        ) {
          revoked = true;
          if (mode === "dispose") view.unmount();
          else {
            useAuthStore.setState({ localUserId: "another-account" });
            useAuthStore.setState({ localUserId: scope.accountId });
            view.unmount();
          }
        }
        return result;
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      resume();
    });
    await waitFor(() => expect(revoked).toBe(true));
    // This read waits behind the real IDB transaction and observes its rollback.
    expect(await db.settings.get(key)).toEqual(failed);
  },
);

it("keeps a nonrecoverable rollback error after an otherwise healthy unchanged scan", async () => {
  const { resume } = await mountFailedHost();
  const current = (await db.settings.get(key))!;
  const saved = {
    ...current,
    value: {
      ...(current.value as ContextAutoUpdateSetting),
      error: "context_auto_update_rollback_needs_review",
    },
    updated_at: current.updated_at + 1,
  };
  await db.settings.put(saved);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    resume();
  });
  await waitFor(() => expect(io.results).toContain("idle"));
  expect(await db.settings.get(key)).toEqual(saved);
});

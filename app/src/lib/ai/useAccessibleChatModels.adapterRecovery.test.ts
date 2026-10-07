import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ request: vi.fn(), events: vi.fn() }));
const runtime = vi.hoisted(() => ({
  getSnapshot: vi.fn(() => ({
    kind: "ready",
    source: "system",
    version: "synthetic",
  })),
  getConnection: vi.fn(() => ({
    generation: "rdy03-fixed-generation",
    source: "system",
    version: "synthetic",
  })),
  subscribe: vi.fn(() => () => undefined),
  refresh: vi.fn(async () => undefined),
}));
vi.mock("@/lib/harness/openCodeNativeTransport", () => ({
  nativeOpenCodeRequest: native.request,
  nativeOpenCodeEvents: native.events,
}));
vi.mock("@/lib/harness/runtimeManager", () => ({
  harnessRuntimeManager: runtime,
}));
vi.mock("./adapters/autoDetectConnections", () => ({
  ensureExternalConnectionAutoDetection: vi.fn(async () => ({})),
}));
vi.mock("./adapters/codexPersistent", () => ({
  invalidateCodexPersistentModelCache: vi.fn(),
  codexPersistentAdapter: { listModels: vi.fn(async () => []) },
}));
vi.mock("./providerModelCatalog", async (load) => ({
  ...(await load<typeof import("./providerModelCatalog")>()),
  refreshConnectedProviderModels: vi.fn(async () => []),
}));
import {
  useAccessibleChatModels,
  requestOpenCodeModelCatalogRefresh,
  readOpenCodeCatalogEvidence,
} from "./useAccessibleChatModels";
import {
  disposeOpenCodePersistentRuntimes,
  invalidateOpenCodePersistentCaches,
  openCodePersistentAdapter,
} from "./adapters/opencodePersistent";
import { resolveVoiceProviderSelection } from "@/features/voice/voiceProviderSelection";
import {
  resetConnectionSessionChecksForTests,
  markConnectionSessionChecked,
  writeConnectionMetadata,
} from "./connectionState";
import { resetDiscoveredConnectionModelsForTests } from "./connectionCatalog";
import { useAuthStore } from "@/stores/auth";
import { selectionFromOption } from "./modelSelection";
import { OPENCODE_CLI_CONNECTION } from "./adapters/catalog";
import type { ModelPickerOption } from "./useAccessibleChatModels";

function completeLunaSelection() {
  const selection = selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
  if (selection.mode !== 'single') throw new Error('Synthetic picker must be single');
  return selection;
}
const selected = completeLunaSelection();
// This positive exercises selection of the actual emitted picker row, not the
// separate saved-provider contract discrepancy reproduced by RDY04.
function emittedPickerSelection(options: readonly ModelPickerOption[]) {
  const candidate = options.find((row) => row.modelId === selected.modelId);
  if (!candidate?.connection)
    throw new Error("Synthetic exact picker route missing");
  const selection = selectionFromOption(
    candidate.provider,
    candidate.modelId,
    candidate.connection,
  );
  if (selection.mode !== "single")
    throw new Error("Synthetic picker must be single");
  return selection;
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const populated = {
  providers: [
    {
      id: "openai",
      models: { "gpt-6-luna": { name: "GPT-6 Luna", variants: { low: {} } } },
    },
  ],
};

beforeEach(async () => {
  await disposeOpenCodePersistentRuntimes();
  invalidateOpenCodePersistentCaches();
  window.localStorage.clear();
  document.documentElement.removeAttribute(
    "data-vibespace-opencode-catalog-evidence",
  );
  resetConnectionSessionChecksForTests();
  resetDiscoveredConnectionModelsForTests();
  vi.clearAllMocks();
  useAuthStore.setState({
    defaultLocalModel: "",
    apiKeys: {},
    offlineMode: false,
    plan: "free",
  });
  requestOpenCodeModelCatalogRefresh();
  writeConnectionMetadata({
    "opencode-cli": {
      installation: "installed",
      auth: "authenticated",
      lastCheckedAt: 1,
    },
  });
  markConnectionSessionChecked(["opencode-cli"]);
  vi.useFakeTimers();
});
afterEach(async () => {
  await disposeOpenCodePersistentRuntimes();
  invalidateOpenCodePersistentCaches();
  vi.useRealTimers();
});

describe("actual OpenCode hook and adapter catalog recovery", () => {
  it.each(["empty", "request-error"] as const)(
    "recovers ready exact route at short retry after %s catalog",
    async (initial) => {
      let ready = false;
      const reads: Array<{ at: number; path: string; ready: boolean }> = [];
      const started = Date.now();
      native.request.mockImplementation(
        async (_generation: string, path: string, init?: RequestInit) => {
          expect(init?.method ?? "GET").toBe("GET");
          reads.push({ at: Date.now() - started, path, ready });
          if (path === "/global/health")
            return response({ healthy: true, version: "synthetic" });
          if (path === "/provider") return response({ connected: ["openai"] });
          if (path === "/config/providers") {
            if (ready) return response(populated);
            return initial === "empty"
              ? response({ providers: [] })
              : response(
                  {
                    error: {
                      message: "Synthetic catalog temporarily unavailable",
                    },
                  },
                  503,
                );
          }
          throw new Error(`Unexpected synthetic endpoint: ${path}`);
        },
      );
      const hook = renderHook(() => useAccessibleChatModels());
      try {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(
          reads.filter((r) => r.path === "/config/providers"),
        ).toHaveLength(1);
        expect(() =>
          resolveVoiceProviderSelection({
            provider: "opencode",
            preferredSelection: selected,
            options: hook.result.current.flatOptions,
          }),
        ).toThrow("The selected OpenCode model is unavailable");
        ready = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        const routeAt15 = hook.result.current.flatOptions.find(
          (r) => r.modelId === selected.modelId,
        );
        // Matches the existing documented hook test, now exercising the actual adapter cache.
        expect(routeAt15).toMatchObject({
          available: true,
          connectionId: "opencode-cli",
        });
        expect(
          reads.filter((r) => r.path === "/config/providers"),
        ).toHaveLength(2);
        const fromPicker = emittedPickerSelection(
          hook.result.current.flatOptions,
        );
        expect(
          resolveVoiceProviderSelection({
            provider: "opencode",
            preferredSelection: fromPicker,
            options: hook.result.current.flatOptions,
          }).selection,
        ).toEqual(fromPicker);
        expect(() =>
          resolveVoiceProviderSelection({
            provider: "opencode",
            preferredSelection: {
              ...fromPicker,
              modelId: "openai/not-present",
            },
            options: hook.result.current.flatOptions,
          }),
        ).toThrow("The selected OpenCode model is unavailable");
        expect(() =>
          resolveVoiceProviderSelection({
            provider: "opencode",
            preferredSelection: { ...fromPicker, providerId: "anthropic" },
            options: hook.result.current.flatOptions,
          }),
        ).toThrow("The selected OpenCode model is unavailable");
        expect(native.events).not.toHaveBeenCalled();
        expect(runtime.refresh).not.toHaveBeenCalled();
      } finally {
        hook.unmount();
      }
    },
  );

  it("coalesces staggered consumers and keeps the negative cache until the short retry", async () => {
    let ready = false;
    let catalogReads = 0;
    native.request.mockImplementation(
      async (_generation: string, path: string, init?: RequestInit) => {
        expect(init?.method ?? "GET").toBe("GET");
        if (path === "/global/health")
          return response({ healthy: true, version: "synthetic" });
        if (path === "/provider") return response({ connected: ["openai"] });
        if (path === "/config/providers") {
          catalogReads += 1;
          return response(ready ? populated : { providers: [] });
        }
        throw new Error(`Unexpected synthetic endpoint: ${path}`);
      },
    );
    const first = renderHook(() => useAccessibleChatModels());
    let second:
      | ReturnType<
          typeof renderHook<ReturnType<typeof useAccessibleChatModels>, unknown>
        >
      | undefined;
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(catalogReads).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      second = renderHook(() => useAccessibleChatModels());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(catalogReads).toBe(1);
      ready = true;
      // Mounting the second consumer refreshes connection state and re-arms both effects.
      // Their single short retry is due 15 seconds after that lifecycle boundary.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(catalogReads).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(catalogReads).toBe(2);
      expect(
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: emittedPickerSelection(
            first.result.current.flatOptions,
          ),
          options: first.result.current.flatOptions,
        }).selection,
      ).toEqual(emittedPickerSelection(first.result.current.flatOptions));
      expect(
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: emittedPickerSelection(
            second.result.current.flatOptions,
          ),
          options: second.result.current.flatOptions,
        }).selection,
      ).toEqual(emittedPickerSelection(second.result.current.flatOptions));
      expect(native.events).not.toHaveBeenCalled();
    } finally {
      first.unmount();
      second?.unmount();
    }
  });

  it("retains the nonempty cache for sixty seconds and coalesces concurrent direct reads", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let catalogReads = 0;
    native.request.mockImplementation(
      async (_generation: string, path: string, init?: RequestInit) => {
        expect(init?.method ?? "GET").toBe("GET");
        if (path === "/global/health")
          return response({ healthy: true, version: "synthetic" });
        if (path === "/provider") return response({ connected: ["openai"] });
        if (path === "/config/providers") {
          catalogReads += 1;
          await held;
          return response(populated);
        }
        throw new Error(`Unexpected synthetic endpoint: ${path}`);
      },
    );
    const first = openCodePersistentAdapter.listModels!();
    const second = openCodePersistentAdapter.listModels!();
    await vi.advanceTimersByTimeAsync(0);
    expect(catalogReads).toBe(1);
    release();
    expect(await first).toEqual(await second);
    expect((await first)[0]?.id).toBe(selected.modelId);
    await vi.advanceTimersByTimeAsync(59_999);
    expect((await openCodePersistentAdapter.listModels!())[0]?.id).toBe(
      selected.modelId,
    );
    expect(catalogReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await openCodePersistentAdapter.listModels!())[0]?.id).toBe(
      selected.modelId,
    );
    expect(catalogReads).toBe(2);
    expect(native.events).not.toHaveBeenCalled();
  });

  it("keeps repeated empty discovery unavailable and bounded to the existing retry interval", async () => {
    let catalogReads = 0;
    native.request.mockImplementation(
      async (_generation: string, path: string, init?: RequestInit) => {
        expect(init?.method ?? "GET").toBe("GET");
        if (path === "/global/health")
          return response({ healthy: true, version: "synthetic" });
        if (path === "/provider") return response({ connected: ["openai"] });
        if (path === "/config/providers") {
          catalogReads += 1;
          return response({ providers: [] });
        }
        throw new Error(`Unexpected synthetic endpoint: ${path}`);
      },
    );
    const hook = renderHook(() => useAccessibleChatModels());
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(catalogReads).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_999);
      });
      expect(catalogReads).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(catalogReads).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(catalogReads).toBe(3);
      expect(readOpenCodeCatalogEvidence()).toBeUndefined();
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: selected,
          options: hook.result.current.flatOptions,
        }),
      ).toThrow("The selected OpenCode model is unavailable");
    } finally {
      hook.unmount();
    }
  });

  it("does not start discovery or admit a route when the current session is unauthenticated", async () => {
    writeConnectionMetadata({
      "opencode-cli": {
        installation: "installed",
        auth: "unauthenticated",
        lastCheckedAt: 1,
      },
    });
    const hook = renderHook(() => useAccessibleChatModels());
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(native.request).not.toHaveBeenCalled();
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: selected,
          options: hook.result.current.flatOptions,
        }),
      ).toThrow("The selected OpenCode model is unavailable");
    } finally {
      hook.unmount();
    }
  });
});

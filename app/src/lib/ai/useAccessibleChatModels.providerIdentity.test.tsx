import {
  act,
  renderHook,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
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
  buildConnectionPickerGroups,
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

function completeLunaSelection() {
  const selection = selectionFromOption(
    "openai",
    "openai/gpt-6-luna",
    OPENCODE_CLI_CONNECTION,
  );
  if (selection.mode !== "single")
    throw new Error("Synthetic picker must be single");
  return selection;
}
const selected = completeLunaSelection();
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

import {
  selectionFromOption,
  normalizeChatModelSelection,
} from "./modelSelection";

import {
  ModelPickerTypeahead,
  type ModelPickerTypeaheadProps,
} from "@/features/chat/ModelPickerTypeahead";
import {
  OPENCODE_CLI_CONNECTION,
  CODEX_CLI_CONNECTION,
} from "./adapters/catalog";

function configureCatalog(
  payload: unknown = populated,
  connected = ["openai"],
) {
  native.request.mockImplementation(
    async (_generation: string, path: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      if (path === "/global/health")
        return response({ healthy: true, version: "synthetic" });
      if (path === "/provider") return response({ connected });
      if (path === "/config/providers") return response(payload);
      throw new Error(`Unexpected synthetic endpoint: ${path}`);
    },
  );
}

describe("OpenCode picker declared provider identity", () => {
  it("admits a restored valid OpenAI selection through its actual ready OpenCode route", async () => {
    configureCatalog();
    const hook = renderHook(() => useAccessibleChatModels());
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const candidate = hook.result.current.flatOptions.find(
        (row) => row.modelId === selected.modelId,
      );
      expect(candidate).toMatchObject({
        provider: "openai",
        connectionId: "opencode-cli",
        modelId: selected.modelId,
        available: true,
        connection: { id: "opencode-cli" },
      });
      expect(
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: selected,
          options: hook.result.current.flatOptions,
          preservePreferredRoute: true,
        }).selection,
      ).toMatchObject(selected);
      expect(native.events).not.toHaveBeenCalled();
      expect(runtime.refresh).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it("emits the same valid identity from the real fresh picker callback without changing transport or effort", async () => {
    configureCatalog();
    const hook = renderHook(() => useAccessibleChatModels());
    let view: ReturnType<typeof render> | undefined;
    const onSelect = vi.fn<ModelPickerTypeaheadProps["onSelect"]>();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      view = render(
        <ModelPickerTypeahead
          groups={hook.result.current.groups}
          selectedId="opencode-cli:openai/gpt-6-luna"
          initialEffort="low"
          onSelect={onSelect}
        />,
      );
      fireEvent.click(screen.getByRole("option", { name: /GPT-6 Luna/i }));
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("option", { name: "low" }));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        "openai",
        selected.modelId,
        OPENCODE_CLI_CONNECTION,
        "low",
      );
      const [provider, model, connection] = onSelect.mock.calls[0]!;
      const saved = selectionFromOption(provider, model, connection);
      expect(
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: saved,
          options: hook.result.current.flatOptions,
          preservePreferredRoute: true,
        }).selection,
      ).toEqual(saved);
      expect(native.events).not.toHaveBeenCalled();
    } finally {
      view?.unmount();
      hook.unmount();
    }
  });

  it("preserves exact alternative models, known aliases and aggregator ownership without guessing unknown providers", async () => {
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-6-luna": { name: "GPT-6 Luna" },
          "gpt-6-luna-fast": { name: "GPT-6 Luna" },
        },
      },
      {
        id: "openrouter",
        models: { "openai/gpt-6-luna": { name: "OpenRouter Luna" } },
      },
      { id: "qwen", models: { "qwen3.7-plus": { name: "Qwen 3.7 Plus" } } },
      {
        id: "qwen-coding-plan",
        models: { "qwen3.7-plus": { name: "Qwen 3.7 Plus" } },
      },
      {
        id: "unknown-vendor",
        models: { custom: { name: "Unknown exact route" } },
      },
    ];
    configureCatalog(
      { providers },
      providers.map((provider) => provider.id),
    );
    const hook = renderHook(() => useAccessibleChatModels());
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const routes = hook.result.current.flatOptions;
      expect(routes.map((row) => [row.modelId, row.provider]).sort()).toEqual(
        [
          ["openai/gpt-6-luna", "openai"],
          ["openai/gpt-6-luna-fast", "openai"],
          ["openrouter/openai/gpt-6-luna", "openrouter"],
          ["qwen/qwen3.7-plus", "qwen"],
          ["qwen-coding-plan/qwen3.7-plus", "qwen"],
          ["unknown-vendor/custom", OPENCODE_CLI_CONNECTION.providerId],
        ].sort(),
      );
      expect(
        routes.every(
          (row) =>
            row.connectionId === OPENCODE_CLI_CONNECTION.id &&
            row.connection === OPENCODE_CLI_CONNECTION,
        ),
      ).toBe(true);
      const openai = hook.result.current.groups.find(
        (group) => group.provider === "openai",
      );
      expect(
        openai?.options[0]?.alternativeRoutes?.map((row) => row.modelId).sort(),
      ).toEqual(["openai/gpt-6-luna", "openai/gpt-6-luna-fast"]);
      const qwen = hook.result.current.groups.find(
        (group) => group.provider === "qwen",
      );
      expect(
        qwen?.options[0]?.alternativeRoutes?.map((row) => row.modelId).sort(),
      ).toEqual(["qwen-coding-plan/qwen3.7-plus", "qwen/qwen3.7-plus"]);
      expect(
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: {
            ...selected,
            providerId: "openrouter",
            modelId: "openrouter/openai/gpt-6-luna",
          },
          options: routes,
        }).selection,
      ).toMatchObject({
        providerId: "openrouter",
        modelId: "openrouter/openai/gpt-6-luna",
        connectionId: "opencode-cli",
      });
      for (const modelId of [
        "qwen-coding-plan/qwen3.7-plus",
        "unknown-vendor/custom",
      ]) {
        const legacy = normalizeChatModelSelection({
          ...selected,
          providerId: OPENCODE_CLI_CONNECTION.providerId,
          modelId,
        });
        expect(
          resolveVoiceProviderSelection({
            provider: "opencode",
            preferredSelection: legacy,
            options: routes,
          }).selection,
        ).toMatchObject({ modelId, connectionId: "opencode-cli" });
      }

      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: {
            ...selected,
            modelId: "openrouter/openai/gpt-6-luna",
          },
          options: routes,
        }),
      ).toThrow("The selected OpenCode model is unavailable");
    } finally {
      hook.unmount();
    }
  });

  it("retains strict wrong-provider, wrong-model, wrong-connection and unavailable-row refusal", async () => {
    configureCatalog();
    const hook = renderHook(() => useAccessibleChatModels());
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const routes = hook.result.current.flatOptions;
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: { ...selected, providerId: "anthropic" },
          options: routes,
        }),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: { ...selected, modelId: "openai/not-in-catalog" },
          options: routes,
        }),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: selectionFromOption(
            "openai", selected.modelId, CODEX_CLI_CONNECTION,
          ),
          options: routes,
          preservePreferredRoute: true,
        }),
      ).toThrow("The selected Codex model is unavailable. Choose an available Codex model.");
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: selected,
          options: routes.map((row) => ({ ...row, available: false })),
        }),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: selected,
          options: routes.map((row) => ({
            ...row,
            connection: CODEX_CLI_CONNECTION,
          })),
        }),
      ).toThrow("The selected OpenCode model is unavailable");
    } finally {
      hook.unmount();
    }
  });

  it("keeps the previously emitted saved transport-owner selection usable for the same verified route", async () => {
    configureCatalog();
    const legacySaved = normalizeChatModelSelection({
      ...selected,
      providerId: OPENCODE_CLI_CONNECTION.providerId,
    });
    const originalSaved = JSON.stringify(legacySaved);
    const hook = renderHook(() => useAccessibleChatModels());
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection: legacySaved,
          options: hook.result.current.flatOptions,
          preservePreferredRoute: true,
        }),
      ).toMatchObject({
        connectionId: "opencode-cli",
        selection: {
          mode: "single",
          modelId: selected.modelId,
          connectionId: "opencode-cli",
        },
      });
      expect(JSON.stringify(legacySaved)).toBe(originalSaved);
    } finally {
      hook.unmount();
    }
  });

  it("does not let legacy compatibility grant an unknown owner or bypass exact route availability", async () => {
    configureCatalog();
    const hook = renderHook(() => useAccessibleChatModels());
    const legacy = normalizeChatModelSelection({
      ...selected,
      providerId: OPENCODE_CLI_CONNECTION.providerId,
    });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const routes = hook.result.current.flatOptions;
      const resolve = (options: typeof routes, preferredSelection = legacy) =>
        resolveVoiceProviderSelection({
          provider: "opencode",
          preferredSelection,
          options,
          preservePreferredRoute: true,
        });
      expect(() =>
        resolve(routes.map((row) => ({ ...row, available: false }))),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolve(
          routes.map((row) => ({ ...row, connection: CODEX_CLI_CONNECTION })),
        ),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolve(routes.map((row) => ({ ...row, provider: "anthropic" }))),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolve(
          routes,
          normalizeChatModelSelection({
            ...selected,
            providerId: OPENCODE_CLI_CONNECTION.providerId,
            modelId: "openai/other-model",
          }),
        ),
      ).toThrow("The selected OpenCode model is unavailable");
      expect(() =>
        resolve(
          routes,
          normalizeChatModelSelection({
            ...selected,
            providerId: OPENCODE_CLI_CONNECTION.providerId,
            connectionId: CODEX_CLI_CONNECTION.id,
          }),
        ),
      ).toThrow(/unavailable|no available/);
      for (const modelId of [
        "unknown-vendor/custom",
        "openai-lookalike/gpt-6-luna",
      ]) {
        const forged = routes.map((row) => ({
          ...row,
          modelId,
          provider: "openai" as const,
        }));
        const saved = normalizeChatModelSelection({
          ...selected,
          modelId,
          providerId: OPENCODE_CLI_CONNECTION.providerId,
        });
        expect(() => resolve(forged, saved)).toThrow(
          "The selected OpenCode model is unavailable",
        );
      }
    } finally {
      hook.unmount();
    }
  });
});

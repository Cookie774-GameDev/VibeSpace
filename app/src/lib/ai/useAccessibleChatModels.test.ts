import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth';
import { syncDiscoveredOllamaModels, syncFoundryModelOptions } from './models';
import {
  buildConnectionPickerGroups,
  buildLiveOpenCodePickerModels,
  buildModelPickerGroups,
  connectionRouteProviderLabel,
  findBackendModelPickerRoute,
  filterModelPickerGroupsForBackend,
  isModelPickerRouteCompatibleWithBackend,
  OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE,
  readOpenCodeCatalogEvidence,
  requestOpenCodeModelCatalogRefresh,
  useAccessibleChatModels,
} from './useAccessibleChatModels';
import type { ModelPickerOption } from './useAccessibleChatModels';
import {
  CODEX_CLI_CONNECTION,
  CONNECTION_MODEL_OPTIONS,
  OPENCODE_CLI_CONNECTION,
} from './adapters/catalog';
import {
  OPENAI_API_CONNECTION,
  OPENROUTER_API_CONNECTION,
  QWEN_API_CONNECTION,
} from './adapters/nativeCatalog';
import { LocalAdapterRegistry } from '@/features/model-foundry/adapterRegistry';
import * as canonicalCatalog from './catalog/canonicalModelCatalog';
import type { ProviderDiscoveredModel } from './adapters/types';
import {
  getDiscoveredConnectionModels,
  resetDiscoveredConnectionModelsForTests,
} from './connectionCatalog';
import {
  AI_CONNECTION_STATE_EVENT,
  markConnectionSessionChecked,
  resetConnectionSessionChecksForTests,
  writeConnectionMetadata,
  writeConnectionPickerStates,
} from './connectionState';

const { ensureExternalConnectionAutoDetection, isConnectionSessionChecked } = vi.hoisted(() => ({
  ensureExternalConnectionAutoDetection: vi.fn(async () => ({})),
  isConnectionSessionChecked: vi.fn((_connectionId?: string) => false),
}));
const { invalidatePersistentModelCache, listPersistentOpenCodeModels } = vi.hoisted(() => ({
  invalidatePersistentModelCache: vi.fn(),
  listPersistentOpenCodeModels: vi.fn(async (): Promise<readonly ProviderDiscoveredModel[]> => []),
}));
const { invalidatePersistentCodexModelCache, listPersistentCodexModels } = vi.hoisted(() => ({
  invalidatePersistentCodexModelCache: vi.fn(),
  listPersistentCodexModels: vi.fn(async (): Promise<readonly ProviderDiscoveredModel[]> => []),
}));
const { refreshConnectedProviderModelsMock } = vi.hoisted(() => ({
  refreshConnectedProviderModelsMock: vi.fn(async () => []),
}));
const runtimeManagerHarness = vi.hoisted(() => {
  let snapshot: { kind: string; source?: string; version?: string } = { kind: 'checking' };
  let connection: { version: string; source: 'system' | 'managed'; generation: string } | undefined;
  const listeners = new Set<() => void>();
  return {
    manager: {
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      getSnapshot: vi.fn(() => snapshot),
      getConnection: vi.fn(() => connection),
    },
    reset() {
      snapshot = { kind: 'checking' };
      connection = undefined;
      listeners.clear();
    },
    emit(
      nextSnapshot: { kind: string; source?: string; version?: string },
      nextConnection?: { version: string; source: 'system' | 'managed'; generation: string },
    ) {
      snapshot = nextSnapshot;
      connection = nextConnection;
      listeners.forEach((listener) => listener());
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

vi.mock('./adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection,
}));

vi.mock('./connectionState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connectionState')>()),
  isConnectionSessionChecked,
}));

vi.mock('./adapters/opencodePersistent', () => ({
  invalidateOpenCodePersistentModelCache: invalidatePersistentModelCache,
  openCodePersistentAdapter: {
    listModels: listPersistentOpenCodeModels,
  },
}));

vi.mock('./adapters/codexPersistent', () => ({
  invalidateCodexPersistentModelCache: invalidatePersistentCodexModelCache,
  codexPersistentAdapter: { listModels: listPersistentCodexModels },
}));

vi.mock('./providerModelCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerModelCatalog')>()),
  refreshConnectedProviderModels: refreshConnectedProviderModelsMock,
}));

vi.mock('@/lib/harness/runtimeManager', () => ({
  harnessRuntimeManager: runtimeManagerHarness.manager,
}));

describe('useAccessibleChatModels', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE);
    resetConnectionSessionChecksForTests();
    ensureExternalConnectionAutoDetection.mockClear();
    isConnectionSessionChecked.mockReset();
    isConnectionSessionChecked.mockReturnValue(false);
    listPersistentOpenCodeModels.mockReset();
    listPersistentOpenCodeModels.mockResolvedValue([]);
    listPersistentCodexModels.mockReset();
    listPersistentCodexModels.mockResolvedValue([]);
    invalidatePersistentCodexModelCache.mockClear();
    resetDiscoveredConnectionModelsForTests();
    refreshConnectedProviderModelsMock.mockClear();
    refreshConnectedProviderModelsMock.mockResolvedValue([]);
    runtimeManagerHarness.reset();
    runtimeManagerHarness.manager.subscribe.mockClear();
    requestOpenCodeModelCatalogRefresh();
    invalidatePersistentModelCache.mockClear();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({ defaultLocalModel: '', apiKeys: {}, offlineMode: false, plan: 'free' });
  });

  it('retries connection detection once when a cold runtime becomes ready', () => {
    const hook = renderHook(() => useAccessibleChatModels());
    ensureExternalConnectionAutoDetection.mockClear();
    const connection = { version: '1.18.29', source: 'system' as const, generation: 'cold-ready' };
    act(() => {
      runtimeManagerHarness.emit({ kind: 'ready' }, connection);
      runtimeManagerHarness.emit({ kind: 'ready' }, connection);
    });
    expect(ensureExternalConnectionAutoDetection).toHaveBeenCalledExactlyOnceWith({ force: true });
    hook.unmount();
  });

  it('does not rescan connections on a ready transition while offline', () => {
    useAuthStore.setState({ offlineMode: true });
    const hook = renderHook(() => useAccessibleChatModels());
    ensureExternalConnectionAutoDetection.mockClear();
    act(() =>
      runtimeManagerHarness.emit(
        { kind: 'ready' },
        {
          version: '1.18.29',
          source: 'system',
          generation: 'offline-ready',
        },
      ),
    );
    expect(ensureExternalConnectionAutoDetection).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('includes discovered Ollama models in picker groups', () => {
    syncDiscoveredOllamaModels(['qwen3:4b']);

    const groups = buildModelPickerGroups({
      apiKeys: {},
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: 'qwen3:4b',
    });

    expect(groups.some((group) => group.provider === 'ollama')).toBe(true);
    expect(groups.find((group) => group.provider === 'ollama')?.options).toEqual([
      expect.objectContaining({ modelId: 'qwen3:4b', label: 'qwen3:4b' }),
    ]);
  });

  it('shows one logical GPT-5.6 row while preserving both exact live alias routes', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENAI_API_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        [OPENAI_API_CONNECTION.id]: [
          { id: 'gpt-5.6', label: 'GPT-5.6', source: 'provider-live' },
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', source: 'provider-live' },
        ],
      },
      stateByConnection: {
        [OPENAI_API_CONNECTION.id]: { available: true, auth: 'authenticated' },
      },
      credentialSavedByProvider: { openai: true },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.options).toHaveLength(1);
    expect(groups[0]?.options[0]?.alternativeRoutes?.map((route) => route.modelId)).toEqual([
      'gpt-5.6',
      'gpt-5.6-sol',
    ]);
  });

  it('filters merged OpenAI routes to the chat backend without renaming the connection', () => {
    const groups = buildConnectionPickerGroups({
      connections: [CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        [CODEX_CLI_CONNECTION.id]: [
          { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', source: 'provider-live' },
        ],
        [OPENCODE_CLI_CONNECTION.id]: [
          { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', source: 'opencode-live' },
        ],
      },
      stateByConnection: {
        [CODEX_CLI_CONNECTION.id]: { available: true, auth: 'authenticated' },
        [OPENCODE_CLI_CONNECTION.id]: { available: true, auth: 'authenticated' },
      },
    });

    const merged = groups.find((group) => group.id === 'provider:openai');
    const mergedRoutes = merged?.options.flatMap((option) => option.alternativeRoutes ?? [option]);
    expect(mergedRoutes?.map((route) => route.connectionId)).toEqual(
      expect.arrayContaining([CODEX_CLI_CONNECTION.id, OPENCODE_CLI_CONNECTION.id]),
    );

    const codexGroups = filterModelPickerGroupsForBackend(groups, 'codex');
    const codexRoutes = codexGroups.flatMap((group) =>
      group.options.flatMap((option) => option.alternativeRoutes ?? [option]),
    );
    expect(codexRoutes.map((route) => route.connectionId)).toEqual(
      expect.arrayContaining([CODEX_CLI_CONNECTION.id, OPENCODE_CLI_CONNECTION.id]),
    );
    expect(codexRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'gpt-5.6-luna',
          connectionId: CODEX_CLI_CONNECTION.id,
        }),
        expect.objectContaining({
          modelId: 'openai/gpt-5.6-luna',
          connectionId: OPENCODE_CLI_CONNECTION.id,
        }),
      ]),
    );

    const openCodeGroups = filterModelPickerGroupsForBackend(groups, 'opencode');
    const openCodeRoutes = openCodeGroups.flatMap((group) =>
      group.options.flatMap((option) => option.alternativeRoutes ?? [option]),
    );
    expect(openCodeRoutes.map((route) => route.connectionId)).toEqual([OPENCODE_CLI_CONNECTION.id]);
    expect(openCodeRoutes[0]).toMatchObject({
      modelId: 'openai/gpt-5.6-luna',
      connectionId: OPENCODE_CLI_CONNECTION.id,
    });
    expect(openCodeRoutes[0]?.modeLabel).toBe('OpenAI provider connection');
    expect(
      isModelPickerRouteCompatibleWithBackend(
        { connectionId: CODEX_CLI_CONNECTION.id },
        'opencode',
      ),
    ).toBe(false);
    expect(
      isModelPickerRouteCompatibleWithBackend(
        { connectionId: OPENROUTER_API_CONNECTION.id },
        'codex',
      ),
    ).toBe(false);
  });

  it('makes the native Codex route the primary visible row when merged OpenCode discovery came first', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION, CODEX_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        [OPENCODE_CLI_CONNECTION.id]: [
          { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', source: 'opencode-live' },
        ],
        [CODEX_CLI_CONNECTION.id]: [
          { id: 'gpt-6-luna', label: 'GPT-6 Luna', source: 'provider-live' },
        ],
      },
      stateByConnection: {
        [OPENCODE_CLI_CONNECTION.id]: { available: true, auth: 'authenticated' },
        [CODEX_CLI_CONNECTION.id]: { available: true, auth: 'authenticated' },
      },
    });

    const codexOpenAi = filterModelPickerGroupsForBackend(groups, 'codex').find(
      (group) => group.id === 'provider:openai',
    );
    expect(codexOpenAi?.options[0]).toMatchObject({
      id: 'openai-codex:gpt-6-luna',
      modelId: 'gpt-6-luna',
      connectionId: CODEX_CLI_CONNECTION.id,
    });
    expect(codexOpenAi?.options[0]?.alternativeRoutes?.map((route) => route.connectionId)).toEqual([
      CODEX_CLI_CONNECTION.id,
      OPENCODE_CLI_CONNECTION.id,
    ]);

    const openCodeOpenAi = filterModelPickerGroupsForBackend(groups, 'opencode').find(
      (group) => group.id === 'provider:openai',
    );
    expect(openCodeOpenAi?.options[0]).toMatchObject({
      id: 'opencode-cli:openai/gpt-6-luna',
      connectionId: OPENCODE_CLI_CONNECTION.id,
    });
  });

  it('maps a stale exact Codex selection to the qualified live OpenCode route', () => {
    const options: ModelPickerOption[] = [
      {
        id: 'openai-codex:gpt-5.6-luna',
        provider: 'openai',
        modelId: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        connectionId: CODEX_CLI_CONNECTION.id,
        connection: CODEX_CLI_CONNECTION,
        available: true,
        catalogSource: 'provider-live' as const,
      },
      {
        id: 'opencode-cli:openai/gpt-5.6-luna',
        provider: OPENCODE_CLI_CONNECTION.providerId as ModelPickerOption['provider'],
        modelId: 'openai/gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        connectionId: OPENCODE_CLI_CONNECTION.id,
        connection: OPENCODE_CLI_CONNECTION,
        available: true,
        catalogSource: 'opencode-live' as const,
      },
    ];

    expect(
      findBackendModelPickerRoute(
        {
          mode: 'single',
          providerId: 'openai',
          modelId: 'gpt-5.6-luna',
          connectionId: CODEX_CLI_CONNECTION.id,
        },
        options,
        'opencode',
      ),
    ).toMatchObject({
      connectionId: OPENCODE_CLI_CONNECTION.id,
      modelId: 'openai/gpt-5.6-luna',
    });
    expect(
      findBackendModelPickerRoute(
        {
          mode: 'single',
          providerId: 'opencode',
          modelId: 'openai/gpt-5.6-luna',
          connectionId: OPENCODE_CLI_CONNECTION.id,
        },
        options,
        'opencode',
      ),
    ).toBeUndefined();
  });

  it('reconciles an OpenCode model selection to the exact Codex route when the chat runtime changes to Codex', () => {
    const options: ModelPickerOption[] = [
      {
        id: 'opencode-cli:openai/gpt-6-luna',
        provider: 'openai',
        modelId: 'openai/gpt-6-luna',
        label: 'GPT-6 Luna',
        connectionId: OPENCODE_CLI_CONNECTION.id,
        connection: OPENCODE_CLI_CONNECTION,
        available: true,
        catalogSource: 'opencode-live' as const,
      },
      {
        id: 'openai-codex:gpt-6-luna',
        provider: 'openai',
        modelId: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        connectionId: CODEX_CLI_CONNECTION.id,
        connection: CODEX_CLI_CONNECTION,
        available: true,
        catalogSource: 'provider-live' as const,
      },
    ];

    expect(
      findBackendModelPickerRoute(
        {
          mode: 'single',
          providerId: 'openai',
          modelId: 'openai/gpt-6-luna',
          connectionId: OPENCODE_CLI_CONNECTION.id,
        },
        options,
        'codex',
      ),
    ).toMatchObject({
      connectionId: CODEX_CLI_CONNECTION.id,
      modelId: 'gpt-6-luna',
    });
  });

  it('does not cross provider boundaries or choose an ambiguous same-leaf route', () => {
    const routes: ModelPickerOption[] = [
      {
        id: 'opencode-cli:openai/gpt-5.6-luna',
        provider: OPENCODE_CLI_CONNECTION.providerId as ModelPickerOption['provider'],
        modelId: 'openai/gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        connectionId: OPENCODE_CLI_CONNECTION.id,
        connection: OPENCODE_CLI_CONNECTION,
        available: true,
        catalogSource: 'opencode-live' as const,
      },
      {
        id: 'opencode-cli:anthropic/gpt-5.6-luna',
        provider: OPENCODE_CLI_CONNECTION.providerId as ModelPickerOption['provider'],
        modelId: 'anthropic/gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        connectionId: OPENCODE_CLI_CONNECTION.id,
        connection: OPENCODE_CLI_CONNECTION,
        available: true,
        catalogSource: 'opencode-live' as const,
      },
      {
        id: 'opencode-cli:openai/alias/gpt-5.6-luna',
        provider: OPENCODE_CLI_CONNECTION.providerId as ModelPickerOption['provider'],
        modelId: 'openai/alias/gpt-5.6-luna',
        label: 'GPT-5.6 Luna alias',
        connectionId: OPENCODE_CLI_CONNECTION.id,
        connection: OPENCODE_CLI_CONNECTION,
        available: true,
        catalogSource: 'opencode-live' as const,
      },
    ];

    expect(
      findBackendModelPickerRoute(
        {
          mode: 'single',
          providerId: 'google',
          modelId: 'gpt-5.6-luna',
          connectionId: CODEX_CLI_CONNECTION.id,
        },
        routes,
        'opencode',
      ),
    ).toBeUndefined();
    expect(
      findBackendModelPickerRoute(
        {
          mode: 'single',
          providerId: 'openai',
          modelId: 'gpt-5.6-luna',
          connectionId: CODEX_CLI_CONNECTION.id,
        },
        routes,
        'opencode',
      ),
    ).toBeUndefined();
  });

  it('reacts when Ollama discovery updates', () => {
    const { result, rerender } = renderHook(() => useAccessibleChatModels());
    expect(result.current.hasAny).toBe(false);

    act(() => {
      syncDiscoveredOllamaModels(['llama3.2']);
      rerender();
    });

    expect(result.current.hasAny).toBe(true);
    expect(result.current.flatOptions[0]?.modelId).toBe('llama3.2');
  });

  it('adds safely discovered OpenCode models to the exact subscription connection', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    listPersistentOpenCodeModels.mockResolvedValue([
      {
        id: 'openai/gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        variants: ['medium'],
      },
      {
        id: 'openrouter/Model v2 (beta)+preview',
        label: 'Model v2 (beta)+preview',
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);

    const { result } = renderHook(() => useAccessibleChatModels());

    await waitFor(() => {
      const openCode = result.current.flatOptions.filter(
        (option) => option.connectionId === 'opencode-cli',
      );
      expect(openCode.map((option) => option.modelId)).toEqual(
        expect.arrayContaining([
          'openai/gpt-5.3-codex-spark',
          'openrouter/Model v2 (beta)+preview',
        ]),
      );
      expect(openCode).toHaveLength(2);
      expect(
        openCode.find((option) => option.modelId === 'openai/gpt-5.3-codex-spark'),
      ).toMatchObject({
        id: 'opencode-cli:openai/gpt-5.3-codex-spark',
        available: true,
        variants: ['medium'],
      });
      expect(
        openCode.find((option) => option.modelId === 'openrouter/Model v2 (beta)+preview'),
      ).toMatchObject({ available: true, pricingStatus: 'free', isFree: true });
      expect(openCode.some((option) => option.catalogSource === 'connection-static')).toBe(false);
      expect(
        result.current.flatOptions.some((option) => option.connectionId === 'openai-codex'),
      ).toBe(false);
    });
  });

  it('builds exact live OpenCode targets and exposes only complete all-zero pricing as free', () => {
    const models = buildLiveOpenCodePickerModels(
      [
        { id: 'openai/gpt-5.3-codex-spark', label: 'Spark' },
        {
          id: 'openai/gpt-5.6-luna',
          label: 'Luna',
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: 'openai/gpt-5.6-sol',
          label: 'Sol',
          pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
        { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      ],
      123,
    );

    expect(models.map(({ id }) => id)).toEqual([
      'openai/gpt-5.3-codex-spark',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.6-sol',
      'deepseek/deepseek-v4-flash',
    ]);
    expect(models.find(({ id }) => id.endsWith('luna'))).toMatchObject({
      pricingStatus: 'free',
      isFree: true,
      available: true,
      source: 'opencode-live',
    });
    expect(models.find(({ id }) => id.endsWith('sol'))).toMatchObject({
      pricingStatus: 'paid',
      isFree: false,
    });
    expect(models.find(({ id }) => id.endsWith('spark'))).toMatchObject({
      pricingStatus: 'unknown',
      isFree: false,
    });
  });

  it('keeps exact fast and provider routes under one live logical model row', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'opencode-cli': [
          { id: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus', source: 'opencode-live' },
          { id: 'qwen/qwen3.7-plus-fast', label: 'Qwen 3.7 Plus Fast', source: 'opencode-live' },
          {
            id: 'qwen-coding-plan/qwen3.7-plus',
            label: 'Qwen 3.7 Plus',
            source: 'opencode-live',
          },
        ],
      },
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'authenticated' },
      },
    });

    expect(groups[0]?.options).toHaveLength(1);
    expect(groups[0]?.options[0]).toMatchObject({
      modelId: 'qwen/qwen3.7-plus',
      label: 'Qwen 3.7 Plus',
      available: true,
    });
    expect(groups[0]?.options[0]?.alternativeRoutes?.map((route) => route.modelId)).toEqual([
      'qwen/qwen3.7-plus',
      'qwen-coding-plan/qwen3.7-plus',
      'qwen/qwen3.7-plus-fast',
    ]);
    expect(groups[0]?.options[0]?.alternativeRoutes?.map((route) => route.label)).toEqual([
      'Qwen 3.7 Plus · Qwen Code subscription',
      'Qwen 3.7 Plus · Qwen Code subscription',
      'Qwen 3.7 Plus Fast',
    ]);
  });

  it('keeps lone fast aliases and unrelated same-label model ids separate', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'opencode-cli': [
          { id: 'openai/example-fast', label: 'Example Fast', source: 'opencode-live' },
          { id: 'provider-a/alpha', label: 'Shared Label', source: 'opencode-live' },
          { id: 'provider-b/beta', label: 'Shared Label', source: 'opencode-live' },
        ],
      },
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'authenticated' },
      },
    });

    expect(groups.flatMap((group) => group.options).map((option) => option.modelId)).toEqual([
      'openai/example-fast',
      'provider-a/alpha',
      'provider-b/beta',
    ]);
    expect(
      groups
        .flatMap((group) => group.options)
        .every((option) => option.alternativeRoutes === undefined),
    ).toBe(true);
  });

  it('keeps OpenRouter products out of the OpenAI provider heading', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'opencode-cli': [
          { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', source: 'opencode-live' },
          { id: 'openai/gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast', source: 'opencode-live' },
          {
            id: 'openrouter/openai/gpt-5.6-sol',
            label: 'OpenRouter Sol Alias',
            source: 'opencode-live',
          },
          {
            id: 'unknown/openai/gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            source: 'opencode-live',
          },
        ],
      },
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'authenticated' },
      },
    });

    const subscription = groups.find((group) => group.id === 'provider:openai');
    expect(subscription?.options).toHaveLength(1);
    expect(subscription?.options[0]?.alternativeRoutes?.map((route) => route.modelId)).toEqual([
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-sol-fast',
    ]);
    expect(groups.find((group) => group.id === 'opencode:openrouter')?.options).toEqual([
      expect.objectContaining({ modelId: 'openrouter/openai/gpt-5.6-sol' }),
    ]);
    const unknownRoutes = groups.find((group) => group.id === 'opencode:unknown')?.options;
    expect(unknownRoutes).toEqual([
      expect.objectContaining({ modelId: 'unknown/openai/gpt-5.6-sol' }),
    ]);
    expect(unknownRoutes?.[0]?.alternativeRoutes).toBeUndefined();
  });

  it('keeps distinct OpenRouter upstream products separate while collapsing fast aliases', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'opencode-cli': [
          { id: 'openrouter/openai/foo', label: 'Foo', source: 'opencode-live' },
          { id: 'openrouter/openai/foo-fast', label: 'Foo Fast', source: 'opencode-live' },
          { id: 'openrouter/anthropic/foo', label: 'Foo', source: 'opencode-live' },
        ],
      },
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'authenticated' },
      },
    });

    const openRouter = groups.find((group) => group.id === 'opencode:openrouter');
    expect(openRouter?.options).toHaveLength(2);
    expect(
      openRouter?.options
        .map((option) => (option.alternativeRoutes ?? [option]).map((route) => route.modelId))
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual([
      ['openrouter/anthropic/foo'],
      ['openrouter/openai/foo', 'openrouter/openai/foo-fast'],
    ]);
  });

  it('shows each live OpenAI subscription model once without unverified API or fast-alias leakage', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    listPersistentOpenCodeModels.mockResolvedValue([
      {
        id: 'openai/gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        variants: ['medium'],
      },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openai/gpt-5.4-fast', label: 'GPT-5.4 Fast' },
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'openai/gpt-5.4-mini-fast', label: 'GPT-5.4 Mini Fast' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { id: 'openai/gpt-5.5-fast', label: 'GPT-5.5 Fast' },
      { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'openai/gpt-5.6-luna-fast', label: 'GPT-5.6 Luna Fast' },
      { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'openai/gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast' },
      { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'openai/gpt-5.6-terra-fast', label: 'GPT-5.6 Terra Fast' },
      { id: 'openrouter/openai/gpt-5.6-sol', label: 'OpenRouter Sol Alias' },
      { id: 'openrouter/openai/gpt-5.1', label: 'GPT-5.1' },
      { id: 'qwen/qwen3.7-plus', label: 'Qwen 3.7 Plus' },
      { id: 'qwen-coding-plan/qwen3.7-plus', label: 'Qwen 3.7 Plus' },
    ]);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);
    useAuthStore.setState({ apiKeys: { openai: 'test-key' } });

    const { result } = renderHook(() => useAccessibleChatModels());

    await waitFor(() => {
      const subscription =
        result.current.groups.find((group) => group.id === 'provider:openai')?.options ?? [];
      expect(result.current.groups.find((group) => group.id === 'provider:openai')?.label).toBe(
        'OpenAI',
      );
      expect(subscription.map((option) => option.modelId)).toEqual([
        'openai/gpt-5.3-codex-spark',
        'openai/gpt-5.4',
        'openai/gpt-5.4-mini',
        'openai/gpt-5.5',
        'openai/gpt-5.6-luna',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-terra',
      ]);
      expect(new Set(subscription.map((option) => option.modelId)).size).toBe(subscription.length);
      expect(subscription.some((option) => option.modelId.endsWith('-fast'))).toBe(false);
      expect(
        subscription
          .flatMap((option) => option.alternativeRoutes ?? [option])
          .map((option) => option.modelId),
      ).toEqual([
        'openai/gpt-5.3-codex-spark',
        'openai/gpt-5.4',
        'openai/gpt-5.4-fast',
        'openai/gpt-5.4-mini',
        'openai/gpt-5.4-mini-fast',
        'openai/gpt-5.5',
        'openai/gpt-5.5-fast',
        'openai/gpt-5.6-luna',
        'openai/gpt-5.6-luna-fast',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-sol-fast',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-terra-fast',
      ]);
      const exactSubscriptionRoutes = result.current.flatOptions.filter(
        (option) => option.connectionId === 'opencode-cli' && option.modelId.startsWith('openai/'),
      );
      expect(exactSubscriptionRoutes).toHaveLength(13);
      expect(
        exactSubscriptionRoutes.filter((option) => option.modelId.endsWith('-fast')),
      ).toHaveLength(6);
      expect(
        result.current.flatOptions.some((option) => option.connectionId === 'openai-codex'),
      ).toBe(false);
      expect(
        result.current.flatOptions.some(
          (option) => option.connectionId === 'openai-api' && option.modelId === 'gpt-5.4-nano',
        ),
      ).toBe(false);
      expect(subscription.some((option) => option.modelId === 'gpt-5.4-nano')).toBe(false);
      expect(
        result.current.groups
          .find((group) => group.id === 'opencode:openrouter')
          ?.options.map((option) => option.modelId)
          .sort(),
      ).toEqual(['openrouter/openai/gpt-5.1', 'openrouter/openai/gpt-5.6-sol']);
      expect(result.current.groups.find((group) => group.id === 'opencode:qwen')?.options).toEqual([
        expect.objectContaining({
          modelId: 'qwen/qwen3.7-plus',
          alternativeRoutes: expect.arrayContaining([
            expect.objectContaining({ modelId: 'qwen/qwen3.7-plus' }),
            expect.objectContaining({ modelId: 'qwen-coding-plan/qwen3.7-plus' }),
          ]),
        }),
      ]);
      const openCodeRoutes = result.current.groups
        .flatMap((group) => group.options)
        .flatMap((option) => option.alternativeRoutes ?? [option])
        .filter((option) => option.connectionId === 'opencode-cli')
        .map((option) => option.modelId);
      expect([...openCodeRoutes].sort()).toEqual(
        [
          'openai/gpt-5.3-codex-spark',
          'openai/gpt-5.4',
          'openai/gpt-5.4-fast',
          'openai/gpt-5.4-mini',
          'openai/gpt-5.4-mini-fast',
          'openai/gpt-5.5',
          'openai/gpt-5.5-fast',
          'openai/gpt-5.6-luna',
          'openai/gpt-5.6-luna-fast',
          'openai/gpt-5.6-sol',
          'openai/gpt-5.6-sol-fast',
          'openai/gpt-5.6-terra',
          'openai/gpt-5.6-terra-fast',
          'openrouter/openai/gpt-5.6-sol',
          'openrouter/openai/gpt-5.1',
          'qwen/qwen3.7-plus',
          'qwen-coding-plan/qwen3.7-plus',
        ].sort(),
      );
      expect(new Set(openCodeRoutes).size).toBe(openCodeRoutes.length);
      expect(new Set(result.current.groups.map((group) => group.id)).size).toBe(
        result.current.groups.length,
      );
      expect(
        subscription
          .flatMap((option) => option.alternativeRoutes ?? [option])
          .some((option) => option.connectionId === 'openai-api'),
      ).toBe(false);
      expect(subscription.find((option) => option.modelId.endsWith('codex-spark'))).toMatchObject({
        id: 'opencode-cli:openai/gpt-5.3-codex-spark',
        provider: OPENCODE_CLI_CONNECTION.providerId as ModelPickerOption['provider'],
        variants: ['medium'],
        available: true,
      });
    });
  });

  it('does not treat a nested OpenRouter route as direct OpenAI subscription authority', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    listPersistentOpenCodeModels.mockResolvedValue([
      {
        id: 'openrouter/openai/gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
      },
    ]);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);

    const { result } = renderHook(() => useAccessibleChatModels());

    await waitFor(() => {
      expect(
        result.current.flatOptions.find(
          (option) => option.modelId === 'openrouter/openai/gpt-5.6-sol',
        ),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true });
      expect(
        result.current.flatOptions.some((option) => option.connectionId === 'openai-codex'),
      ).toBe(false);
      expect(
        result.current.groups.some((group) => group.id === 'opencode:openai-subscription'),
      ).toBe(false);
      expect(
        result.current.groups.find((group) => group.id === 'opencode:openrouter')?.options,
      ).toEqual([
        expect.objectContaining({
          modelId: 'openrouter/openai/gpt-5.6-sol',
          available: true,
        }),
      ]);
    });
  });

  it('retains the same-account last verified rows when a catalog refresh rejects', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    let rejectRefresh!: (reason: Error) => void;
    const rejectedRefresh = new Promise<readonly ProviderDiscoveredModel[]>((_, reject) => {
      rejectRefresh = reject;
    });
    listPersistentOpenCodeModels
      .mockResolvedValueOnce([{ id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }])
      .mockImplementationOnce(() => rejectedRefresh);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);

    const { result } = renderHook(() => useAccessibleChatModels());
    await waitFor(() =>
      expect(
        result.current.flatOptions.find((option) => option.modelId === 'openai/gpt-5.6-sol'),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true }),
    );

    act(() => requestOpenCodeModelCatalogRefresh());
    await waitFor(() => expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(2));
    expect(
      result.current.flatOptions.some(
        (option) =>
          option.connectionId === 'opencode-cli' && option.modelId === 'openai/gpt-5.6-sol',
      ),
    ).toBe(true);

    await act(async () => {
      rejectRefresh(new Error('catalog refresh failed'));
      await rejectedRefresh.catch(() => undefined);
    });
    await waitFor(() => {
      expect(
        result.current.flatOptions.some((option) => option.connectionId === 'openai-codex'),
      ).toBe(false);
      expect(
        result.current.flatOptions.some(
          (option) =>
            option.connectionId === 'opencode-cli' && option.modelId === 'openai/gpt-5.6-sol',
        ),
      ).toBe(true);
    });

    act(() => {
      isConnectionSessionChecked.mockReturnValue(false);
      window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT));
    });
    await waitFor(() => {
      expect(
        result.current.flatOptions.some(
          (option) =>
            option.connectionId === 'opencode-cli' && option.modelId === 'openai/gpt-5.6-sol',
        ),
      ).toBe(false);
    });
  });

  it('serializes forced OpenCode refreshes and rejects stale in-flight results', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    const stale = deferred<readonly ProviderDiscoveredModel[]>();
    const fresh = deferred<readonly ProviderDiscoveredModel[]>();
    listPersistentOpenCodeModels
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);

    const { result } = renderHook(() => useAccessibleChatModels());
    await waitFor(() => expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1));
    act(() => {
      requestOpenCodeModelCatalogRefresh();
      requestOpenCodeModelCatalogRefresh();
    });
    await act(async () => Promise.resolve());
    expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      stale.resolve([{ id: 'openai/stale-model', label: 'Stale Model' }]);
      await stale.promise;
    });
    await waitFor(() => expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(2));
    expect(
      result.current.flatOptions.some((option) => option.modelId === 'openai/stale-model'),
    ).toBe(false);

    await act(async () => {
      fresh.resolve([{ id: 'openai/fresh-model', label: 'Fresh Model' }]);
      await fresh.promise;
    });
    await waitFor(() =>
      expect(
        result.current.flatOptions.find((option) => option.modelId === 'openai/fresh-model'),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true }),
    );
  });

  it('refreshes an authenticated OpenCode catalog at five minutes, never earlier', async () => {
    vi.useFakeTimers();
    try {
      isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
      listPersistentOpenCodeModels.mockResolvedValue([
        { id: 'openai/gpt-live', label: 'GPT Live' },
      ]);
      writeConnectionMetadata({
        'opencode-cli': {
          installation: 'installed',
          auth: 'authenticated',
          lastCheckedAt: 1,
        },
      });
      markConnectionSessionChecked(['opencode-cli']);

      const { result, unmount } = renderHook(() => useAccessibleChatModels());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1);
      const initialEvidence = readOpenCodeCatalogEvidence();
      expect(initialEvidence).toMatchObject({
        schemaVersion: 1,
        connectionId: 'opencode-cli',
        authority: 'current-session-authenticated',
        sessionChecked: true,
        available: true,
        auth: 'authenticated',
        refreshReason: 'requested',
        routeCount: 1,
        refreshIntervalMs: 5 * 60 * 1000,
      });
      expect(initialEvidence?.catalogSha256).toBe(
        'acb879aa945dd363ae16f784abbe3fb7a24a7de970f9b99afd16c4ceea2fbefc',
      );
      expect(
        document.documentElement.getAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE),
      ).not.toContain('gpt-live');
      expect(
        result.current.flatOptions.filter((option) => option.connectionId === 'opencode-cli'),
      ).toEqual([expect.objectContaining({ modelId: 'openai/gpt-live', available: true })]);
      await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1));
      expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1);
      expect(readOpenCodeCatalogEvidence()).toEqual(initialEvidence);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(2);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const scheduledEvidence = readOpenCodeCatalogEvidence();
      expect(scheduledEvidence).toMatchObject({
        schemaVersion: 1,
        connectionId: 'opencode-cli',
        authority: 'current-session-authenticated',
        refreshReason: 'scheduled',
        routeCount: 1,
        refreshIntervalMs: 5 * 60 * 1000,
        previousVerifiedAt: initialEvidence?.lastVerifiedAt,
        elapsedSincePreviousVerifiedMs: 5 * 60 * 1000,
        catalogSha256: initialEvidence?.catalogSha256,
      });
      expect(Number(scheduledEvidence?.lastVerifiedAt)).toBeGreaterThan(
        Number(initialEvidence?.lastVerifiedAt),
      );
      expect(
        result.current.flatOptions.filter((option) => option.connectionId === 'opencode-cli'),
      ).toEqual([expect.objectContaining({ modelId: 'openai/gpt-live', available: true })]);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed and automatically revalidates the exact catalog after runtime replacement', async () => {
    let now = Date.now() + 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
      listPersistentOpenCodeModels.mockResolvedValue([
        { id: 'opencode-go/deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision Exp' },
      ]);
      writeConnectionMetadata({
        'opencode-cli': {
          installation: 'installed',
          auth: 'authenticated',
          lastCheckedAt: 1,
        },
      });
      markConnectionSessionChecked(['opencode-cli']);
      runtimeManagerHarness.emit(
        { kind: 'ready', source: 'system', version: '1.18.23' },
        {
          version: '1.18.23',
          source: 'system',
          generation: 'opencode-server-before-reconnect',
        },
      );

      const first = renderHook(() => useAccessibleChatModels());
      const second = renderHook(() => useAccessibleChatModels());
      await waitFor(() => expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(readOpenCodeCatalogEvidence()).toBeDefined());
      expect(runtimeManagerHarness.manager.subscribe).toHaveBeenCalledTimes(1);
      const before = readOpenCodeCatalogEvidence();
      expect(before).toMatchObject({ routeCount: 1 });
      expect(
        first.result.current.flatOptions.find(
          (option) => option.modelId === 'opencode-go/deepseek-v4-flash-vision-exp',
        ),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true });

      act(() => {
        runtimeManagerHarness.emit({
          kind: 'failed',
        });
      });
      expect(readOpenCodeCatalogEvidence()).toBeUndefined();
      expect(
        first.result.current.flatOptions.some((option) => option.connectionId === 'opencode-cli'),
      ).toBe(false);
      expect(
        second.result.current.flatOptions.some((option) => option.connectionId === 'opencode-cli'),
      ).toBe(false);

      now += 1_000;
      act(() => {
        runtimeManagerHarness.emit({ kind: 'starting' });
        runtimeManagerHarness.emit(
          { kind: 'ready', source: 'system', version: '1.18.23' },
          {
            version: '1.18.23',
            source: 'system',
            generation: 'opencode-server-after-reconnect',
          },
        );
      });
      await waitFor(() => expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(readOpenCodeCatalogEvidence()).toBeDefined());

      const after = readOpenCodeCatalogEvidence();
      expect(after).toMatchObject({
        refreshReason: 'authority-changed',
        routeCount: 1,
        catalogSha256: before?.catalogSha256,
      });
      expect(Number(after?.lastVerifiedAt)).toBeGreaterThan(Number(before?.lastVerifiedAt));
      expect(
        first.result.current.flatOptions.find(
          (option) => option.modelId === 'opencode-go/deepseek-v4-flash-vision-exp',
        ),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true });
      expect(
        second.result.current.flatOptions.find(
          (option) => option.modelId === 'opencode-go/deepseek-v4-flash-vision-exp',
        ),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true });
      first.unmount();
      second.unmount();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('retries an authenticated empty OpenCode catalog on the short failure interval', async () => {
    vi.useFakeTimers();
    try {
      isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
      listPersistentOpenCodeModels
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'opencode-go/deepseek-live', label: 'DeepSeek Live' }]);
      writeConnectionMetadata({
        'opencode-cli': {
          installation: 'installed',
          auth: 'authenticated',
          lastCheckedAt: 1,
        },
      });
      markConnectionSessionChecked(['opencode-cli']);

      const { result, unmount } = renderHook(() => useAccessibleChatModels());
      await act(async () => Promise.resolve());
      expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(15_000));

      expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(2);
      await act(async () => Promise.resolve());
      expect(
        result.current.flatOptions.find((option) => option.modelId === 'opencode-go/deepseek-live'),
      ).toMatchObject({ connectionId: 'opencode-cli', available: true });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the lightweight connected-provider refresh immediately and every five minutes', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useAccessibleChatModels());
      await act(async () => Promise.resolve());
      expect(refreshConnectedProviderModelsMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1));
      expect(refreshConnectedProviderModelsMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(refreshConnectedProviderModelsMock).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not probe OpenCode models until current-session authentication is verified', async () => {
    document.documentElement.setAttribute(
      OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE,
      JSON.stringify({ connectionId: 'opencode-cli', stale: true }),
    );
    listPersistentOpenCodeModels.mockResolvedValue([
      { id: 'openai/should-not-be-executable', label: 'Should Not Be Executable' },
    ]);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    isConnectionSessionChecked.mockReturnValue(false);

    const { result } = renderHook(() => useAccessibleChatModels());

    await act(async () => Promise.resolve());
    expect(listPersistentOpenCodeModels).not.toHaveBeenCalled();
    expect(
      result.current.flatOptions.some((option) => option.connectionId === 'opencode-cli'),
    ).toBe(false);
    expect(readOpenCodeCatalogEvidence()).toBeUndefined();
    expect(document.documentElement.getAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE)).toBeNull();
  });

  it('refreshes the live Codex catalog every five minutes and immediately on connection changes', async () => {
    vi.useFakeTimers();
    try {
      isConnectionSessionChecked.mockImplementation((id) => id === 'openai-codex');
      listPersistentCodexModels.mockResolvedValue([
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', variants: ['low', 'high'] },
      ]);
      writeConnectionMetadata({
        'openai-codex': { installation: 'installed', auth: 'authenticated', lastCheckedAt: 1 },
      });
      const { unmount } = renderHook(() => useAccessibleChatModels());
      await act(async () => Promise.resolve());
      expect(listPersistentCodexModels).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1));
      expect(listPersistentCodexModels).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(listPersistentCodexModels).toHaveBeenCalledTimes(2);
      await act(async () => window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT)));
      expect(listPersistentCodexModels).toHaveBeenCalledTimes(3);
      expect(invalidatePersistentCodexModelCache).toHaveBeenCalled();
      unmount();
      await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
      expect(listPersistentCodexModels).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers exact authenticated Codex models for the openai-codex connection', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'openai-codex');
    listPersistentCodexModels.mockResolvedValue([
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        variants: ['low', 'high'],
        defaultReasoningEffort: 'low',
      },
    ]);
    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });

    const { result } = renderHook(() => useAccessibleChatModels());

    await waitFor(() => {
      expect(listPersistentCodexModels).toHaveBeenCalledOnce();
      expect(getDiscoveredConnectionModels('openai-codex')).toEqual([
        expect.objectContaining({ defaultReasoningEffort: 'low' }),
      ]);
      const routes = result.current.flatOptions.flatMap(
        (option) => option.alternativeRoutes ?? [option],
      );
      expect(routes).toEqual([
        expect.objectContaining({
          connectionId: 'openai-codex',
          modelId: 'gpt-5.6-luna',
          available: true,
          variants: ['low', 'high'],
          catalogSource: 'provider-live',
        }),
      ]);
    });
  });

  it('awaits live chat discovery and publishes both authenticated CLI catalogs before refresh resolves', async () => {
    isConnectionSessionChecked.mockImplementation(
      (id) => id === 'openai-codex' || id === 'opencode-cli',
    );
    listPersistentCodexModels.mockResolvedValue([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', variants: ['low'] },
    ]);
    listPersistentOpenCodeModels.mockResolvedValue([
      { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', variants: ['low'] },
    ]);
    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);
    runtimeManagerHarness.emit(
      { kind: 'ready', source: 'system', version: '1.18.23' },
      { version: '1.18.23', source: 'system', generation: 'refresh-live-cli-catalogs' },
    );

    const { result, unmount } = renderHook(() => useAccessibleChatModels());
    await waitFor(() => {
      expect(listPersistentCodexModels).toHaveBeenCalledOnce();
      expect(listPersistentOpenCodeModels).toHaveBeenCalledOnce();
    });

    listPersistentCodexModels.mockResolvedValue([
      { id: 'gpt-5.6-luna-refreshed', label: 'GPT-5.6 Luna Refreshed', variants: ['high'] },
    ]);
    listPersistentOpenCodeModels.mockResolvedValue([
      { id: 'openai/gpt-5.6-sol-refreshed', label: 'GPT-5.6 Sol Refreshed', variants: ['medium'] },
    ]);

    await act(async () => {
      await result.current.refreshModels();
    });

    expect(listPersistentCodexModels).toHaveBeenCalledTimes(2);
    expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(2);
    expect(getDiscoveredConnectionModels('openai-codex')).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-luna-refreshed',
        source: 'cli_model',
        variants: ['high'],
      }),
    ]);
    expect(getDiscoveredConnectionModels('opencode-cli')).toEqual([
      expect.objectContaining({
        id: 'openai/gpt-5.6-sol-refreshed',
        source: 'opencode_refresh',
        variants: ['medium'],
      }),
    ]);
    unmount();
  });

  it('keeps a checked but unknown OpenCode session fail closed and clears stale evidence', async () => {
    document.documentElement.setAttribute(
      OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE,
      JSON.stringify({ connectionId: 'opencode-cli', stale: true }),
    );
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    writeConnectionPickerStates({
      'opencode-cli': { available: true, auth: 'unknown' },
    });

    const { result } = renderHook(() => useAccessibleChatModels());

    await act(async () => Promise.resolve());
    expect(listPersistentOpenCodeModels).not.toHaveBeenCalled();
    expect(
      result.current.flatOptions.some((option) => option.connectionId === 'opencode-cli'),
    ).toBe(false);
    expect(readOpenCodeCatalogEvidence()).toBeUndefined();
    expect(document.documentElement.getAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE)).toBeNull();
  });

  it('does not repeat OpenCode discovery for unrelated connection events', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    listPersistentOpenCodeModels.mockResolvedValue([{ id: 'openai/gpt-5', label: 'GPT-5' }]);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);
    renderHook(() => useAccessibleChatModels());
    await waitFor(() => expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT)));
    await act(async () => Promise.resolve());
    expect(listPersistentOpenCodeModels).toHaveBeenCalledTimes(1);
  });

  it('invalidates both picker and persistent catalogs when OpenCode auth truth changes', () => {
    renderHook(() => useAccessibleChatModels());
    invalidatePersistentModelCache.mockClear();

    isConnectionSessionChecked.mockReturnValue(true);
    act(() => {
      writeConnectionPickerStates({
        'opencode-cli': { available: true, auth: 'authenticated' },
      });
      window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT));
    });

    expect(invalidatePersistentModelCache).toHaveBeenCalledOnce();
  });

  it('removes every cloud and external connection from Fully Local Chat', () => {
    syncDiscoveredOllamaModels(['qwen3.5:4b']);
    writeConnectionPickerStates({
      'openai-api': { available: true, auth: 'authenticated' },
    });
    useAuthStore.setState({
      offlineMode: true,
      defaultLocalModel: 'qwen3.5:4b',
      apiKeys: { openai: 'test-key' },
    });

    const { result } = renderHook(() => useAccessibleChatModels());

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0]?.options).toEqual([
      expect.objectContaining({
        provider: 'ollama',
        modelId: 'qwen3.5:4b',
        connectionId: 'ollama-local',
      }),
    ]);
  });

  it('presents OpenAI API and Codex subscription under one OpenAI heading', () => {
    const groups = buildConnectionPickerGroups({
      connections: [CODEX_CLI_CONNECTION, OPENAI_API_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'openai-codex': [{ id: 'gpt-5', label: 'GPT-5', source: 'provider-live' }],
        'openai-api': [{ id: 'gpt-5', label: 'GPT-5', source: 'provider-live' }],
      },
      stateByConnection: {
        'openai-codex': { available: true, auth: 'authenticated' },
        'openai-api': { available: true, auth: 'authenticated' },
      },
      credentialSavedByProvider: { openai: true },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'provider:openai', provider: 'openai', label: 'OpenAI' });
    expect(groups[0]?.options).toHaveLength(1);
    expect(groups[0]?.options[0]?.alternativeRoutes).toEqual([
      expect.objectContaining({
        connectionId: 'openai-codex',
        modeLabel: 'Codex / ChatGPT subscription',
      }),
      expect.objectContaining({ connectionId: 'openai-api', modeLabel: 'OpenAI API' }),
    ]);
    expect(groups.flatMap((group) => group.options).map((option) => option.label)).not.toContain(
      'OpenCode',
    );
  });

  it('keeps live OpenCode rows under their exact upstream provider headings', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'opencode-cli': [
          { id: 'openai/gpt-live', label: 'GPT Live', source: 'opencode-live' },
          { id: 'azure/phi-live', label: 'Phi Live', source: 'opencode-live' },
          { id: 'moonshot/kimi-live', label: 'Kimi Live', source: 'opencode-live' },
          { id: 'alibaba/qwen-live', label: 'Qwen Live', source: 'opencode-live' },
        ],
      },
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'authenticated' },
      },
    });

    expect(groups.map((group) => group.label)).toEqual([
      'OpenAI',
      'Azure Models',
      'Moonshot Models',
      'Alibaba Models',
    ]);
    expect(groups.find((group) => group.label === 'OpenAI')?.options).toEqual([
      expect.objectContaining({
        modelId: 'openai/gpt-live',
        modeLabel: 'OpenAI provider connection',
      }),
    ]);
    expect(groups.find((group) => group.label === 'Azure Models')?.options).toEqual([
      expect.objectContaining({ modelId: 'azure/phi-live', modeLabel: 'Azure subscription' }),
    ]);
    expect(groups.find((group) => group.label === 'Moonshot Models')?.options).toEqual([
      expect.objectContaining({
        modelId: 'moonshot/kimi-live',
        modeLabel: 'Moonshot provider connection',
      }),
    ]);
    expect(groups.find((group) => group.label === 'Alibaba Models')?.options).toEqual([
      expect.objectContaining({
        modelId: 'alibaba/qwen-live',
        modeLabel: 'Alibaba provider connection',
      }),
    ]);
    expect(
      groups
        .flatMap((group) => group.options)
        .flatMap((option) => [option.label, option.modeLabel]),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining('OpenCode')]));
    expect(connectionRouteProviderLabel(OPENCODE_CLI_CONNECTION, 'alibaba/qwen-live')).toBe(
      'Alibaba',
    );
  });

  it('uses the connection-specific Codex subscription catalog instead of OpenAI API models', () => {
    const groups = buildConnectionPickerGroups({
      connections: [CODEX_CLI_CONNECTION, OPENAI_API_CONNECTION],
      modelsByProvider: {
        openai: [
          { id: 'gpt-4o', label: 'GPT-4o' },
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol API' },
        ],
      },
      modelsByConnection: CONNECTION_MODEL_OPTIONS,
      stateByConnection: {
        'openai-codex': { available: true, auth: 'authenticated' },
        'openai-api': { available: true, auth: 'authenticated' },
      },
    });
    const options = groups
      .flatMap((group) => group.options)
      .flatMap((option) => option.alternativeRoutes ?? [option]);

    expect(
      options
        .filter((option) => option.connectionId === 'openai-codex')
        .map((option) => option.modelId),
    ).toEqual((CONNECTION_MODEL_OPTIONS['openai-codex'] ?? []).map((option) => option.id));
    expect(
      options
        .filter((option) => option.connectionId === 'openai-api')
        .map((option) => option.modelId)
        .sort(),
    ).toEqual(['gpt-4o', 'gpt-5.6-sol']);
  });

  it('keeps static OpenCode fallback hints visible but non-executable', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: CONNECTION_MODEL_OPTIONS,
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'authenticated' },
      },
    });
    const ids = groups.flatMap((group) => group.options).map((option) => option.modelId);
    expect(ids).toEqual(['deepseek/deepseek-v4-flash', 'qwen/qwen3.8-max']);
    expect(groups.map((group) => group.label)).toEqual(['DeepSeek Models', 'Qwen Models']);
    expect(
      groups.flatMap((group) => group.options).every((option) => option.available === false),
    ).toBe(true);
  });

  it('never enables unknown Codex subscription authentication', () => {
    const groups = buildConnectionPickerGroups({
      connections: [CODEX_CLI_CONNECTION],
      modelsByProvider: { openai: [{ id: 'gpt-4o', label: 'GPT-4o' }] },
      modelsByConnection: CONNECTION_MODEL_OPTIONS,
      stateByConnection: {
        'openai-codex': { available: true, auth: 'unknown' },
      },
    });

    expect(groups[0]?.options.every((option) => option.available === false)).toBe(true);
    expect(
      groups[0]?.options.every((option) => option.authLabel === 'Authentication unknown'),
    ).toBe(true);
  });

  it('never enables unknown OpenCode subscription authentication', () => {
    const groups = buildConnectionPickerGroups({
      connections: [OPENCODE_CLI_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'opencode-cli': [{ id: 'openai/gpt-5', label: 'openai/gpt-5' }],
      },
      stateByConnection: {
        'opencode-cli': { available: true, auth: 'unknown' },
      },
    });

    expect(groups[0]?.options).toEqual([
      expect.objectContaining({ available: false, authLabel: 'Authentication unknown' }),
    ]);
  });

  it('omits stale external fallback rows until a live authenticated catalog exists', async () => {
    writeConnectionPickerStates({
      'openai-codex': { available: true, auth: 'authenticated' },
    });

    const { result } = renderHook(() => useAccessibleChatModels());

    await waitFor(() => {
      expect(ensureExternalConnectionAutoDetection).toHaveBeenCalledOnce();
    });
    expect(result.current.flatOptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: 'openai-codex' }),
        expect.objectContaining({ connectionId: 'opencode-cli' }),
      ]),
    );

    isConnectionSessionChecked.mockReturnValue(true);
    act(() => {
      writeConnectionMetadata({
        'openai-codex': {
          installation: 'installed',
          auth: 'authenticated',
        },
      });
    });
    expect(result.current.flatOptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: 'openai-codex' }),
        expect.objectContaining({ connectionId: 'opencode-cli' }),
      ]),
    );
  });

  it('never marks a native API connection ready without a saved credential', () => {
    const groups = buildConnectionPickerGroups({
      connections: [QWEN_API_CONNECTION],
      modelsByProvider: { qwen: [{ id: 'qwen3.7-plus', label: 'Qwen 3.7 Plus' }] },
      stateByConnection: {
        'qwen-api': { available: true, auth: 'authenticated' },
      },
      credentialSavedByProvider: { qwen: false },
    });

    expect(groups[0]?.options[0]).toMatchObject({
      available: false,
      authLabel: 'Sign in required',
    });
  });

  it('surfaces an exact discovered OpenCode OpenAI model on the subscription connection', () => {
    const groups = buildConnectionPickerGroups({
      connections: [CODEX_CLI_CONNECTION],
      modelsByProvider: { openai: [{ id: 'gpt-4o', label: 'GPT-4o' }] },
      modelsByConnection: {
        'openai-codex': [{ id: 'gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark' }],
      },
      stateByConnection: {
        'openai-codex': { available: true, auth: 'authenticated' },
      },
    });

    expect(groups[0]?.options.map((option) => option.modelId)).toEqual(['gpt-5.3-codex-spark']);
  });
});

describe('useAccessibleChatModels foundry adapter injection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetConnectionSessionChecksForTests();
    isConnectionSessionChecked.mockReset();
    isConnectionSessionChecked.mockReturnValue(false);
    listPersistentOpenCodeModels.mockReset();
    listPersistentOpenCodeModels.mockResolvedValue([]);
    syncFoundryModelOptions([]);
  });

  it('discovers the native N13 artifact and preserves its local route under both chat engines', async () => {
    window.localStorage.setItem(
      'vibespace.model-foundry.jobs.v2',
      JSON.stringify([
        {
          id: 'job_0-vjmMedLqAeGX',
          name: 'N13 smoke test',
          method: 'full',
          status: 'completed',
          artifactVerified: true,
          artifactPath: 'D:/private/weight-artifact',
          baseModelId: 'smollm2-135m-instruct',
        },
      ]),
    );
    syncFoundryModelOptions([{ id: 'artifact--job_0-vjmMedLqAeGX', label: 'N13 smoke test' }]);
    const { result } = renderHook(() => useAccessibleChatModels());
    await waitFor(() => {
      const foundry = result.current.groups.find((group) => group.provider === 'foundry');
      expect(foundry?.options.map((option) => option.modelId)).toContain(
        'artifact--job_0-vjmMedLqAeGX',
      );
    });
    for (const backend of ['codex', 'opencode'] as const) {
      const groups = filterModelPickerGroupsForBackend(result.current.groups, backend);
      const model = groups.find((group) => group.provider === 'foundry')?.options[0];
      expect(model?.provider).toBe('foundry');
      expect(model?.connectionId).toBe('foundry-local');
      expect(model?.connection).toMatchObject({
        id: 'foundry-local',
        providerId: 'foundry',
        mode: 'local',
      });
      expect(model?.modelId).toBe('artifact--job_0-vjmMedLqAeGX');
      expect(
        findBackendModelPickerRoute(
          { mode: 'single', providerId: 'foundry', modelId: model?.modelId },
          groups.flatMap((group) => group.options),
          backend,
        ),
      ).toMatchObject({ connectionId: 'foundry-local', modelId: 'artifact--job_0-vjmMedLqAeGX' });
    }
  });

  function seedAdapter(args: { promote: boolean; gate?: 'pass' | 'blocked' }): void {
    // LocalAdapterRegistry writes through the same storage authority used by
    // the Foundry Studio, so the picker sees exactly what the studio records.
    const registry = new LocalAdapterRegistry(
      window.localStorage,
      () => '2026-08-16T00:00:00.000Z',
    );
    const artifact = {
      projectId: 'project-alpha',
      jobId: 'job_beta',
      manifestSha256: 'a'.repeat(64),
      adapterFiles: { 'adapter.safetensors': 'private' },
      metrics: {},
      trainingConfig: {},
    };
    registry.upsert('project-alpha', 'job_beta', artifact, 'Support classifier');
    registry.recordEvaluation('project-alpha', 'job_beta', 'a'.repeat(64), {
      // Synthetic comparative fixture only; no native evaluation is claimed.
      suite: 'pinned-validation-reference-v1',
      caseCount: 1,
      baseScore: 0.25,
      candidateScore: 0.75,
      championScore: null,
      delta: 0.5,
      safetyFailures: [],
      gate: args.gate ?? 'pass',
      caseEvidence: [{ caseId: 'synthetic-comparison', baseScore: 0.25, candidateScore: 0.75, championScore: null, evidenceHash: 'c'.repeat(64) }],
    });
    if (args.promote && (args.gate ?? 'pass') === 'pass') {
      registry.promote('project-alpha', 'job_beta');
    }
  }

  it('surfaces promoted foundry adapters as a bounded local picker group', async () => {
    seedAdapter({ promote: true });
    const { result } = renderHook(() => useAccessibleChatModels());
    await waitFor(() => {
      const foundry = result.current.groups.find((group) => group.provider === 'foundry');
      expect(foundry).toBeTruthy();
      expect(foundry?.options.map((option) => option.modelId)).toEqual(['project-alpha--job_beta']);
      expect(foundry?.options[0]?.id).toBe('foundry:project-alpha--job_beta');
      expect(foundry?.options[0]?.available).toBe(true);
    });
  });

  it('fails closed when the adapter has not passed a current evaluation', async () => {
    seedAdapter({ promote: false, gate: 'blocked' });
    const { result } = renderHook(() => useAccessibleChatModels());
    // Give the memo a beat to settle with the blocked registry state.
    await act(async () => undefined);
    const foundry = result.current.groups.find((group) => group.provider === 'foundry');
    expect(foundry).toBeUndefined();
  });
});

describe('linear OpenCode subscription partitioning', () => {
  it('does not rescan unrelated provider routes for each OpenAI subscription model', () => {
    const unrelated = 'other-provider/independent-model';
    const canonicalize = vi.spyOn(canonicalCatalog, 'canonicalModelId');
    try {
      const countUnrelatedVisits = (seeds: number) => {
        canonicalize.mockClear();
        const models = [
          { id: unrelated, label: 'Independent model', source: 'opencode-live' as const },
          ...Array.from({ length: seeds }, (_, index) => ({
            id: `openai/model-${index}`,
            label: `Model ${index}`,
            source: 'opencode-live' as const,
          })),
        ];
        const groups = buildConnectionPickerGroups({
          connections: [OPENCODE_CLI_CONNECTION],
          modelsByProvider: {},
          modelsByConnection: { [OPENCODE_CLI_CONNECTION.id]: models },
          stateByConnection: {
            [OPENCODE_CLI_CONNECTION.id]: { available: true, auth: 'authenticated' },
          },
        });
        expect(groups.flatMap((group) => group.options)).toHaveLength(seeds + 1);
        return canonicalize.mock.calls.filter(([id]) => id === unrelated).length;
      };
      const oneSeed = countUnrelatedVisits(1);
      const manySeeds = countUnrelatedVisits(64);
      expect(oneSeed).toBeGreaterThan(0);
      expect(manySeeds).toBe(oneSeed);
    } finally {
      canonicalize.mockRestore();
    }
  });
});

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderDiscoveredModel } from '@/lib/ai/adapters/types';
import { useAuthStore } from '@/stores/auth';
import { OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { resolveVoiceProviderSelection } from '@/features/voice/voiceProviderSelection';
import {
  markConnectionSessionChecked,
  resetConnectionSessionChecksForTests,
  writeConnectionMetadata,
} from '@/lib/ai/connectionState';
import { resetDiscoveredConnectionModelsForTests } from '@/lib/ai/connectionCatalog';
import {
  OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE,
  readOpenCodeCatalogEvidence,
  requestOpenCodeModelCatalogRefresh,
  useAccessibleChatModels,
} from '@/lib/ai/useAccessibleChatModels';

const catalog = vi.hoisted(() => ({
  list: vi.fn<NonNullable<ProviderAdapter['listModels']>>(),
}));
vi.mock('@/lib/ai/adapters/opencodePersistent', () => ({
  invalidateOpenCodePersistentModelCache: vi.fn(),
  openCodePersistentAdapter: { listModels: catalog.list },
}));
vi.mock('@/lib/ai/adapters/codexPersistent', () => ({
  invalidateCodexPersistentModelCache: vi.fn(),
  codexPersistentAdapter: { listModels: vi.fn(async () => []) },
}));
vi.mock('@/lib/ai/adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection: vi.fn(async () => ({})),
}));
vi.mock('@/lib/ai/providerModelCatalog', async (load) => ({
  ...(await load<typeof import('@/lib/ai/providerModelCatalog')>()),
  refreshConnectedProviderModels: vi.fn(async () => []),
}));
vi.mock('@/lib/harness/runtimeManager', () => ({
  harnessRuntimeManager: {
    getSnapshot: () => ({ kind: 'ready', source: 'system', version: 'synthetic' }),
    getConnection: () => ({ generation: 'rdy05-owned', source: 'system', version: 'synthetic' }),
    subscribe: () => () => undefined,
  },
}));

const liveModels: readonly ProviderDiscoveredModel[] = [{ id: 'openai/gpt-6-luna', label: 'Luna' }];
const selection = selectionFromOption('openai', 'openai/gpt-6-luna', OPENCODE_CLI_CONNECTION);
function pendingCatalog() {
  let resolve!: (models: readonly ProviderDiscoveredModel[]) => void;
  const promise = new Promise<readonly ProviderDiscoveredModel[]>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function resolveHook(hook: { result: { current: ReturnType<typeof useAccessibleChatModels> } }) {
  return resolveVoiceProviderSelection({
    provider: 'opencode',
    preferredSelection: selection,
    options: hook.result.current.flatOptions,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute(OPEN_CODE_CATALOG_EVIDENCE_ATTRIBUTE);
  resetConnectionSessionChecksForTests();
  resetDiscoveredConnectionModelsForTests();
  catalog.list.mockReset();
  useAuthStore.setState({ apiKeys: {}, offlineMode: false, plan: 'free', defaultLocalModel: '' });
  requestOpenCodeModelCatalogRefresh();
  writeConnectionMetadata({
    'opencode-cli': { installation: 'installed', auth: 'authenticated', lastCheckedAt: 1 },
  });
  markConnectionSessionChecked(['opencode-cli']);
});
afterEach(() => cleanup());

describe('catalog diagnostic receipt ownership', () => {
  it('retains the surviving consumer receipt when a cancelled sibling settles later', async () => {
    const held = pendingCatalog();
    catalog.list.mockImplementation(() => held.promise);
    const survivor = renderHook(() => useAccessibleChatModels());
    const sibling = renderHook(() => useAccessibleChatModels());
    expect(catalog.list).toHaveBeenCalledTimes(1);
    sibling.unmount();
    await act(async () => {
      held.resolve(liveModels);
      await held.promise;
    });
    expect(resolveHook(survivor).selection).toMatchObject(selection);
    expect(readOpenCodeCatalogEvidence()).toMatchObject({ available: true, routeCount: 1 });
  });

  it('keeps the shared receipt when both consumers remain mounted', async () => {
    const held = pendingCatalog();
    catalog.list.mockImplementation(() => held.promise);
    const first = renderHook(() => useAccessibleChatModels());
    const second = renderHook(() => useAccessibleChatModels());
    expect(catalog.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      held.resolve(liveModels);
      await held.promise;
    });
    for (const hook of [first, second])
      expect(resolveHook(hook).selection).toMatchObject(selection);
    expect(readOpenCodeCatalogEvidence()).toMatchObject({ available: true, routeCount: 1 });
  });

  it('clears the receipt and refuses both routes after actual authentication loss', async () => {
    catalog.list.mockResolvedValue(liveModels);
    const first = renderHook(() => useAccessibleChatModels());
    const second = renderHook(() => useAccessibleChatModels());
    await act(async () => {
      await Promise.resolve();
    });
    expect(readOpenCodeCatalogEvidence()).toMatchObject({ available: true });
    await act(async () => {
      writeConnectionMetadata({
        'opencode-cli': { installation: 'installed', auth: 'unauthenticated', lastCheckedAt: 2 },
      });
    });
    for (const hook of [first, second]) expect(() => resolveHook(hook)).toThrow(/unavailable/);
    expect(readOpenCodeCatalogEvidence()).toBeUndefined();
  });
});

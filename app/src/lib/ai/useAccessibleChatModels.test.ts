import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth';
import { syncDiscoveredOllamaModels } from './models';
import {
  buildConnectionPickerGroups,
  buildModelPickerGroups,
  requestOpenCodeModelCatalogRefresh,
  useAccessibleChatModels,
} from './useAccessibleChatModels';
import {
  CODEX_CLI_CONNECTION,
  CONNECTION_MODEL_OPTIONS,
  OPENCODE_CLI_CONNECTION,
} from './adapters/catalog';
import { OPENAI_API_CONNECTION, QWEN_API_CONNECTION } from './adapters/nativeCatalog';
import { LocalAdapterRegistry } from '@/features/model-foundry/adapterRegistry';
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
const { listOpenCodeModels } = vi.hoisted(() => ({
  listOpenCodeModels: vi.fn(async () => [] as readonly { id: string; label: string }[]),
}));

vi.mock('./adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection,
}));

vi.mock('./connectionState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connectionState')>()),
  isConnectionSessionChecked,
}));

vi.mock('./adapters/opencodePersistent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters/opencodePersistent')>();
  return {
    ...actual,
    openCodePersistentAdapter: Object.freeze({
      ...actual.openCodePersistentAdapter,
      listModels: listOpenCodeModels,
    }),
  };
});

describe('useAccessibleChatModels', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetConnectionSessionChecksForTests();
    ensureExternalConnectionAutoDetection.mockClear();
    isConnectionSessionChecked.mockReset();
    isConnectionSessionChecked.mockReturnValue(false);
    listOpenCodeModels.mockReset();
    listOpenCodeModels.mockResolvedValue([]);
    requestOpenCodeModelCatalogRefresh();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({ defaultLocalModel: '', apiKeys: {}, offlineMode: false, plan: 'free' });
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
    listOpenCodeModels.mockResolvedValue([
      { id: 'openrouter/Model v2 (beta)+preview', label: 'openrouter/Model v2 (beta)+preview' },
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
        result.current.flatOptions.find((option) => option.connectionId === 'opencode-cli'),
      ).toMatchObject({
        modelId: 'openrouter/Model v2 (beta)+preview',
        available: true,
      });
    });
  });

  it('does not probe OpenCode models until current-session authentication is verified', async () => {
    isConnectionSessionChecked.mockReturnValue(false);

    renderHook(() => useAccessibleChatModels());

    await act(async () => Promise.resolve());
    expect(listOpenCodeModels).not.toHaveBeenCalled();
  });

  it('does not repeat OpenCode discovery for unrelated connection events', async () => {
    isConnectionSessionChecked.mockImplementation((id) => id === 'opencode-cli');
    listOpenCodeModels.mockResolvedValue([{ id: 'openai/gpt-5', label: 'openai/gpt-5' }]);
    writeConnectionMetadata({
      'opencode-cli': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 1,
      },
    });
    markConnectionSessionChecked(['opencode-cli']);
    renderHook(() => useAccessibleChatModels());
    await waitFor(() => expect(listOpenCodeModels).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT)));
    await act(async () => Promise.resolve());
    expect(listOpenCodeModels).toHaveBeenCalledTimes(1);
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

  it('groups exact connections by provider family with mode and availability labels', () => {
    const groups = buildConnectionPickerGroups({
      connections: [CODEX_CLI_CONNECTION, OPENAI_API_CONNECTION],
      modelsByProvider: { openai: [{ id: 'gpt-5', label: 'GPT-5' }] },
      stateByConnection: {
        'openai-codex': { available: true, auth: 'authenticated' },
        'openai-api': { available: false, auth: 'unauthenticated' },
      },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('OpenAI');
    expect(groups[0]?.options.map((option) => option.modeLabel)).toEqual([
      'Subscription bridge · External agent',
      'Native Jarvis Chat · API billed',
    ]);
    expect(groups[0]?.options[1]).toMatchObject({
      available: false,
      authLabel: 'Sign in required',
    });
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
    const options = groups[0]?.options ?? [];

    expect(
      options
        .filter((option) => option.connectionId === 'openai-codex')
        .map((option) => option.modelId),
    ).toEqual((CONNECTION_MODEL_OPTIONS['openai-codex'] ?? []).map((option) => option.id));
    expect(
      options
        .filter((option) => option.connectionId === 'openai-api')
        .map((option) => option.modelId),
    ).toEqual(['gpt-4o', 'gpt-5.6-sol']);
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

  it('does not trust persisted ChatGPT auth until this app session completes detection', async () => {
    writeConnectionPickerStates({
      'openai-codex': { available: true, auth: 'authenticated' },
    });

    const { result } = renderHook(() => useAccessibleChatModels());

    await waitFor(() => {
      expect(ensureExternalConnectionAutoDetection).toHaveBeenCalledOnce();
    });
    expect(
      result.current.flatOptions
        .filter((option) => option.connectionId === 'openai-codex')
        .every((option) => option.available === false),
    ).toBe(true);

    isConnectionSessionChecked.mockReturnValue(true);
    act(() => {
      writeConnectionMetadata({
        'openai-codex': {
          installation: 'installed',
          auth: 'authenticated',
        },
      });
    });
    const codexOptions = result.current.flatOptions.filter(
      (option) => option.connectionId === 'openai-codex',
    );
    expect(codexOptions.every((option) => option.available === true)).toBe(true);
    expect(codexOptions.map((option) => option.modelId).sort()).toEqual(
      (CONNECTION_MODEL_OPTIONS['openai-codex'] ?? [])
        .map((option) => option.id)
        .sort(),
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
    listOpenCodeModels.mockReset();
    listOpenCodeModels.mockResolvedValue([]);
  });

  function seedAdapter(args: { promote: boolean; gate?: 'pass' | 'blocked' }): void {
    // LocalAdapterRegistry writes through the same storage authority used by
    // the Foundry Studio, so the picker sees exactly what the studio records.
    const registry = new LocalAdapterRegistry(window.localStorage, () => '2026-08-16T00:00:00.000Z');
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
      suite: 'private-dataset-studio',
      caseCount: 2,
      baseScore: 0,
      candidateScore: 1,
      championScore: null,
      delta: 1,
      safetyFailures: [],
      gate: args.gate ?? 'pass',
      caseEvidence: [],
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

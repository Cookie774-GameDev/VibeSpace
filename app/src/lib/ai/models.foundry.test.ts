import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth';
import { foundryModelOptions } from '@/features/model-foundry/modelHub';
import { validateSendModelAccess } from './modelSelection';
import { optimizeKernelRuntimeContext } from './runtimeTokenOptimization';
import type { JarvisRuntimeContextBlock } from '@/lib/jarvis/runtimeContextCandidates';
import {
  getOllamaModelOptions,
  getAccessibleModelOptions,
  getAccessibleProviders,
  getFoundryModelOptions,
  syncDiscoveredOllamaModels,
  syncFoundryModelOptions,
  useFoundryModelOptions,
} from './models';

afterEach(() => {
  syncDiscoveredOllamaModels([]);
  syncFoundryModelOptions([]);
});

describe('Model Foundry chat catalog', () => {
  it('does not reuse a catalog snapshot across accounts or accept an old account refresh', () => {
    const prior = useAuthStore.getState().localUserId;
    try {
      useAuthStore.setState({ localUserId: 'test-account-a' });
      syncFoundryModelOptions([{ id: 'artifact--job_private', label: 'Local test' }]);
      useAuthStore.setState({ localUserId: 'test-account-b' });
      expect(getFoundryModelOptions()).toEqual([]);
      syncFoundryModelOptions(
        [{ id: 'artifact--job_private', label: 'Old refresh' }],
        'test-account-a',
      );
      expect(getFoundryModelOptions()).toEqual([]);
    } finally {
      useAuthStore.setState({ localUserId: prior });
    }
  });

  it('keeps knowledge artifacts on their existing retrieval route', () => {
    syncFoundryModelOptions([
      { id: 'artifact--job_knowledge', label: 'Local knowledge', method: 'knowledge' },
    ]);
    expect(getFoundryModelOptions()).toEqual([]);
    expect(getOllamaModelOptions()).toEqual([
      { provider: 'ollama', id: 'foundry:job_knowledge', label: 'Local knowledge' },
    ]);
  });

  it('keeps native trained artifacts in their own provider and preserves Ollama', () => {
    syncDiscoveredOllamaModels(['qwen3:1.7b']);
    syncFoundryModelOptions([
      { id: 'artifact--job_0-vjmMedLqAeGX', label: 'N13 smoke test' },
      { id: 'artifact--../escape', label: 'Invalid' },
      { id: 'artifact--job_0-vjmMedLqAeGX', label: 'Duplicate' },
    ]);
    expect(getFoundryModelOptions()).toEqual([
      { provider: 'foundry', id: 'artifact--job_0-vjmMedLqAeGX', label: 'N13 smoke test' },
    ]);
    expect(getOllamaModelOptions()).toEqual([
      { provider: 'ollama', id: 'qwen3:1.7b', label: 'qwen3:1.7b' },
    ]);
  });

  it('adds verified artifacts without hiding installed Ollama models', () => {
    syncDiscoveredOllamaModels(['qwen2.5:1.5b-instruct-q4_K_M']);
    syncFoundryModelOptions([{ id: 'foundry:job_12345', label: 'Release specialist' }]);
    expect(getOllamaModelOptions()).toEqual([
      {
        provider: 'ollama',
        id: 'foundry:job_12345',
        label: 'Release specialist',
      },
      {
        provider: 'ollama',
        id: 'qwen2.5:1.5b-instruct-q4_K_M',
        label: 'qwen2.5:1.5b-instruct-q4_K_M',
      },
    ]);
  });
});

describe('native Foundry picker-to-send availability', () => {
  const selection = {
    mode: 'single',
    providerId: 'foundry',
    modelId: 'artifact--job_native_acceptance',
  } as const;
  const context = { apiKeys: {}, offlineMode: false, defaultLocalModel: '', plan: 'free' } as const;
  const job = {
    id: 'job_native_acceptance',
    name: 'Verified native acceptance',
    baseModelId: 'fixture-base',
    method: 'lora',
    status: 'completed',
    artifactVerified: true,
    artifactPath: 'C:\\synthetic\\artifact',
  };
  const validate = (offlineMode = false) =>
    validateSendModelAccess('Say hello.', selection, { ...context, offlineMode }, []);

  it.each([false, true])(
    'accepts the exact verified native picker choice with offline mode=%s and no promotion record',
    (offlineMode) => {
      expect(localStorage.getItem('vibespace.model-foundry.real-adapters.v1')).toBeNull();
      syncFoundryModelOptions(foundryModelOptions([job]));
      expect(getFoundryModelOptions()).toContainEqual({
        provider: 'foundry',
        id: selection.modelId,
        label: job.name,
      });
      expect(getAccessibleProviders({}, offlineMode, 'free', '')).toContain('foundry');
      expect(getAccessibleModelOptions('foundry', {}, offlineMode, '', 'free')).toEqual(
        getFoundryModelOptions(),
      );
      expect(validate(offlineMode)).toMatchObject({ ok: true });
    },
  );

  it.each([
    { label: 'absent', jobs: [], expectedCatalogSize: 0 },
    { label: 'unverified', jobs: [{ ...job, artifactVerified: false }], expectedCatalogSize: 0 },
    { label: 'incomplete', jobs: [{ ...job, status: 'training' }], expectedCatalogSize: 0 },
    {
      label: 'missing artifact path',
      jobs: [{ ...job, artifactPath: '' }],
      expectedCatalogSize: 0,
    },
    {
      label: 'different valid artifact ID',
      jobs: [{ ...job, id: 'job_some_other_artifact' }],
      expectedCatalogSize: 1,
    },
    { label: 'malformed artifact ID', jobs: [{ ...job, id: '../escape' }], expectedCatalogSize: 0 },
  ])('rejects $label without selecting a different artifact', ({ jobs, expectedCatalogSize }) => {
    expect(Array.isArray(jobs)).toBe(true);
    const catalog = foundryModelOptions(jobs);
    expect(catalog).toHaveLength(expectedCatalogSize);
    syncFoundryModelOptions(catalog);
    expect(validate()).toMatchObject({ ok: false });
  });

  it('rejects a cleared or different-account catalog without falling back to another artifact', () => {
    const prior = useAuthStore.getState().localUserId;
    try {
      useAuthStore.setState({ localUserId: 'foundry-owner-a' });
      syncFoundryModelOptions(foundryModelOptions([job]));
      expect(validate()).toMatchObject({ ok: true });
      syncFoundryModelOptions([]);
      expect(validate()).toMatchObject({ ok: false });
      syncFoundryModelOptions(foundryModelOptions([job]));
      useAuthStore.setState({ localUserId: 'foundry-owner-b' });
      expect(validate()).toMatchObject({ ok: false });
      syncFoundryModelOptions(foundryModelOptions([job]), 'foundry-owner-a');
      expect(validate()).toMatchObject({ ok: false });
    } finally {
      useAuthStore.setState({ localUserId: prior });
    }
  });

  it('does not make unrelated cloud models or uninstalled Ollama models available', () => {
    syncFoundryModelOptions(foundryModelOptions([job]));
    for (const candidate of [
      { mode: 'single', providerId: 'openai', modelId: 'gpt-6-luna' },
      { mode: 'single', providerId: 'ollama', modelId: 'absent-local-model' },
    ] as const) {
      expect(validateSendModelAccess('Say hello.', candidate, context, [])).toMatchObject({
        ok: false,
      });
    }
    syncDiscoveredOllamaModels(['qwen3:1.7b']);
    expect(
      validateSendModelAccess(
        'Say hello.',
        { mode: 'single', providerId: 'ollama', modelId: 'qwen3:1.7b' },
        context,
        [],
      ),
    ).toMatchObject({ ok: true });
  });
});


describe('Foundry context ceilings', () => {
  const row = { id: 'artifact--job_context', label: 'Public context model', method: 'full',
    contextWindowTokens: 8192, contextMetadataSource: 'foundry_catalog_ceiling' as const };
  it('carries capped catalogue provenance through the actual job-to-accessible-picker path', () => {
    const options = foundryModelOptions([{ id: 'job_context', name: row.label,
      baseModelId: 'qwen2.5-0.5b-instruct', method: 'full', status: 'completed',
      artifactVerified: true, artifactPath: 'C:/synthetic/weight-artifact' }]);
    syncFoundryModelOptions(options);
    expect(getAccessibleModelOptions('foundry', {}, false, '', 'free')).toContainEqual({
      provider: 'foundry', id: row.id, label: row.label, contextWindowTokens: 16384,
      contextMetadataSource: 'foundry_catalog_ceiling',
    });
  });
  it('updates the mounted picker when only catalogue capacity metadata changes', async () => {
    const view = renderHook(() => useFoundryModelOptions());
    try {
      await act(async () => { await vi.dynamicImportSettled(); });
      act(() => syncFoundryModelOptions([row]));
      expect(view.result.current[0]).toMatchObject({ contextWindowTokens: 8192,
        contextMetadataSource: 'foundry_catalog_ceiling' });
      act(() => syncFoundryModelOptions([{ ...row, contextWindowTokens: 16384 }]));
      expect(view.result.current[0]).toMatchObject({ contextWindowTokens: 16384,
        contextMetadataSource: 'foundry_catalog_ceiling' });
    } finally { view.unmount(); }
  });
  it.each([
    { label: 'no provenance', patch: { contextMetadataSource: undefined } },
    { label: 'foreign provenance', patch: { contextMetadataSource: 'unverified' } },
    { label: 'negative capacity', patch: { contextWindowTokens: -1 } },
    { label: 'oversized capacity', patch: { contextWindowTokens: 32768 } },
    { label: 'fractional capacity', patch: { contextWindowTokens: 8192.5 } },
    { label: 'NaN capacity', patch: { contextWindowTokens: NaN } },
  ])('does not publish $label as known Foundry capacity', ({ patch }) => {
    const malformed = { ...row, ...patch } as unknown as Parameters<typeof syncFoundryModelOptions>[0][number];
    syncFoundryModelOptions([malformed]);
    expect(getFoundryModelOptions()[0]).not.toHaveProperty('contextWindowTokens');
    expect(getFoundryModelOptions()[0]).not.toHaveProperty('contextMetadataSource');
  });
  it.each(['off', 'normal'] as const)('keeps required inputs and the user-selected model with optimizer %s', async (mode) => {
    syncFoundryModelOptions([row]);
    const option = getFoundryModelOptions()[0]!;
    const blocks = [
      { key: 'project', text: 'Required public project instructions.', score: 1 },
      { key: 'explicit_files', text: 'Exact public user attachment.', score: 0 },
      { key: 'repository_context', text: 'Repeated optional public reference.', score: 0.1 },
      { key: 'repository_context', text: 'Repeated optional public reference.', score: 0.2 },
    ] satisfies JarvisRuntimeContextBlock[];
    const messages = [{ role: 'user' as const, content: 'Keep this latest public request exact.' }];
    const result = await optimizeKernelRuntimeContext({ mode, providerId: option.provider,
      modelId: option.id, modelContextLimit: option.contextWindowTokens,
      systemPrompt: 'Required policy stays exact.', requestedOutputTokens: 320, blocks, messages });
    expect(result.messages).toEqual(messages);
    expect(result.blocks.slice(0, 2)).toEqual(blocks.slice(0, 2));
    expect(getFoundryModelOptions()[0]?.id).toBe(row.id);
    if (mode === 'off') {
      expect(result.blocks).toBe(blocks);
      expect(result.receipt).toBeNull();
    } else {
      expect(result.blocks).toEqual(blocks.slice(0, 3));
      expect(result.receipt).toMatchObject({ modelId: row.id, modelChanged: false });
    }
  });
  it('lets the existing enabled optimizer refuse oversized required policy rather than removing it', async () => {
    syncFoundryModelOptions([row]);
    const option = getFoundryModelOptions()[0]!;
    await expect(optimizeKernelRuntimeContext({ mode: 'normal', providerId: option.provider,
      modelId: option.id, modelContextLimit: option.contextWindowTokens, requestedOutputTokens: 320,
      systemPrompt: 'Protected policy remains exact. '.repeat(3000),
      blocks: [{ key: 'project', text: 'Public project instructions stay present.', score: 1 }],
      messages: [{ role: 'user', content: 'Latest public request.' }],
    })).rejects.toMatchObject({ name: 'TokenOptimizationOverflowError',
      receipt: expect.objectContaining({ fitsContext: false, modelChanged: false }) });
    expect(getFoundryModelOptions()[0]?.id).toBe(row.id);
  });

  it('keeps capacity scoped to its account and leaves the selected model identity untouched', () => {
    const prior = useAuthStore.getState().localUserId;
    try {
      useAuthStore.setState({ localUserId: 'context-owner-a' });
      syncFoundryModelOptions([row]);
      expect(getFoundryModelOptions()[0]).toMatchObject({ id: row.id, provider: 'foundry', contextWindowTokens: 8192 });
      useAuthStore.setState({ localUserId: 'context-owner-b' });
      expect(getFoundryModelOptions()).toEqual([]);
      syncFoundryModelOptions([row], 'context-owner-a');
      expect(getFoundryModelOptions()).toEqual([]);
    } finally { useAuthStore.setState({ localUserId: prior }); }
  });
});

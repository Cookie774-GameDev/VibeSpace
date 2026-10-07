import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { foundryModelOptions } from '@/features/model-foundry/modelHub';
import { validateSendModelAccess } from './modelSelection';
import {
  getOllamaModelOptions,
  getAccessibleModelOptions,
  getAccessibleProviders,
  getFoundryModelOptions,
  syncDiscoveredOllamaModels,
  syncFoundryModelOptions,
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

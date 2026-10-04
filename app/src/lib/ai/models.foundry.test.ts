import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import {
  getOllamaModelOptions,
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

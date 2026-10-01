import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { syncDiscoveredOllamaModels } from '@/lib/ai/models';
import { getAllAboutMeModelOptions } from './completion';

describe('getAllAboutMeModelOptions', () => {
  beforeEach(() => {
    useAuthStore.setState({
      apiKeys: { google: 'test-key' },
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: 'llama3.2',
    });
    syncDiscoveredOllamaModels(['llama3.2', 'llama3.2:latest', 'qwen3:4b']);
  });

  afterEach(() => {
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: {},
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: 'llama3.2',
    });
  });

  it('dedupes local ollama/local provider fan-out and similar tags', () => {
    const options = getAllAboutMeModelOptions();
    const local = options.filter((option) => option.provider === 'ollama');
    const ids = local.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    // llama3.2 and llama3.2:latest collapse to one key after :latest strip.
    expect(local.filter((option) => option.model.replace(/:latest$/, '') === 'llama3.2')).toHaveLength(
      1,
    );
  });

  it('never labels a model Recommended', () => {
    const options = getAllAboutMeModelOptions();
    expect(options.some((option) => /recommended/i.test(option.label))).toBe(false);
  });

  it('includes cloud models the user can access and installed local models only', () => {
    const options = getAllAboutMeModelOptions();
    expect(options.some((option) => option.provider === 'google')).toBe(true);
    expect(options.some((option) => option.model === 'qwen3:4b')).toBe(true);
    // Phantom defaults without discovery should not invent options.
    useAuthStore.setState({ apiKeys: {}, defaultLocalModel: 'totally-missing-model' });
    syncDiscoveredOllamaModels([]);
    expect(getAllAboutMeModelOptions()).toEqual([]);
  });
});

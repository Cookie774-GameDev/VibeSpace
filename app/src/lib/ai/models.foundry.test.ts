import { afterEach, describe, expect, it } from 'vitest';
import {
  getOllamaModelOptions,
  syncDiscoveredOllamaModels,
  syncFoundryModelOptions,
} from './models';

afterEach(() => {
  syncDiscoveredOllamaModels([]);
  syncFoundryModelOptions([]);
});

describe('Model Foundry chat catalog', () => {
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

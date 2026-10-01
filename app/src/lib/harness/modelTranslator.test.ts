import { describe, expect, it } from 'vitest';
import { resolveOpenCodeModelSelection } from './modelTranslator';

const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    models: [{ id: 'qwen3:4b', name: 'Qwen3 4B' }],
  },
] as const;

describe('OpenCode model translation', () => {
  it('preserves the exact selected provider and model identity', () => {
    expect(
      resolveOpenCodeModelSelection({
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        providers,
      }),
    ).toEqual({ providerId: 'openai', modelId: 'gpt-5.6-sol' });
  });

  it('preserves an exact installed Ollama model through the local alias', () => {
    expect(
      resolveOpenCodeModelSelection({
        providerId: 'local',
        modelId: 'qwen3:4b',
        providers,
      }),
    ).toEqual({ providerId: 'ollama', modelId: 'qwen3:4b' });
  });

  it('rejects a missing model instead of using the provider default', () => {
    expect(() =>
      resolveOpenCodeModelSelection({
        providerId: 'openai',
        modelId: 'missing-model',
        providers,
      }),
    ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_AVAILABLE' }));
  });

  it('rejects an empty model identity instead of using the first model', () => {
    expect(() =>
      resolveOpenCodeModelSelection({
        providerId: 'openai',
        modelId: '',
        providers,
      }),
    ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_AVAILABLE' }));
  });
});

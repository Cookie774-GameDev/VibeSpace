import { describe, expect, it } from 'vitest';
import { resolveOpenCodeProvider } from './providerTranslator';

const providers = [
  { id: 'openai', name: 'OpenAI', models: [] },
  { id: 'ollama', name: 'Ollama', models: [] },
] as const;

describe('OpenCode provider translation', () => {
  it('resolves only the exact runtime-discovered provider', () => {
    expect(resolveOpenCodeProvider('openai', providers).id).toBe('openai');
  });

  it('maps the VibeSpace local alias only to discovered Ollama', () => {
    expect(resolveOpenCodeProvider('local', providers).id).toBe('ollama');
  });

  it('rejects a missing provider instead of selecting a default', () => {
    expect(() => resolveOpenCodeProvider('anthropic', providers)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('rejects an empty provider identity instead of selecting the first provider', () => {
    expect(() => resolveOpenCodeProvider('', providers)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });
});

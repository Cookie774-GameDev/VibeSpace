import { describe, expect, it } from 'vitest';
import {
  REAL_CHAT_PROVIDERS,
  defaultModelForProvider,
  getModelOptions,
  isRealChatProvider,
} from './models';

describe('chat model catalog', () => {
  it('only advertises providers with working chat adapters', () => {
    expect(REAL_CHAT_PROVIDERS).toEqual([
      'google',
      'groq',
      'openai',
      'anthropic',
      'ollama',
      'local',
      'mock',
    ]);
    expect(isRealChatProvider('openrouter')).toBe(false);
  });

  it('provides selectable model ids for each advertised provider', () => {
    for (const provider of REAL_CHAT_PROVIDERS) {
      expect(getModelOptions(provider).length, provider).toBeGreaterThan(0);
    }
  });

  it('uses the configured local model as the local default', () => {
    expect(defaultModelForProvider('ollama', 'qwen2.5:3b')).toBe('qwen2.5:3b');
  });
});

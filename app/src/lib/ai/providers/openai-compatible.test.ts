import { describe, expect, it } from 'vitest';
import { makeOpenAICompatibleProvider } from './openai-compatible';

describe('makeOpenAICompatibleProvider', () => {
  it('exposes id and name from config', () => {
    const p = makeOpenAICompatibleProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyStoreKey: 'deepseek',
      defaultModel: 'deepseek-chat',
    });
    expect(p.id).toBe('deepseek');
    expect(p.name).toBe('DeepSeek');
    expect(p.isAvailable()).toBe(false);
  });
});

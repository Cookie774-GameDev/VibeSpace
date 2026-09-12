import { describe, expect, it } from 'vitest';
import {
  createTokenOptimizationPreferenceStore,
  type TokenOptimizationPreferenceStorage,
} from './modePreferences';

function memoryStorage(initial?: string): TokenOptimizationPreferenceStorage & {
  value: string | null;
} {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
    removeItem() {
      this.value = null;
    },
  };
}

describe('token optimization preferences', () => {
  it('persists a global default and deterministic per-chat overrides', () => {
    const storage = memoryStorage();
    const store = createTokenOptimizationPreferenceStore(storage);

    store.setGlobalMode('saver');
    store.setChatOverride('chat-z', 'final_boss');
    store.setChatOverride('chat-a', 'off');

    expect(store.resolveMode('chat-z')).toBe('final_boss');
    expect(store.resolveMode('chat-missing')).toBe('saver');
    expect(storage.value).toBe(
      '{"version":1,"globalMode":"saver","defaultMaxOutputTokens":8192,"allowStructuralCodeCompression":true,"showOptimizationReportAutomatically":true,"neverChangeSelectedModel":true,"chatOverrides":{"chat-a":"off","chat-z":"final_boss"}}',
    );
  });

  it('recovers from malformed storage and rejects raw-content-like chat keys', () => {
    const storage = memoryStorage('{"globalMode":"wild","chatOverrides":{"chat":"wild"}}');
    const store = createTokenOptimizationPreferenceStore(storage);
    expect(store.getSnapshot()).toEqual({
      version: 1,
      globalMode: 'off',
      defaultMaxOutputTokens: 8192,
      allowStructuralCodeCompression: true,
      showOptimizationReportAutomatically: true,
      neverChangeSelectedModel: true,
      chatOverrides: {},
    });
    expect(() => store.setChatOverride('user message with spaces', 'saver')).toThrow(
      /invalid chat preference key/i,
    );
  });

  it('persists bounded global optimization controls without allowing model switching', () => {
    const store = createTokenOptimizationPreferenceStore(memoryStorage());
    store.setDefaultMaxOutputTokens(4_096);
    store.setAllowStructuralCodeCompression(false);
    store.setShowOptimizationReportAutomatically(false);

    expect(store.getSnapshot()).toMatchObject({
      defaultMaxOutputTokens: 4_096,
      allowStructuralCodeCompression: false,
      showOptimizationReportAutomatically: false,
      neverChangeSelectedModel: true,
    });
    expect(() => store.setDefaultMaxOutputTokens(33_000)).toThrow(/output token limit/i);
  });

  it('clears a chat override without changing the global default', () => {
    const store = createTokenOptimizationPreferenceStore(memoryStorage());
    store.setGlobalMode('final_boss');
    store.setChatOverride('chat-1', 'off');
    store.clearChatOverride('chat-1');
    expect(store.resolveMode('chat-1')).toBe('final_boss');
  });
});

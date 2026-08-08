import { beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_CHAT_STORAGE_KEY,
  createBrowserChatStore,
  type BrowserChatStorage,
} from './browserChatStore';

function memoryStorage(seed?: Record<string, string>): BrowserChatStorage {
  const values = new Map(Object.entries(seed ?? {}));
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => void values.set(name, value),
    removeItem: (name) => void values.delete(name),
  };
}

describe('Browser Chat engine state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts in native VibeSpace Chat and switches engines without changing routes or models', () => {
    const store = createBrowserChatStore(memoryStorage());

    expect(store.getState().engine).toBe('native');
    expect(store.getState().providerId).toBe('chatgpt');

    store.getState().setEngine('browser');
    store.getState().setProvider('claude');

    expect(store.getState().engine).toBe('browser');
    expect(store.getState().providerId).toBe('claude');
    expect(Object.keys(store.getState()).sort()).not.toContain('modelId');
    expect(Object.keys(store.getState()).sort()).not.toContain('route');
  });

  it('keeps Native and Browser mode independently for each VibeSpace conversation', () => {
    const storage = memoryStorage();
    const store = createBrowserChatStore(storage);

    store.getState().setEngine('browser', 'chat-browser');
    store.getState().setProvider('chatgpt', 'chat-browser');
    store.getState().setEngine('native', 'chat-native');

    expect(store.getState().chatPreferences['chat-browser']).toMatchObject({
      engine: 'browser',
      providerId: 'chatgpt',
    });
    expect(store.getState().chatPreferences['chat-native']).toMatchObject({
      engine: 'native',
    });
    expect(storage.getItem(BROWSER_CHAT_STORAGE_KEY)).toContain('"chat-browser"');
    expect(storage.getItem(BROWSER_CHAT_STORAGE_KEY)).toContain('"chat-native"');
  });

  it('persists only local Browser Chat preferences', () => {
    const storage = memoryStorage();
    const store = createBrowserChatStore(storage);

    store.getState().setEngine('browser');
    store.getState().setProvider('gemini');
    store.getState().setPreferManagedSurface(false);

    const raw = storage.getItem(BROWSER_CHAT_STORAGE_KEY);
    expect(raw).toContain('"engine":"browser"');
    expect(raw).toContain('"providerId":"gemini"');
    expect(raw).toContain('"preferManagedSurface":false');
    expect(raw).not.toMatch(/cookie|password|token|conversation/i);
  });

  it('fails closed to safe defaults when persisted values are invalid', async () => {
    const storage = memoryStorage({
      [BROWSER_CHAT_STORAGE_KEY]: JSON.stringify({
        state: {
          engine: 'scraped-chat',
          providerId: 'untrusted-provider',
          preferManagedSurface: 'yes',
        },
        version: 1,
      }),
    });
    const store = createBrowserChatStore(storage);

    await store.persist.rehydrate();

    expect(store.getState().engine).toBe('native');
    expect(store.getState().providerId).toBe('chatgpt');
    expect(store.getState().preferManagedSurface).toBe(true);
  });
});

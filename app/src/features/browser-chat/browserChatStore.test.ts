import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_CHAT_STORAGE_KEY,
  createBrowserChatStore,
  findExclusiveBrowserChatId,
  migrateLegacyBrowserChatPreferences,
  resolveChatEngine,
  type BrowserChatPreference,
  type BrowserChatStorage,
} from './browserChatStore';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { ChatId, WorkspaceId } from '@/types/common';

const TEST_CONVERSATION_ONE = `conversation-${1}`;

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

  it('persistently retires collapsed legacy browser preferences', () => {
    const storage = memoryStorage();
    const store = createBrowserChatStore(storage);
    store.getState().setEngine('browser', 'collapsed-chat');
    store.getState().setEngine('browser', 'retained-chat');

    store.getState().clearChatPreferences(['collapsed-chat']);

    expect(store.getState().chatPreferences).not.toHaveProperty('collapsed-chat');
    expect(store.getState().chatPreferences).toHaveProperty('retained-chat');
    expect(storage.getItem(BROWSER_CHAT_STORAGE_KEY)).not.toContain('collapsed-chat');
  });

  it('keeps only one ChatGPT Browser Chat open and reuses that chat', () => {
    const store = createBrowserChatStore(memoryStorage());
    store.getState().setEngine('browser', 'chat-chatgpt');
    store.getState().setProvider('chatgpt', 'chat-chatgpt');
    store.getState().setEngine('browser', 'chat-second');

    expect(findExclusiveBrowserChatId(store.getState(), 'chatgpt')).toBe('chat-second');
    expect(resolveChatEngine(store.getState(), 'chat-chatgpt')).toBe('native');
    expect(resolveChatEngine(store.getState(), 'chat-second')).toBe('browser');
  });

  it('defaults every unconfigured new conversation to native without changing explicit Browser chats', () => {
    const store = createBrowserChatStore(memoryStorage());
    store.getState().setEngine('browser');
    store.getState().setEngine('browser', 'explicit-browser-chat');

    expect(resolveChatEngine(store.getState(), 'new-chat')).toBe('native');
    expect(resolveChatEngine(store.getState(), 'explicit-browser-chat')).toBe('browser');
    expect(resolveChatEngine(store.getState(), null)).toBe('native');
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

describe('legacy Browser Chat preference migration', () => {
  let database: JarvisDexie;

  beforeEach(async () => {
    database = createJarvisDb(
      uniqueTestDbName('browser-chat-preference-migration'),
      TEST_INDEXED_DB,
    );
    await database.open();
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it('migrates only browser chats in the exact workspace and is idempotent', async () => {
    await database.chats.bulkPut([
      {
        id: 'browser-chat' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        title: 'Legacy browser chat',
        mode: 'chat',
        active_agent_ids: [],
        pinned: true,
        created_at: 1,
        updated_at: 2,
      },
      {
        id: 'native-chat' as ChatId,
        workspace_id: 'workspace-1' as WorkspaceId,
        title: 'Native chat',
        mode: 'chat',
        active_agent_ids: [],
        created_at: 1,
        updated_at: 2,
      },
      {
        id: 'foreign-chat' as ChatId,
        workspace_id: 'workspace-2' as WorkspaceId,
        title: 'Foreign browser chat',
        mode: 'chat',
        active_agent_ids: [],
        created_at: 1,
        updated_at: 2,
      },
    ]);
    const preferences = {
      'browser-chat': { engine: 'browser', providerId: 'chatgpt' },
      'native-chat': { engine: 'native', providerId: 'claude' },
      'foreign-chat': { engine: 'browser', providerId: 'gemini' },
      missing: { engine: 'browser', providerId: 'chatgpt' },
    } satisfies Record<string, BrowserChatPreference>;
    let id = 0;
    const input = {
      database,
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      accountProfileKey:
        'profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
      clearCollapsedChatPreferences: () => undefined,
      preferences,
      clock: () => 100,
      idFactory: () => `migrated-${++id}`,
    };

    await expect(migrateLegacyBrowserChatPreferences(input)).resolves.toBe(1);
    await expect(migrateLegacyBrowserChatPreferences(input)).resolves.toBe(0);

    const rows = await database.browser_chat_bindings.toArray();
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'migrated-1',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        chatId: 'browser-chat',
        provider: 'chatgpt',
        providerProfileKey:
          'browser-chat/chatgpt/profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        localTitle: 'Legacy browser chat',
        pinned: true,
      }),
    ]);
  });

  it('idempotently scopes existing bindings and collapses a mixed legacy duplicate', async () => {
    const accountProfileKey =
      'profile_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
    const scopedProfileKey = `browser-chat/chatgpt/${accountProfileKey}`;
    await database.browser_chat_bindings.bulkAdd([
      {
        id: 'legacy-only',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        chatId: 'legacy-chat',
        provider: 'chatgpt',
        providerProfileKey: 'browser-chat/chatgpt',
        bindingState: 'new',
        localTitle: 'Legacy only',
        pinned: false,
        viewMode: 'vibespace',
        createdAt: 10,
        updatedAt: 11,
      },
      {
        id: 'legacy-duplicate',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'legacy-project',
        chatId: 'legacy-duplicate-chat',
        provider: 'chatgpt',
        providerProfileKey: 'browser-chat/chatgpt',
        providerConversationKey: TEST_CONVERSATION_ONE,
        resumeUrl: 'https://chatgpt.com/c/conversation-1',
        bindingState: 'bound',
        localTitle: 'Legacy duplicate',
        pinned: true,
        viewMode: 'provider',
        createdAt: 20,
        updatedAt: 21,
        lastOpenedAt: 80,
      },
      {
        id: 'scoped-canonical',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        chatId: 'scoped-chat',
        provider: 'chatgpt',
        providerProfileKey: scopedProfileKey,
        providerConversationKey: TEST_CONVERSATION_ONE,
        resumeUrl: 'https://chatgpt.com/c/conversation-1',
        bindingState: 'bound',
        localTitle: 'Scoped canonical',
        pinned: false,
        viewMode: 'vibespace',
        createdAt: 30,
        updatedAt: 31,
        lastOpenedAt: 40,
      },
      {
        id: 'foreign-account',
        accountId: 'account-2',
        workspaceId: 'workspace-1',
        chatId: 'foreign-chat',
        provider: 'chatgpt',
        providerProfileKey: 'browser-chat/chatgpt',
        bindingState: 'new',
        localTitle: 'Foreign',
        pinned: false,
        viewMode: 'vibespace',
        createdAt: 50,
        updatedAt: 51,
      },
    ]);
    await database.chats.add({
      id: 'legacy-duplicate-chat' as ChatId,
      workspace_id: 'workspace-1' as WorkspaceId,
      title: 'Legacy duplicate',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });
    const preferences: Record<string, BrowserChatPreference> = {
      'legacy-duplicate-chat': { engine: 'browser', providerId: 'chatgpt' },
    };
    const input = {
      database,
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      accountProfileKey,
      preferences,
      clearCollapsedChatPreferences: (chatIds: readonly string[]) => {
        for (const chatId of chatIds) delete preferences[chatId];
      },
      clock: () => 100,
    };

    await expect(migrateLegacyBrowserChatPreferences(input)).resolves.toBe(2);
    await expect(migrateLegacyBrowserChatPreferences(input)).resolves.toBe(0);

    expect(await database.browser_chat_bindings.get('legacy-only')).toMatchObject({
      providerProfileKey: scopedProfileKey,
    });
    expect(await database.browser_chat_bindings.get('legacy-duplicate')).toBeUndefined();
    expect(await database.browser_chat_bindings.get('scoped-canonical')).toMatchObject({
      providerProfileKey: scopedProfileKey,
      providerConversationKey: TEST_CONVERSATION_ONE,
      localTitle: 'Scoped canonical',
      pinned: true,
      lastOpenedAt: 80,
      projectId: 'legacy-project',
    });
    expect(await database.browser_chat_bindings.get('foreign-account')).toMatchObject({
      providerProfileKey: 'browser-chat/chatgpt',
    });
    expect(preferences).not.toHaveProperty('legacy-duplicate-chat');
    await expect(
      database.browser_chat_bindings
        .where('[accountId+workspaceId]')
        .equals(['account-1', 'workspace-1'])
        .count(),
    ).resolves.toBe(2);

    database.close();
    await database.open();
    await expect(migrateLegacyBrowserChatPreferences(input)).resolves.toBe(0);
    await expect(
      database.browser_chat_bindings
        .where('[accountId+workspaceId+provider+providerProfileKey+providerConversationKey]')
        .equals(['account-1', 'workspace-1', 'chatgpt', scopedProfileKey, TEST_CONVERSATION_ONE])
        .count(),
    ).resolves.toBe(1);
  });
});

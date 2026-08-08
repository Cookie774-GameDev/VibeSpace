import { useStore } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import {
  isBrowserChatProviderId,
  type BrowserChatPageStatus,
  type BrowserChatProviderId,
  type BrowserChatToolBridgeStatus,
} from './providerRegistry';

export type VibeSpaceChatEngine = 'native' | 'browser';
export type BrowserChatStorage = StateStorage;

export const BROWSER_CHAT_STORAGE_KEY = 'vibespace.browser-chat.preferences.v1';

interface ProviderRuntimeState {
  readonly pageStatus: BrowserChatPageStatus;
  readonly toolBridgeStatus: BrowserChatToolBridgeStatus;
  readonly error?: string;
}

export interface BrowserChatPreference {
  readonly engine: VibeSpaceChatEngine;
  readonly providerId: BrowserChatProviderId;
}

export interface BrowserChatState {
  readonly engine: VibeSpaceChatEngine;
  readonly providerId: BrowserChatProviderId;
  readonly chatPreferences: Readonly<Record<string, BrowserChatPreference>>;
  readonly preferManagedSurface: boolean;
  readonly providerRuntime: Partial<Record<BrowserChatProviderId, ProviderRuntimeState>>;
  setEngine(engine: VibeSpaceChatEngine, chatId?: string | null): void;
  setProvider(providerId: BrowserChatProviderId, chatId?: string | null): void;
  setPreferManagedSurface(preferManagedSurface: boolean): void;
  setProviderRuntime(providerId: BrowserChatProviderId, state: ProviderRuntimeState): void;
}

const DEFAULT_STATE = Object.freeze({
  engine: 'native' as const,
  providerId: 'chatgpt' as const,
  preferManagedSurface: true,
});

const MAX_CHAT_PREFERENCES = 500;

function validChatId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim() === value
  );
}

function validatedChatPreferences(value: unknown): Record<string, BrowserChatPreference> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, BrowserChatPreference> = {};
  for (const [chatId, candidate] of Object.entries(value).slice(-MAX_CHAT_PREFERENCES)) {
    if (!validChatId(chatId) || typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    result[chatId] = {
      engine: record.engine === 'browser' ? 'browser' : 'native',
      providerId: isBrowserChatProviderId(record.providerId) ? record.providerId : 'chatgpt',
    };
  }
  return result;
}

function validatedPersistedState(value: unknown) {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    engine: record.engine === 'browser' || record.engine === 'native' ? record.engine : 'native',
    providerId: isBrowserChatProviderId(record.providerId) ? record.providerId : 'chatgpt',
    chatPreferences: validatedChatPreferences(record.chatPreferences),
    preferManagedSurface:
      typeof record.preferManagedSurface === 'boolean' ? record.preferManagedSurface : true,
  } satisfies Pick<
    BrowserChatState,
    'engine' | 'providerId' | 'chatPreferences' | 'preferManagedSurface'
  >;
}

export function createBrowserChatStore(storage: BrowserChatStorage = localStorage) {
  return createStore<BrowserChatState>()(
    persist(
      (set) => ({
        ...DEFAULT_STATE,
        chatPreferences: {},
        providerRuntime: {},
        setEngine: (engine, chatId) =>
          set((current) =>
            validChatId(chatId)
              ? {
                  chatPreferences: {
                    ...current.chatPreferences,
                    [chatId]: {
                      engine,
                      providerId: current.chatPreferences[chatId]?.providerId ?? 'chatgpt',
                    },
                  },
                }
              : { engine },
          ),
        setProvider: (providerId, chatId) =>
          set((current) =>
            validChatId(chatId)
              ? {
                  chatPreferences: {
                    ...current.chatPreferences,
                    [chatId]: {
                      engine: current.chatPreferences[chatId]?.engine ?? current.engine,
                      providerId,
                    },
                  },
                }
              : { providerId },
          ),
        setPreferManagedSurface: (preferManagedSurface) => set({ preferManagedSurface }),
        setProviderRuntime: (providerId, state) =>
          set((current) => ({
            providerRuntime: { ...current.providerRuntime, [providerId]: state },
          })),
      }),
      {
        name: BROWSER_CHAT_STORAGE_KEY,
        version: 1,
        storage: createJSONStorage(() => storage),
        partialize: (state) => ({
          engine: state.engine,
          providerId: state.providerId,
          chatPreferences: state.chatPreferences,
          preferManagedSurface: state.preferManagedSurface,
        }),
        merge: (persisted, current) => ({
          ...current,
          ...validatedPersistedState(persisted),
          providerRuntime: {},
        }),
      },
    ),
  );
}

export const browserChatStore = createBrowserChatStore();

export function useBrowserChatStore<T>(selector: (state: BrowserChatState) => T): T {
  return useStore(browserChatStore, selector);
}

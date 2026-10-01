import { useStore } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import {
  browserChatProvider,
  isBrowserChatProviderId,
  type BrowserChatPageStatus,
  type BrowserChatProviderId,
  type BrowserChatToolBridgeStatus,
} from './providerRegistry';
import { createBrowserChatBindingRepository } from './browserChatRepository';
import {
  scopedProviderProfileKey,
  type BrowserChatAccountProfileKey,
} from './providerProfileScope';
import type { JarvisDexie } from '@/lib/db';
import type { ChatId } from '@/types/common';

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
  clearChatPreferences(chatIds: readonly string[]): void;
  setPreferManagedSurface(preferManagedSurface: boolean): void;
  setProviderRuntime(providerId: BrowserChatProviderId, state: ProviderRuntimeState): void;
}

const DEFAULT_STATE = Object.freeze({
  engine: 'native' as const,
  providerId: 'chatgpt' as const,
  preferManagedSurface: true,
});

const MAX_CHAT_PREFERENCES = 500;

type LegacyBrowserChatMigrationInput = {
  readonly database: JarvisDexie;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly accountProfileKey: BrowserChatAccountProfileKey;
  readonly clearCollapsedChatPreferences: (chatIds: readonly string[]) => void;
  readonly preferences: Readonly<Record<string, BrowserChatPreference>>;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
};

function validChatId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim() === value
  );
}

/**
 * A Browser Chat selection belongs to one conversation. The legacy global
 * value remains available before a conversation exists, but it must never
 * leak into a newly created/unconfigured VibeSpace chat.
 */
export function resolveChatEngine(
  state: Pick<BrowserChatState, 'engine' | 'chatPreferences'>,
  chatId?: string | null,
): VibeSpaceChatEngine {
  // The default VibeSpace chat page must stay native. A persisted global
  // Browser Chat selection must not overlay ChatGPT on every route/chat.
  if (!validChatId(chatId)) return 'native';
  return state.chatPreferences[chatId]?.engine ?? 'native';
}

export function findExclusiveBrowserChatId(
  state: Pick<BrowserChatState, 'chatPreferences'>,
  providerId: BrowserChatProviderId = 'chatgpt',
): string | null {
  for (const [chatId, preference] of Object.entries(state.chatPreferences)) {
    if (
      validChatId(chatId) &&
      preference.engine === 'browser' &&
      preference.providerId === providerId
    ) {
      return chatId;
    }
  }
  return null;
}

function exclusiveBrowserPreferences(
  current: Record<string, BrowserChatPreference>,
  chatId: string,
  engine: VibeSpaceChatEngine,
  providerId: BrowserChatProviderId,
): Record<string, BrowserChatPreference> {
  const chatPreferences = { ...current };
  if (engine === 'browser') {
    for (const [id, preference] of Object.entries(chatPreferences)) {
      if (id !== chatId && preference.engine === 'browser' && preference.providerId === providerId) {
        chatPreferences[id] = { ...preference, engine: 'native' };
      }
    }
  }
  chatPreferences[chatId] = { engine, providerId };
  return chatPreferences;
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

/**
 * Materializes the old per-chat browser-mode flags into durable scoped rows.
 * Missing chats, native chats, and chats outside the exact workspace are
 * intentionally ignored. Existing bindings make repeat runs a no-op.
 */
export async function migrateLegacyBrowserChatPreferences({
  database,
  accountId,
  workspaceId,
  accountProfileKey,
  clearCollapsedChatPreferences,
  preferences,
  clock,
  idFactory,
}: LegacyBrowserChatMigrationInput): Promise<number> {
  const repository = createBrowserChatBindingRepository(database, clock, idFactory);
  const collapsedChatIds = new Set<string>();
  let migrated = await database.transaction(
    'rw',
    database.browser_chat_bindings,
    async (): Promise<number> => {
      const bindings = await database.browser_chat_bindings
        .where('[accountId+workspaceId]')
        .equals([accountId, workspaceId])
        .toArray();
      let scoped = 0;
      for (const binding of bindings) {
        const legacyProfileKey = browserChatProvider(binding.provider).profileKey;
        if (binding.providerProfileKey !== legacyProfileKey) continue;
        const providerProfileKey = scopedProviderProfileKey(legacyProfileKey, accountProfileKey);
        const conflict = binding.providerConversationKey
          ? await database.browser_chat_bindings
              .where('[accountId+workspaceId+provider+providerProfileKey+providerConversationKey]')
              .equals([
                accountId,
                workspaceId,
                binding.provider,
                providerProfileKey,
                binding.providerConversationKey,
              ])
              .first()
          : undefined;

        if (conflict && conflict.id !== binding.id) {
          clearCollapsedChatPreferences([binding.chatId]);
          collapsedChatIds.add(binding.chatId);
          await database.browser_chat_bindings.put({
            ...conflict,
            projectId: conflict.projectId ?? binding.projectId,
            providerProjectKey: conflict.providerProjectKey ?? binding.providerProjectKey,
            permissionProfileId: conflict.permissionProfileId ?? binding.permissionProfileId,
            pinned: conflict.pinned || binding.pinned,
            createdAt: Math.min(conflict.createdAt, binding.createdAt),
            updatedAt: Math.max(conflict.updatedAt, binding.updatedAt),
            lastOpenedAt:
              conflict.lastOpenedAt === undefined
                ? binding.lastOpenedAt
                : binding.lastOpenedAt === undefined
                  ? conflict.lastOpenedAt
                  : Math.max(conflict.lastOpenedAt, binding.lastOpenedAt),
          });
          await database.browser_chat_bindings.delete(binding.id);
        } else {
          await database.browser_chat_bindings.put({
            ...binding,
            providerProfileKey,
          });
        }
        scoped += 1;
      }
      return scoped;
    },
  );
  const browserPreferences = Object.entries(preferences).filter(
    ([chatId, preference]) =>
      validChatId(chatId) &&
      !collapsedChatIds.has(chatId) &&
      preference.engine === 'browser' &&
      isBrowserChatProviderId(preference.providerId),
  );
  const chats = await database.chats.bulkGet(
    browserPreferences.map(([chatId]) => chatId as ChatId),
  );
  for (const [[chatId, preference], chat] of browserPreferences.map(
    (entry, index) => [entry, chats[index]] as const,
  )) {
    if (!chat || String(chat.workspace_id) !== workspaceId) continue;
    if (await repository.findByChat({ accountId, workspaceId }, chatId)) continue;
    const provider = browserChatProvider(preference.providerId);
    await repository.create({
      accountId,
      workspaceId,
      projectId: chat.project_id ? String(chat.project_id) : undefined,
      chatId,
      provider: provider.id,
      providerProfileKey: scopedProviderProfileKey(provider.profileKey, accountProfileKey),
      localTitle: chat.title,
      pinned: chat.pinned ?? false,
    });
    migrated += 1;
  }

  return migrated;
}

export function createBrowserChatStore(storage: BrowserChatStorage = localStorage) {
  return createStore<BrowserChatState>()(
    persist(
      (set) => ({
        ...DEFAULT_STATE,
        chatPreferences: {},
        providerRuntime: {},
        setEngine: (engine, chatId) =>
          set((current) => {
            if (!validChatId(chatId)) return { engine };
            const providerId = current.chatPreferences[chatId]?.providerId ?? current.providerId;
            return {
              chatPreferences: exclusiveBrowserPreferences(
                current.chatPreferences,
                chatId,
                engine,
                providerId,
              ),
            };
          }),
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
        clearChatPreferences: (chatIds) =>
          set((current) => {
            const chatPreferences = { ...current.chatPreferences };
            for (const chatId of chatIds) {
              if (validChatId(chatId)) delete chatPreferences[chatId];
            }
            return { chatPreferences };
          }),
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

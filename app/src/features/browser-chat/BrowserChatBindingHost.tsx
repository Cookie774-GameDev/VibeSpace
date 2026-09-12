import * as React from 'react';

import { db } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { Chat } from '@/types/chat';
import type { ChatId } from '@/types/common';
import { browserChatStore, useBrowserChatStore } from './browserChatStore';
import {
  browserChatBindingRepository,
  type BrowserChatBindingRepository,
} from './browserChatBindings';

type BrowserChatBindingChat = Pick<
  Chat,
  | 'id'
  | 'workspace_id'
  | 'project_id'
  | 'title'
  | 'pinned'
  | 'created_at'
  | 'updated_at'
>;

export interface BrowserChatBindingHostProps {
  readonly repository?: BrowserChatBindingRepository;
  readonly loadChat?: (chatId: string) => Promise<BrowserChatBindingChat | undefined>;
  readonly loadChats?: (chatIds: readonly string[]) => Promise<BrowserChatBindingChat[]>;
  readonly clock?: () => number;
}

async function defaultLoadChat(chatId: string): Promise<BrowserChatBindingChat | undefined> {
  return db.chats.get(chatId as ChatId);
}

async function defaultLoadChats(chatIds: readonly string[]): Promise<BrowserChatBindingChat[]> {
  if (chatIds.length === 0) return [];
  const rows = await db.chats.bulkGet([...chatIds] as ChatId[]);
  return rows.filter((row): row is Chat => Boolean(row));
}

/**
 * Persists only VibeSpace-owned Browser Chat metadata.
 *
 * Provider message bodies, cookies, passwords, and page storage never enter
 * this host. Existing Browser Chat preferences are migrated from the legacy
 * local store into the account-scoped Dexie settings repository, then restored
 * when the desktop Chat workspace is mounted after an app restart.
 */
export function BrowserChatBindingHost({
  repository = browserChatBindingRepository,
  loadChat = defaultLoadChat,
  loadChats = defaultLoadChats,
  clock = Date.now,
}: BrowserChatBindingHostProps) {
  const accountId = useAuthStore(
    (state) => state.cloudSession?.user_id ?? state.localUserId ?? '',
  );
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const activeChatId = useUIStore((state) => state.activeChatId);
  const chatPreferences = useBrowserChatStore((state) => state.chatPreferences);
  const globalProviderId = useBrowserChatStore((state) => state.providerId);
  const setEngine = useBrowserChatStore((state) => state.setEngine);
  const setProvider = useBrowserChatStore((state) => state.setProvider);

  const browserChatIds = React.useMemo(
    () =>
      Object.entries(chatPreferences)
        .filter(([, preference]) => preference.engine === 'browser')
        .map(([chatId]) => chatId)
        .sort(),
    [chatPreferences],
  );
  const browserChatIdsKey = React.useMemo(() => browserChatIds.join('|'), [browserChatIds]);
  const activePreference = activeChatId ? chatPreferences[activeChatId] : undefined;
  const activeProviderId = activePreference?.providerId ?? globalProviderId;

  React.useEffect(() => {
    if (!accountId || !workspaceId) return;
    let cancelled = false;
    void repository
      .list(accountId, String(workspaceId))
      .then((bindings) => {
        if (cancelled) return;
        for (const binding of bindings) {
          setEngine('browser', binding.nativeChatId);
          setProvider(binding.provider, binding.nativeChatId);
        }
      })
      .catch((error) => {
        if (!cancelled) console.warn('[browser-chat] binding restore failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, repository, setEngine, setProvider, workspaceId]);

  React.useEffect(() => {
    if (!accountId || !workspaceId || browserChatIds.length === 0) return;
    let cancelled = false;
    void loadChats(browserChatIds)
      .then(async (chats) => {
        if (cancelled) return;
        for (const chat of chats) {
          const preference = browserChatStore.getState().chatPreferences[chat.id];
          if (preference?.engine !== 'browser') continue;
          await repository.upsert(accountId, {
            id: chat.id,
            accountId,
            workspaceId: String(chat.workspace_id),
            projectId: chat.project_id ? String(chat.project_id) : undefined,
            nativeChatId: chat.id,
            provider: preference.providerId,
            providerProfileKey: `vibespace-account:${accountId}`,
            title: chat.title,
            pinned: chat.pinned === true,
            state: 'bound',
            createdAt: chat.created_at,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) console.warn('[browser-chat] binding migration failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, browserChatIds, browserChatIdsKey, loadChats, repository, workspaceId]);

  React.useEffect(() => {
    if (!accountId || !activeChatId || activePreference?.engine !== 'browser') return;
    let cancelled = false;
    void loadChat(activeChatId)
      .then(async (chat) => {
        if (cancelled || !chat) return;
        await repository.upsert(accountId, {
          id: chat.id,
          accountId,
          workspaceId: String(chat.workspace_id),
          projectId: chat.project_id ? String(chat.project_id) : undefined,
          nativeChatId: chat.id,
          provider: activeProviderId,
          providerProfileKey: `vibespace-account:${accountId}`,
          title: chat.title,
          pinned: chat.pinned === true,
          state: 'bound',
          createdAt: chat.created_at,
          lastOpenedAt: clock(),
        });
      })
      .catch((error) => {
        if (!cancelled) console.warn('[browser-chat] active binding update failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    activeChatId,
    activePreference?.engine,
    activeProviderId,
    clock,
    loadChat,
    repository,
  ]);

  return null;
}

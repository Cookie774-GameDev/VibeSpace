import { chatRepo } from '@/lib/db';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import type { ProviderConnection } from '@/lib/ai/adapters/types';
import { browserChatStore, resolveChatEngine } from '@/features/browser-chat/browserChatStore';
import type { BrowserChatProviderId } from '@/features/browser-chat/providerRegistry';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { Chat, ChatId, ProjectId, ProviderId } from '@/types';

export type StoredChatEngineIdentity = {
  readonly engine: 'native' | 'browser';
  readonly providerId: BrowserChatProviderId;
};

export type StoredChatOpenResult =
  | {
      readonly status: 'opened';
      readonly chatId: string;
      readonly model: 'none' | 'restored' | 'unavailable';
    }
  | { readonly status: 'not-found' | 'forbidden' | 'superseded' | 'failed' };

export interface StoredChatNavigationDependencies {
  getScope(): { readonly accountId: string | null; readonly workspaceId: string | null; readonly projectId?: string | null };
  getChat(chatId: ChatId): Promise<Chat | undefined>;
  restoreArchivedChat(chatId: ChatId): Promise<void>;
  restoreExactModel(connection: ProviderConnection): void;
  readStoredEngine(chatId: string): StoredChatEngineIdentity;
  restoreExactEngine(chatId: string, identity: StoredChatEngineIdentity): void;
  activateAndRoute(chatId: string, projectId: ProjectId | null): void;
}

function sameScope(
  left: ReturnType<StoredChatNavigationDependencies['getScope']>,
  right: ReturnType<StoredChatNavigationDependencies['getScope']>,
) {
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId;
}

/**
 * Creates a latest-request-wins stored-chat opener. All validation and exact
 * identity restoration completes before the single UI activation write.
 */
export function createStoredChatNavigator(deps: StoredChatNavigationDependencies) {
  let latestRequest = 0;

  return async function openStoredChat(chatId: ChatId): Promise<StoredChatOpenResult> {
    const request = ++latestRequest;
    const initialScope = deps.getScope();
    if (!initialScope.accountId || !initialScope.workspaceId) return { status: 'forbidden' };

    let chat: Chat | undefined;
    try {
      chat = await deps.getChat(chatId);
    } catch {
      return request === latestRequest ? { status: 'failed' } : { status: 'superseded' };
    }

    if (request !== latestRequest) return { status: 'superseded' };
    if (!sameScope(initialScope, deps.getScope())) return { status: 'superseded' };
    if (!chat) return { status: 'not-found' };
    if (String(chat.workspace_id) !== initialScope.workspaceId) return { status: 'forbidden' };

    if (chat.archived) {
      try {
        await deps.restoreArchivedChat(chat.id);
      } catch {
        return { status: 'failed' };
      }
      if (request !== latestRequest || !sameScope(initialScope, deps.getScope())) {
        return { status: 'superseded' };
      }
    }

    let model: 'none' | 'restored' | 'unavailable' = 'none';
    if (chat.connection?.modelId?.trim()) {
      try {
        deps.restoreExactModel(chat.connection);
        model = 'restored';
      } catch {
        // Message restoration remains available, but never substitute another
        // provider/model when the exact stored identity is unavailable.
        model = 'unavailable';
      }
    }

    if (request !== latestRequest || !sameScope(initialScope, deps.getScope())) {
      return { status: 'superseded' };
    }

    try {
      const storedEngine = deps.readStoredEngine(String(chat.id));
      deps.restoreExactEngine(String(chat.id), storedEngine);
      deps.activateAndRoute(String(chat.id), chat.project_id ?? null);
    } catch {
      return { status: 'failed' };
    }

    return { status: 'opened', chatId: String(chat.id), model };
  };
}

export const openStoredChat = createStoredChatNavigator({
  getScope: () => {
    const auth = useAuthStore.getState();
    return {
      accountId: resolveAccountIdentity(auth)?.accountId ?? null,
      workspaceId: auth.workspaceId ? String(auth.workspaceId) : null,
      projectId: auth.projectId ? String(auth.projectId) : null,
    };
  },
  getChat: (chatId) => chatRepo.getById(chatId),
  restoreArchivedChat: async (chatId) => { await chatRepo.update(chatId, { archived: false }); },
  restoreExactModel: (connection) => {
    useAuthStore
      .getState()
      .setChatModelSelection(
        selectionFromOption(
          connection.providerId as ProviderId,
          connection.modelId ?? '',
          connection,
        ),
      );
  },
  readStoredEngine: (chatId) => {
    const state = browserChatStore.getState();
    return {
      engine: resolveChatEngine(state, chatId),
      providerId: state.chatPreferences[chatId]?.providerId ?? state.providerId,
    };
  },
  restoreExactEngine: (chatId, identity) => {
    const state = browserChatStore.getState();
    state.setProvider(identity.providerId, chatId);
    state.setEngine(identity.engine, chatId);
  },
  activateAndRoute: (chatId, projectId) => {
    useAuthStore.getState().setProjectId(projectId);
    useUIStore.setState({ activeChatId: chatId, route: 'chat' });
  },
});

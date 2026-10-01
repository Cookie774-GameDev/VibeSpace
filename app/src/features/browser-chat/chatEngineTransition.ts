import { createChatInScope } from '@/features/chat/chatLifecycle';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ChatId } from '@/types';
import {
  browserChatStore,
  findExclusiveBrowserChatId,
  resolveChatEngine,
  type VibeSpaceChatEngine,
} from './browserChatStore';
import { captureSyncQueueOwner, type SyncQueueOwnerSnapshot } from '@/lib/cloudSyncQueueOwner';
import type { AccountIdentity } from '@/lib/accountIdentity';

export const CHAT_ENGINE_OPTIONS = [
  {
    id: 'native',
    label: 'VibeSpace Chat',
    description: 'Models, local AI, agents, files, tools, voice, and Prompt Forge.',
  },
  {
    id: 'browser',
    label: 'Browser Chat',
    description: 'Real ChatGPT in an isolated VibeSpace browser surface.',
  },
] as const satisfies ReadonlyArray<{
  id: VibeSpaceChatEngine;
  label: string;
  description: string;
}>;

export interface ChatEngineTransitionDependencies {
  countMessages(chatId: string): Promise<number>;
  createChat(
    scope: ChatEngineTransitionScope,
    canCommit: () => boolean,
    beforeActivate: (chatId: string) => boolean,
  ): Promise<string | null>;
  getEngine(chatId: string): VibeSpaceChatEngine;
  getScope(chatId: string): ChatEngineTransitionScope | null;
  reuseEmptyChat(chatId: string, mutation: () => boolean): Promise<boolean>;
  setEngine(engine: VibeSpaceChatEngine, chatId: string): void;
  findExistingBrowserChat?(targetEngine: VibeSpaceChatEngine): string | null;
  activateChat?(chatId: string): void;
}

export interface ChatEngineTransitionScope {
  readonly accountId: string;
  readonly accountSource: AccountIdentity['source'];
  readonly syncOwner: SyncQueueOwnerSnapshot;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly activeChatId: string;
}

export interface ChatEngineTransitionInput {
  readonly chatId: string;
  readonly targetEngine: VibeSpaceChatEngine;
}

export type ChatEngineTransitionResult = {
  readonly status: 'unchanged' | 'reused' | 'created' | 'failed';
  readonly chatId: string;
  readonly engine: VibeSpaceChatEngine;
};

export function storedChatEngine(chatId: string): VibeSpaceChatEngine {
  return resolveChatEngine(browserChatStore.getState(), chatId);
}

const defaultDependencies: ChatEngineTransitionDependencies = {
  countMessages: (chatId) => messageRepo.countByChat(chatId as ChatId),
  createChat: (scope, canCommit, beforeActivate) =>
    createChatInScope({
      accountId: scope.accountId,
      accountSource: scope.accountSource,
      syncOwner: scope.syncOwner,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      isScopeCurrent: () =>
        canCommit() && scopesMatch(scope, defaultDependencies.getScope(scope.activeChatId)),
      beforeActivate,
    }),
  getEngine: storedChatEngine,
  findExistingBrowserChat: (targetEngine) =>
    targetEngine === 'browser'
      ? findExclusiveBrowserChatId(browserChatStore.getState(), 'chatgpt')
      : null,
  activateChat: (chatId) => useUIStore.getState().setActiveChat(chatId),
  getScope: () => {
    const auth = useAuthStore.getState();
    const identity = resolveAccountIdentity(auth);
    const syncOwner = captureSyncQueueOwner();
    const activeChatId = useUIStore.getState().activeChatId;
    if (
      !identity ||
      !auth.workspaceId ||
      !activeChatId ||
      (identity.source === 'supabase'
        ? syncOwner.state !== 'cloud' || syncOwner.userId !== identity.accountId
        : syncOwner.state !== 'unbound')
    ) {
      return null;
    }
    return {
      accountId: identity.accountId,
      accountSource: identity.source,
      syncOwner,
      workspaceId: String(auth.workspaceId),
      projectId: auth.projectId ? String(auth.projectId) : null,
      activeChatId: String(activeChatId),
    };
  },
  reuseEmptyChat: (chatId, mutation) => messageRepo.mutateIfChatEmpty(chatId as ChatId, mutation),
  setEngine: (engine, chatId) => browserChatStore.getState().setEngine(engine, chatId),
};

function scopesMatch(
  source: ChatEngineTransitionScope,
  current: ChatEngineTransitionScope | null,
): boolean {
  return (
    current !== null &&
    current.accountId === source.accountId &&
    current.accountSource === source.accountSource &&
    current.workspaceId === source.workspaceId &&
    current.projectId === source.projectId &&
    current.activeChatId === source.activeChatId
  );
}

export function createChatEngineTransition(dependencies: ChatEngineTransitionDependencies) {
  type PendingIntent = {
    targetEngine: VibeSpaceChatEngine;
    promise: Promise<ChatEngineTransitionResult>;
  };
  const inFlight = new Map<string, PendingIntent>();

  return (input: ChatEngineTransitionInput): Promise<ChatEngineTransitionResult> => {
    const pendingIntent = inFlight.get(input.chatId);
    if (pendingIntent) {
      pendingIntent.targetEngine = input.targetEngine;
      return pendingIntent.promise;
    }

    const currentEngine = dependencies.getEngine(input.chatId);
    if (currentEngine === input.targetEngine) {
      return Promise.resolve({
        status: 'unchanged',
        chatId: input.chatId,
        engine: currentEngine,
      });
    }

    if (input.targetEngine === 'browser') {
      const existing = dependencies.findExistingBrowserChat?.(input.targetEngine);
      if (existing && existing !== input.chatId) {
        dependencies.activateChat?.(existing);
        return Promise.resolve({
          status: 'reused',
          chatId: existing,
          engine: 'browser',
        });
      }
    }

    const sourceScope = dependencies.getScope(input.chatId);
    if (!sourceScope || sourceScope.activeChatId !== input.chatId) {
      return Promise.resolve({
        status: 'failed',
        chatId: input.chatId,
        engine: currentEngine,
      });
    }

    const intent = {} as PendingIntent;
    intent.targetEngine = input.targetEngine;
    intent.promise = (async (): Promise<ChatEngineTransitionResult> => {
      let activeChatId = input.chatId;
      let result: ChatEngineTransitionResult = {
        status: 'failed',
        chatId: input.chatId,
        engine: currentEngine,
      };
      while (true) {
        const targetEngine = intent.targetEngine;
        result = await runTransition(
          activeChatId,
          targetEngine,
          () => intent.targetEngine === targetEngine,
        );
        if (intent.targetEngine === targetEngine) return result;
        activeChatId =
          result.status === 'created' || result.status === 'reused' ? result.chatId : activeChatId;
      }
    })().finally(() => {
      inFlight.delete(input.chatId);
    });
    inFlight.set(input.chatId, intent);
    return intent.promise;

    async function runTransition(
      chatId: string,
      targetEngine: VibeSpaceChatEngine,
      isLatestIntent: () => boolean,
    ): Promise<ChatEngineTransitionResult> {
      const iterationEngine = dependencies.getEngine(chatId);
      if (iterationEngine === targetEngine) {
        return {
          status: 'unchanged',
          chatId,
          engine: iterationEngine,
        };
      }
      const iterationScope = dependencies.getScope(chatId);
      if (!iterationScope || iterationScope.activeChatId !== chatId) {
        return {
          status: 'failed',
          chatId,
          engine: iterationEngine,
        };
      }
      try {
        const messageCount = await dependencies.countMessages(chatId);
        if (!isLatestIntent()) {
          return { status: 'failed', chatId, engine: iterationEngine };
        }
        if (!scopesMatch(iterationScope, dependencies.getScope(chatId))) {
          return {
            status: 'failed',
            chatId,
            engine: iterationEngine,
          };
        }

        if (messageCount === 0) {
          const reused = await dependencies.reuseEmptyChat(chatId, () => {
            if (!isLatestIntent() || !scopesMatch(iterationScope, dependencies.getScope(chatId))) {
              return false;
            }
            dependencies.setEngine(targetEngine, chatId);
            return true;
          });
          if (reused) {
            return {
              status: 'reused',
              chatId,
              engine: targetEngine,
            };
          }
          if (!isLatestIntent()) {
            return { status: 'failed', chatId, engine: iterationEngine };
          }
          if (!scopesMatch(iterationScope, dependencies.getScope(chatId))) {
            return {
              status: 'failed',
              chatId,
              engine: iterationEngine,
            };
          }
        }

        let committedChatId: string | null = null;
        const canCommit = () =>
          isLatestIntent() && scopesMatch(iterationScope, dependencies.getScope(chatId));
        const newChatId = await dependencies.createChat(
          iterationScope,
          canCommit,
          (candidateChatId) => {
            if (!canCommit()) return false;
            dependencies.setEngine(targetEngine, candidateChatId);
            committedChatId = candidateChatId;
            return true;
          },
        );
        if (!newChatId || committedChatId !== newChatId) {
          return {
            status: 'failed',
            chatId,
            engine: iterationEngine,
          };
        }
        return {
          status: 'created',
          chatId: newChatId,
          engine: targetEngine,
        };
      } catch {
        return {
          status: 'failed',
          chatId,
          engine: iterationEngine,
        };
      }
    }
  };
}

export const transitionChatEngine = createChatEngineTransition(defaultDependencies);

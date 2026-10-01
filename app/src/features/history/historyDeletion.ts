const MAX_HISTORY_DELETE = 200;

interface HistoryChatOwnership {
  id: unknown;
  workspace_id: unknown;
}

export interface HistoryDeletionRemoveOutcome {
  localDeleted: true;
  syncQueued: boolean;
}

export interface HistoryDeletionResult {
  deletedIds: string[];
  failedId?: string;
  degradedId?: string;
  error?: string;
}

export function historyDeletionFeedback(
  result: HistoryDeletionResult,
  selectedChatId: string | null,
): {
  clearSelection: boolean;
  tone: 'success' | 'error';
  title: string;
  message: string;
} {
  const count = result.deletedIds.length;
  const clearSelection = selectedChatId !== null && result.deletedIds.includes(selectedChatId);
  if (result.error) {
    return {
      clearSelection,
      tone: 'error',
      title: count > 0 ? 'History partially cleared' : 'Could not delete history',
      message:
        count > 0 ? `${count} deleted before stopping safely. ${result.error}` : result.error,
    };
  }
  return {
    clearSelection,
    tone: 'success',
    title: count === 1 ? 'Chat removed' : 'History cleared',
    message: `${count} ${count === 1 ? 'chat' : 'chats'} deleted.`,
  };
}

export async function deleteHistoryChats(
  chatIds: readonly string[],
  ports: {
    expectedAccountId: string;
    expectedWorkspaceId: string;
    getActiveAccountId(): string | null;
    getActiveWorkspaceId(): string | null;
    read(chatId: string): Promise<HistoryChatOwnership | undefined>;
    remove(chatId: string): Promise<void | HistoryDeletionRemoveOutcome>;
  },
): Promise<HistoryDeletionResult> {
  const unique = [...new Set(chatIds)];
  if (unique.length > MAX_HISTORY_DELETE) {
    throw new Error('Too many history rows were selected for one clear operation.');
  }
  const deletedIds: string[] = [];
  const authorityError = (): string | null => {
    if (ports.getActiveAccountId() !== ports.expectedAccountId) {
      return 'The active account changed; remaining chats were not deleted.';
    }
    if (ports.getActiveWorkspaceId() !== ports.expectedWorkspaceId) {
      return 'The active workspace changed; remaining chats were not deleted.';
    }
    return null;
  };
  for (const chatId of unique) {
    try {
      const beforeReadError = authorityError();
      if (beforeReadError) throw new Error(beforeReadError);
      const chat = await ports.read(chatId);
      if (!chat) throw new Error('The chat no longer exists.');
      if (String(chat.workspace_id) !== ports.expectedWorkspaceId) {
        throw new Error('The chat does not belong to the reviewed workspace.');
      }
      const beforeRemoveError = authorityError();
      if (beforeRemoveError) throw new Error(beforeRemoveError);
      try {
        const removeOutcome = await ports.remove(chatId);
        deletedIds.push(chatId);
        if (removeOutcome?.localDeleted && !removeOutcome.syncQueued) {
          return {
            deletedIds,
            degradedId: chatId,
            error:
              'The chat was deleted locally, but cloud synchronization could not be confirmed.',
          };
        }
      } catch (removeError) {
        const beforeRecoveryReadError = authorityError();
        if (beforeRecoveryReadError) throw new Error(beforeRecoveryReadError);
        let remaining: HistoryChatOwnership | undefined;
        try {
          remaining = await ports.read(chatId);
        } catch {
          throw removeError;
        }
        if (remaining) throw removeError;
        deletedIds.push(chatId);
        return {
          deletedIds,
          degradedId: chatId,
          error: 'The chat was deleted locally, but cloud synchronization could not be confirmed.',
        };
      }
    } catch (error) {
      return {
        deletedIds,
        failedId: chatId,
        error: error instanceof Error ? error.message : 'The delete operation failed safely.',
      };
    }
  }
  return { deletedIds };
}

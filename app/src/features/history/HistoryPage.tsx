import * as React from 'react';
import { HistoryList } from './HistoryList';
import { Replay } from './Replay';
import type { ChatId } from '@/types';
import './sakura-history.css';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { openStoredChat } from './openStoredChat';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';

/**
 * Top-level Session History page.
 *
 * Two-pane layout:
 *   - 320px left rail: scrollable list of past chats (search + project chips).
 *   - Right pane: replay surface with scrubber + cozy bubble stack.
 *
 * Selection lives here so the rail and the replay stay in sync without
 * pushing through the global UI store. We deliberately do *not* persist
 * the selection — fresh page open lands on "pick a chat".
 */
export function HistoryPage() {
  const historyScope = useAuthStore((state) => JSON.stringify([
    resolveAccountIdentity(state)?.accountId ?? null, state.workspaceId ?? null, state.projectId ?? null,
  ]));
  const [selectedChatId, setSelectedChatId] = React.useState<ChatId | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = React.useState<string | null>(null);
  const [selectionScope, setSelectionScope] = React.useState(historyScope);
  const visibleChatId = selectionScope === historyScope ? selectedChatId : null;
  const visibleSnapshotId = selectionScope === historyScope ? selectedSnapshotId : null;
  const openBrowserChat = async (chatId: ChatId) => {
    browserChatStore.getState().setEngine('browser', chatId);
    const result = await openStoredChat(chatId);
    if (result.status !== 'opened' && result.status !== 'superseded') {
      toast.error('Chat not opened', 'The saved chat could not be restored. Please try again.');
    }
  };

  return (
    <div
      data-monochrome-route="history"
      data-warm-state={visibleChatId ? 'selected' : 'empty'}
      className="flex h-full w-full overflow-hidden bg-background text-foreground [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&>div]:border-border-mid"
    >
      <HistoryList
        selectedChatId={visibleChatId}
        selectedSnapshotId={visibleSnapshotId}
        onSelectChat={(chatId) => {
          setSelectionScope(historyScope);
          setSelectedChatId(chatId);
          if (chatId) setSelectedSnapshotId(null);
        }}
        onSelectSnapshot={(snapshotId) => {
          setSelectionScope(historyScope);
          setSelectedSnapshotId(snapshotId);
          if (snapshotId) setSelectedChatId(null);
        }}
        onOpenBrowserChat={openBrowserChat}
      />
      <div data-warm-surface="history-replay" className="min-w-0 flex-1">
        <Replay chatId={visibleChatId} snapshotId={visibleSnapshotId} />
      </div>
    </div>
  );
}

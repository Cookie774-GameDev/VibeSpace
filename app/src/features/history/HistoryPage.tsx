import * as React from 'react';
import { HistoryList } from './HistoryList';
import { Replay } from './Replay';
import type { ChatId } from '@/types';
import './sakura-history.css';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { openStoredChat } from './openStoredChat';
import { toast } from '@/components/ui/toast';

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
  const [selectedChatId, setSelectedChatId] = React.useState<ChatId | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = React.useState<string | null>(null);
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
      data-warm-state={selectedChatId ? 'selected' : 'empty'}
      className="flex h-full w-full overflow-hidden bg-background text-foreground [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&>div]:border-border-mid"
    >
      <HistoryList
        selectedChatId={selectedChatId}
        selectedSnapshotId={selectedSnapshotId}
        onSelectChat={(chatId) => {
          setSelectedChatId(chatId);
          if (chatId) setSelectedSnapshotId(null);
        }}
        onSelectSnapshot={(snapshotId) => {
          setSelectedSnapshotId(snapshotId);
          if (snapshotId) setSelectedChatId(null);
        }}
        onOpenBrowserChat={openBrowserChat}
      />
      <div data-warm-surface="history-replay" className="min-w-0 flex-1">
        <Replay chatId={selectedChatId} snapshotId={selectedSnapshotId} />
      </div>
    </div>
  );
}

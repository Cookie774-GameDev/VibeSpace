import * as React from 'react';
import { HistoryList } from './HistoryList';
import { Replay } from './Replay';
import type { ChatId } from '@/types';

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

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <HistoryList selectedChatId={selectedChatId} onSelectChat={setSelectedChatId} />
      <div className="min-w-0 flex-1">
        <Replay chatId={selectedChatId} />
      </div>
    </div>
  );
}

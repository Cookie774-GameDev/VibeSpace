import { TooltipProvider } from '@/components/ui';
import { useUIStore } from '@/stores/ui';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { EmptyChat } from './EmptyChat';

/**
 * Top-level wrapper for the chat surface. Reads `activeChatId` from the UI store
 * and renders either the empty state or thread + composer.
 */
export function ChatView() {
  const activeChatId = useUIStore((s) => s.activeChatId);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full w-full flex-col bg-background">
        {activeChatId ? (
          <>
            <ChatThread chatId={activeChatId} />
            <Composer chatId={activeChatId} />
          </>
        ) : (
          <EmptyChat />
        )}
      </div>
    </TooltipProvider>
  );
}

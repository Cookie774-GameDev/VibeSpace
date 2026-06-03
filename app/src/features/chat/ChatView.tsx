import { useState } from 'react';
import { TooltipProvider } from '@/components/ui';
import { useUIStore } from '@/stores/ui';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { EmptyChat } from './EmptyChat';
import { cn } from '@/lib/utils';
import { CONTEXT_MIME } from '@/features/context/tree';

const TERMINAL_MIME = 'application/x-jarvis-terminal';
type DropKind = 'terminal' | 'context' | 'file';

/**
 * Top-level wrapper for the chat surface. Reads `activeChatId` from the UI store
 * and renders either the empty state or thread + composer.
 */
export function ChatView() {
  const activeChatId = useUIStore((s) => s.activeChatId);
  const [dropKind, setDropKind] = useState<DropKind | null>(null);

  return (
    <TooltipProvider delayDuration={400}>
      <div
        data-terminal-drop={activeChatId ? 'chat' : undefined}
        data-terminal-drop-chat-id={activeChatId ?? undefined}
        onDragOver={(e) => {
          if (!activeChatId) return;
          const hasFilePath = e.dataTransfer.types.includes('application/x-jarvis-file')
            || (!e.dataTransfer.types.includes(CONTEXT_MIME) && !e.dataTransfer.types.includes(TERMINAL_MIME) && e.dataTransfer.types.includes('text/plain'));
          const nextKind = hasFilePath
            ? 'file'
            : e.dataTransfer.types.includes(CONTEXT_MIME)
            ? 'context'
            : e.dataTransfer.types.includes(TERMINAL_MIME)
              ? 'terminal'
              : null;
          if (!nextKind) return;
          e.preventDefault();
          setDropKind(nextKind);
        }}
        onDragLeave={() => setDropKind(null)}
        onDrop={(e) => {
          if (!activeChatId) return;
          const filePath = e.dataTransfer.getData('application/x-jarvis-file');
          const contextRaw = e.dataTransfer.getData(CONTEXT_MIME);
          const raw = e.dataTransfer.getData(TERMINAL_MIME);
          const path = filePath || (!contextRaw && !raw ? e.dataTransfer.getData('text/plain') : '');
          if (!contextRaw && !raw && !path) return;
          e.preventDefault();
          e.stopPropagation();
          setDropKind(null);
          if (path) {
            window.dispatchEvent(new CustomEvent('jarvis:file:attach', { detail: { path, chatId: activeChatId } }));
          } else if (contextRaw) {
            window.dispatchEvent(new CustomEvent('jarvis:context:attach', { detail: { raw: contextRaw, chatId: activeChatId } }));
          } else {
            window.dispatchEvent(new CustomEvent('jarvis:terminal:attach', { detail: { raw, chatId: activeChatId } }));
          }
        }}
        className={cn(
          'relative flex h-full w-full flex-col bg-background transition-shadow',
          dropKind && 'ring-inset ring-2 ring-accent-copper/50',
        )}
      >
        {dropKind && (
          <div className="pointer-events-none absolute right-4 top-4 z-10 rounded-md border border-accent-copper/50 bg-background/95 px-3 py-1 text-metadata text-accent-copper shadow-soft">
            Drop {dropKind === 'context' ? 'Context' : dropKind === 'terminal' ? 'terminal' : 'file path'} here to power up this chat
          </div>
        )}
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

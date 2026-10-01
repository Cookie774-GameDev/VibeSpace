import { useEffect, useState } from 'react';
import { TooltipProvider } from '@/components/ui';
import { useUIStore } from '@/stores/ui';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { EmptyChat } from './EmptyChat';
import { ensureActiveChat } from './chatLifecycle';
import { cn } from '@/lib/utils';
import {
  dispatchMediaAttach,
  getChatDragKind,
  getChatDropPayload,
  type ChatDropKind,
} from './dropPayload';
import { OrigamiChatDecor } from './OrigamiChatDecor';
import { MONOCHROME_CHAT_FIXTURE } from './monochromeFixture';
import { TokenBossCinematic } from './token-boss/TokenBossCinematic';
import { WarmChatWelcome } from './WarmChatWelcome';
import { ChatOutputPanel } from './ChatOutputPanel';
import { BrowserGoalStatus } from '@/features/browser/BrowserGoalStatus';
import { BrowserChatHub, resolveChatEngine, useBrowserChatStore } from '@/features/browser-chat';
import './sakura-chat.css';
import './chat-welcome.css';

/**
 * Top-level chat surface. Move chats into the Pet panel via right-click on a tab
 * (TabStrip) — no permanent "Move to Pet" button clutter.
 */
export function ChatView() {
  const storedActiveChatId = useUIStore((s) => s.activeChatId);
  const isVisualEmptyChat = document.documentElement.dataset.monochromeChatState === 'empty-state';
  const visualChatFixture =
    document.documentElement.dataset.monochromeChatFixture === 'chat'
      ? MONOCHROME_CHAT_FIXTURE
      : undefined;
  const activeChatId = visualChatFixture?.activeConversationId ?? storedActiveChatId;
  const engine = useBrowserChatStore((state) => resolveChatEngine(state, activeChatId));
  const canShowChatWelcome = Boolean(activeChatId);
  const [dropKind, setDropKind] = useState<ChatDropKind | null>(null);
  const [ensuringChat, setEnsuringChat] = useState(false);
  const [ensureFailed, setEnsureFailed] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

  useEffect(() => {
    const onOutput = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string }>).detail;
      if (!activeChatId) return;
      if (detail?.chatId && String(detail.chatId) !== String(activeChatId)) return;
      setOutputOpen(true);
    };
    window.addEventListener('jarvis:chat:output', onOutput as EventListener);
    return () => window.removeEventListener('jarvis:chat:output', onOutput as EventListener);
  }, [activeChatId]);

  useEffect(() => {
    if (engine === 'browser' || activeChatId || isVisualEmptyChat) return;
    let cancelled = false;
    setEnsuringChat(true);
    setEnsureFailed(false);
    void ensureActiveChat()
      .then((id) => {
        if (!cancelled && !id) setEnsureFailed(true);
      })
      .catch(() => {
        if (!cancelled) setEnsureFailed(true);
      })
      .finally(() => {
        if (!cancelled) setEnsuringChat(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, engine, isVisualEmptyChat]);

  if (engine === 'browser' && activeChatId) {
    return (
      <TooltipProvider delayDuration={400}>
        <BrowserChatHub chatId={activeChatId} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div
        data-vibespace-page="chat"
        data-monochrome-surface="chat"
        data-sakura-surface="chat-route"
        data-terminal-drop={activeChatId ? 'chat' : undefined}
        data-terminal-drop-chat-id={activeChatId ?? undefined}
        onDragOver={(e) => {
          if (!activeChatId) return;
          const nextKind = getChatDragKind(e.dataTransfer.types);
          if (!nextKind) return;
          // Required for OS Files drops — without preventDefault the browser
          // rejects the drop and Composer never receives the FileList.
          e.preventDefault();
          e.dataTransfer.dropEffect = nextKind === 'os-files' ? 'copy' : 'link';
          setDropKind(nextKind);
        }}
        onDragLeave={() => setDropKind(null)}
        onDrop={(e) => {
          if (!activeChatId) return;
          const osFiles = e.dataTransfer.files;
          if (osFiles && osFiles.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setDropKind(null);
            dispatchMediaAttach(String(activeChatId), osFiles);
            return;
          }
          const payload = getChatDropPayload(e.dataTransfer);
          if (!payload) return;
          e.preventDefault();
          e.stopPropagation();
          setDropKind(null);
          if (payload.kind === 'context') {
            window.dispatchEvent(
              new CustomEvent('jarvis:context:attach', {
                detail: { raw: payload.raw, chatId: activeChatId },
              }),
            );
          } else if (payload.kind === 'terminal') {
            window.dispatchEvent(
              new CustomEvent('jarvis:terminal:attach', {
                detail: { raw: payload.raw, chatId: activeChatId },
              }),
            );
          } else {
            window.dispatchEvent(
              new CustomEvent('jarvis:file:attach', {
                detail: { path: payload.path, chatId: activeChatId },
              }),
            );
          }
        }}
        className={cn(
          'relative flex h-full w-full flex-col bg-background transition-shadow',
          '[[data-theme=monochrome]_&]:bg-background [[data-theme=monochrome]_&]:shadow-none [[data-theme=monochrome]_&]:transition-none',
          dropKind && 'ring-inset ring-2 ring-accent-copper/50',
        )}
      >
        <OrigamiChatDecor />
        {canShowChatWelcome ? <WarmChatWelcome chatId={String(activeChatId)} /> : null}
        {dropKind && (
          <div className="pointer-events-none absolute right-4 top-4 z-10 rounded-md border border-accent-copper/50 bg-background/95 px-3 py-1 text-metadata text-accent-copper shadow-soft [[data-theme=monochrome]_&]:rounded-sm [[data-theme=monochrome]_&]:border-border-mid [[data-theme=monochrome]_&]:bg-background [[data-theme=monochrome]_&]:shadow-none">
            Drop{' '}
            {dropKind === 'context'
              ? 'Context'
              : dropKind === 'terminal'
                ? 'terminal'
                : dropKind === 'os-files'
                  ? 'photos, videos, or files'
                  : 'file path'}{' '}
            here to power up this chat
          </div>
        )}
        {isVisualEmptyChat ? (
          <EmptyChat />
        ) : activeChatId ? (
          <>
            <ChatThread chatId={activeChatId} fixtureMessages={visualChatFixture?.messages} />
            <BrowserGoalStatus chatId={String(activeChatId)} />
            <Composer key={String(activeChatId)} chatId={activeChatId} />
            <TokenBossCinematic chatId={String(activeChatId)} />
            <ChatOutputPanel
              chatId={String(activeChatId)}
              open={outputOpen}
              onClose={() => setOutputOpen(false)}
            />
          </>
        ) : ensuringChat ? (
          <div className="flex flex-1 items-center justify-center text-secondary text-muted-foreground">
            Starting a conversation…
          </div>
        ) : (
          <EmptyChat />
        )}
        {!isVisualEmptyChat && ensureFailed && !activeChatId && !ensuringChat ? (
          <p className="px-4 pb-3 text-center text-metadata text-muted-foreground">
            Could not open a chat yet — workspace may still be loading.
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

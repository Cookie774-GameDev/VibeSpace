import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useChatMessages } from './hooks';
import { MessageBubble } from './MessageBubble';
import type { ChatId, Message, Part } from '@/types';

export interface ChatThreadProps {
  chatId: ChatId | string;
  compact?: boolean;
}

/**
 * Sum of streaming-text size across the message - used as a dependency
 * to keep the auto-scroll glued to bottom while tokens land.
 */
function streamingSize(message: Message | undefined): number {
  if (!message) return 0;
  let n = 0;
  for (const p of message.parts as Part[]) {
    if (p.kind === 'text' || p.kind === 'reasoning' || p.kind === 'stack_step') n += p.text.length;
    else if (p.kind === 'tool_call') n += JSON.stringify(p.args).length;
    else if (p.kind === 'tool_result') n += JSON.stringify(p.result ?? p.error ?? '').length;
  }
  return n;
}

/**
 * The scroll container. Auto-scrolls to bottom on new messages and during
 * streaming - but only if the user is already near the bottom. If the user
 * has scrolled up to read history, we do not yank them.
 */
export function ChatThread({ chatId, compact = false }: ChatThreadProps) {
  const messages = useChatMessages(chatId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

  const tailSize = streamingSize(messages[messages.length - 1]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = distFromBottom < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, tailSize]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <div className={compact ? 'w-full px-2 py-3 flex flex-col gap-3' : 'mx-auto w-full max-w-[860px] px-4 py-6 flex flex-col gap-4'}>
        {messages.length === 0 ? (
          <ThreadHint />
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} compact={compact} />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function ThreadHint() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="rounded-full border border-border bg-elevated p-3">
        <Sparkles className="h-5 w-5 text-accent-cyan" />
      </div>
      <div className="text-ui-strong text-foreground">No messages yet</div>
      <div className="text-secondary text-muted-foreground max-w-[44ch]">
        Type below to start the conversation. Use <span className="kbd">@</span> to mention an
        agent or <span className="kbd">{'\u2318'}</span>+
        <span className="kbd">Enter</span> to send.
      </div>
    </div>
  );
}

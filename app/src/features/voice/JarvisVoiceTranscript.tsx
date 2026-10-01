import * as React from 'react';
import { Bot, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';

function messageText(message: Message): string {
  return message.parts
    .filter(
      (part): part is Extract<Message['parts'][number], { kind: 'text' }> => part.kind === 'text',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function JarvisVoiceTranscript({
  messages,
  partial,
  hasBoundChat,
  expandedIds,
  onToggleExpanded,
}: {
  messages: readonly Message[];
  partial: string;
  hasBoundChat: boolean;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (messageId: string) => void;
}) {
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const stickyRef = React.useRef(true);
  const transcript = messages
    .filter(
      (message) =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'agent',
    )
    .map((message) => ({ ...message, displayText: messageText(message) }))
    .filter((message) => message.displayText)
    .slice(-8);

  React.useEffect(() => {
    const node = transcriptRef.current;
    if (node && stickyRef.current) node.scrollTop = node.scrollHeight;
  }, [messages, partial]);

  return (
    <div
      ref={transcriptRef}
      role="log"
      aria-label="Voice session transcript"
      aria-live="off"
      data-no-panel-drag="true"
      onScroll={() => {
        const node = transcriptRef.current;
        if (!node) return;
        stickyRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      className="max-h-[28vh] space-y-1 overflow-y-auto px-2 pb-2 pt-1"
    >
      {transcript.length === 0 && !partial ? (
        <div className="flex min-h-7 items-center justify-center text-center text-xs leading-4 text-muted-foreground">
          {hasBoundChat ? 'Listening...' : 'Open a chat first.'}
        </div>
      ) : null}
      {transcript.map((message) => {
        const user = message.role === 'user';
        const expandable =
          message.displayText.length > 96 || message.displayText.split(/\r?\n/u).length > 2;
        const expanded = expandedIds.has(message.id);
        return (
          <div
            key={message.id}
            className="grid grid-cols-[1.5rem_2.75rem_minmax(0,1fr)_auto] items-start gap-2 text-xs leading-5"
          >
            <span
              className={cn(
                'mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border',
                user ? 'border-info/80 text-info' : 'border-accent-copper/80 text-accent-copper',
              )}
              aria-hidden="true"
            >
              {user ? <UserRound className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
            </span>
            <span className="pt-0.5 font-medium text-foreground">{user ? 'You' : 'Jarvis'}</span>
            <span className="min-w-0 text-foreground/85">
              <span
                className={cn(
                  'block whitespace-pre-wrap break-words',
                  expandable && !expanded && 'line-clamp-2',
                )}
              >
                {message.displayText}
              </span>
              {expandable ? (
                <button
                  type="button"
                  className="mt-0.5 inline-flex min-h-7 items-center rounded px-1 text-xs font-semibold text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={expanded}
                  onClick={() => onToggleExpanded(message.id)}
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              ) : null}
            </span>
            <time
              className="shrink-0 pt-0.5 text-[0.65rem] tabular-nums text-muted-foreground"
              dateTime={new Date(message.created_at).toISOString()}
            >
              {new Date(message.created_at).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </div>
        );
      })}
      {partial ? (
        <div className="grid grid-cols-[1.5rem_2.75rem_minmax(0,1fr)_auto] items-center gap-2 text-xs leading-5">
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full border border-info/80 text-info"
            aria-hidden="true"
          >
            <UserRound className="h-2 w-2" />
          </span>
          <span className="font-medium text-foreground">You</span>
          <span
            className="min-w-0 whitespace-pre-wrap break-words text-foreground/75"
            data-live-announcement="off"
          >
            {partial}
          </span>
        </div>
      ) : null}
    </div>
  );
}

import * as React from 'react';
import { MessageSquare, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import type { Chat } from '@/types/chat';
import { cn } from '@/lib/utils';
import { isChatPinned } from '@/features/chat/chatPin';
import { useChatPointerDrag } from '@/features/chat/useChatPointerDrag';
import {
  ChatListActivityIndicator,
  type ChatActivityEvent,
  type ChatListRunSignal,
} from '@/features/chat/activity';
import {
  CHAT_OPEN_BESIDE_EVENT,
  CHAT_SEND_CONTEXT_EVENT,
  writeChatDragPayload,
} from '@/features/chat/chatDragPayload';

export interface ChatNavRowProps {
  chat: Chat;
  navOpen: boolean;
  active?: boolean;
  activityRuns?: readonly ChatListRunSignal[];
  activityEvents?: readonly ChatActivityEvent[];
  onOpen: () => void;
  onTogglePin: () => void;
}

function actionDetail(chat: Chat) {
  return {
    version: 1 as const,
    chatId: String(chat.id),
    workspaceId: String(chat.workspace_id),
    projectId: chat.project_id ? String(chat.project_id) : null,
    title: (chat.title || 'Untitled chat').trim() || 'Untitled chat',
  };
}

export function ChatNavRow({
  chat,
  navOpen,
  active,
  activityRuns = [],
  activityEvents = [],
  onOpen,
  onTogglePin,
}: ChatNavRowProps) {
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const label = (chat.title || 'Untitled chat').trim() || 'Untitled chat';
  const pinned = isChatPinned(chat);
  const dragProps = {
    ...useChatPointerDrag(chat),
    'data-testid': `chat-nav-row-${String(chat.id)}`,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      writeChatDragPayload(event.dataTransfer, chat);
      event.dataTransfer.effectAllowed = 'link';
    },
    style: { userSelect: 'none' as const },
  };

  if (!navOpen) {
    return (
      <button
        {...dragProps}
        type="button"
        onClick={onOpen}
        title={pinned ? `${label} (pinned)` : label}
        aria-label={pinned ? `${label}, pinned` : label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
          active &&
            'bg-muted ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
        )}
      >
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        {pinned ? (
          <Pin className="absolute right-1 top-1 h-2 w-2 fill-accent-copper text-accent-copper" />
        ) : null}
      </button>
    );
  }

  return (
    <div
      {...dragProps}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-7 w-full items-center gap-0.5 rounded-md pr-0.5 transition-colors',
        'hover:bg-muted',
        active &&
          'bg-muted ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring [html[data-theme=sakura]_&]:min-h-6"
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      <ChatListActivityIndicator runs={activityRuns} events={activityEvents} />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin();
        }}
        aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
        aria-pressed={pinned}
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:bg-background/80 hover:text-accent-copper',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          pinned && 'opacity-100 text-accent-copper',
        )}
      >
        {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
      </button>
      <button
        type="button"
        aria-label={`Chat actions for ${label}`}
        aria-expanded={actionsOpen}
        onClick={(event) => {
          event.stopPropagation();
          setActionsOpen((open) => !open);
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-background/80 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {actionsOpen ? (
        <div
          role="menu"
          aria-label={`Actions for ${label}`}
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-border bg-panel p-1 shadow-soft"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-sm px-2 py-1.5 text-left text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent(CHAT_SEND_CONTEXT_EVENT, { detail: actionDetail(chat) }),
              );
              setActionsOpen(false);
            }}
          >
            Send context to current chat
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-sm px-2 py-1.5 text-left text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent(CHAT_OPEN_BESIDE_EVENT, { detail: actionDetail(chat) }),
              );
              setActionsOpen(false);
            }}
          >
            Open beside current chat
          </button>
        </div>
      ) : null}
    </div>
  );
}

import * as React from 'react';
import { MessageSquare, Pin, PinOff } from 'lucide-react';
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
  readScope?: string;
  onOpen: () => void;
  onTogglePin: () => void;
  onFork?: () => void;
  onDelete?: () => void;
}

type ReadState = { acknowledgedThrough: number; lastCompletionAt: number; manualUnread: boolean };
const emptyReadState = (): ReadState => ({
  acknowledgedThrough: 0,
  lastCompletionAt: 0,
  manualUnread: false,
});

function readState(key: string): ReadState {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(key) || 'null',
    ) as Partial<ReadState> | null;
    return {
      acknowledgedThrough: Number.isFinite(value?.acknowledgedThrough)
        ? value!.acknowledgedThrough!
        : 0,
      lastCompletionAt: Number.isFinite(value?.lastCompletionAt) ? value!.lastCompletionAt! : 0,
      manualUnread: value?.manualUnread === true,
    };
  } catch {
    return emptyReadState();
  }
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
  readScope = 'local',
  onOpen,
  onTogglePin,
  onFork,
  onDelete,
}: ChatNavRowProps) {
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const storageKey = `vibespace:chat-read:${readScope}:${String(chat.id)}`;
  const [read, setRead] = React.useState<ReadState>(() => readState(storageKey));
  React.useEffect(() => setRead(readState(storageKey)), [storageKey]);
  const updateRead = (next: ReadState) => {
    setRead(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* private storage */
    }
  };
  const label = (chat.title || 'Untitled chat').trim() || 'Untitled chat';
  const latestActivityAt = Math.max(
    0,
    ...activityRuns
      .filter((run) => run.chatId === String(chat.id))
      .map((run) =>
        typeof run.updatedAt === 'number'
          ? Number.isFinite(run.updatedAt)
            ? run.updatedAt
            : 0
          : Date.parse(run.updatedAt ?? '') || 0,
      ),
    ...activityEvents
      .filter((event) => String(event.chatId) === String(chat.id))
      .map((event) => event.ts),
  );
  const latestCompletionAt = Math.max(
    0,
    ...activityRuns
      .filter(
        (run) =>
          run.chatId === String(chat.id) &&
          ['completed', 'complete', 'done', 'succeeded'].includes(run.status.toLowerCase()),
      )
      .map((run) =>
        typeof run.updatedAt === 'number' ? run.updatedAt : Date.parse(run.updatedAt ?? '') || 0,
      ),
    ...activityEvents
      .filter(
        (event) =>
          String(event.chatId) === String(chat.id) &&
          event.kind === 'agent' &&
          event.status === 'done',
      )
      .map((event) => event.ts),
  );
  React.useEffect(() => {
    if (active && (read.manualUnread || latestActivityAt > read.acknowledgedThrough)) {
      updateRead({
        acknowledgedThrough: Math.max(
          read.acknowledgedThrough,
          read.lastCompletionAt,
          latestActivityAt,
        ),
        lastCompletionAt: read.lastCompletionAt,
        manualUnread: false,
      });
    }
  }, [
    active,
    latestActivityAt,
    read.acknowledgedThrough,
    read.lastCompletionAt,
    read.manualUnread,
  ]);
  React.useEffect(() => {
    if (latestCompletionAt > read.lastCompletionAt) {
      updateRead({
        ...read,
        lastCompletionAt: latestCompletionAt,
        acknowledgedThrough: active
          ? Math.max(read.acknowledgedThrough, latestCompletionAt)
          : read.acknowledgedThrough,
        manualUnread: !active && latestCompletionAt > read.acknowledgedThrough,
      });
    }
  }, [
    active,
    latestCompletionAt,
    read.acknowledgedThrough,
    read.lastCompletionAt,
    read.manualUnread,
  ]);
  React.useEffect(() => {
    if (!actionsOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [actionsOpen]);
  const openChat = () => {
    updateRead({
      acknowledgedThrough: Math.max(
        read.acknowledgedThrough,
        read.lastCompletionAt,
        latestActivityAt,
      ),
      lastCompletionAt: read.lastCompletionAt,
      manualUnread: false,
    });
    setActionsOpen(false);
    onOpen();
  };
  const toggleRead = () => {
    updateRead(
      read.manualUnread || latestActivityAt > read.acknowledgedThrough
        ? {
            acknowledgedThrough: Math.max(
              read.acknowledgedThrough,
              read.lastCompletionAt,
              latestActivityAt,
            ),
            lastCompletionAt: read.lastCompletionAt,
            manualUnread: false,
          }
        : { ...read, manualUnread: true },
    );
    setActionsOpen(false);
  };
  const showMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setActionsOpen(true);
  };
  const keyboardMenu = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      setActionsOpen(true);
    }
  };
  const activityIndicator = (
    <ChatListActivityIndicator
      chatId={String(chat.id)}
      chatLabel={label}
      runs={activityRuns}
      events={activityEvents}
      acknowledgedThrough={
        active
          ? Math.max(read.acknowledgedThrough, read.lastCompletionAt, latestActivityAt)
          : read.acknowledgedThrough
      }
      forceUnread={!active && read.manualUnread}
    />
  );
  const pinned = isChatPinned(chat);
  const dragProps = {
    ...useChatPointerDrag(chat),
    'data-testid': `chat-nav-row-${String(chat.id)}`,
    onContextMenu: showMenu,
    onKeyDown: keyboardMenu,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      writeChatDragPayload(event.dataTransfer, chat);
      event.dataTransfer.effectAllowed = 'link';
    },
    style: { userSelect: 'none' as const },
  };

  const actionsMenu = actionsOpen ? (
    <div
      role="menu"
      aria-label={`Actions for ${label}`}
      className="absolute right-0 top-full z-40 mt-1 w-52 rounded-md border border-border bg-panel p-1 shadow-soft"
    >
      <button
        type="button"
        role="menuitem"
        className="w-full rounded-sm px-2 py-1.5 text-left text-secondary hover:bg-muted"
        onClick={toggleRead}
      >
        {read.manualUnread || latestActivityAt > read.acknowledgedThrough
          ? 'Mark as read'
          : 'Mark as unread'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="w-full rounded-sm px-2 py-1.5 text-left text-secondary hover:bg-muted"
        onClick={() => {
          onTogglePin();
          setActionsOpen(false);
        }}
      >
        {pinned ? 'Unpin chat' : 'Pin chat'}
      </button>
      {onFork ? (
        <button
          type="button"
          role="menuitem"
          className="w-full rounded-sm px-2 py-1.5 text-left text-secondary hover:bg-muted"
          onClick={() => {
            onFork();
            setActionsOpen(false);
          }}
        >
          Fork chat
        </button>
      ) : null}
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
      {onDelete ? (
        <button
          type="button"
          role="menuitem"
          className="w-full rounded-sm px-2 py-1.5 text-left text-destructive hover:bg-muted"
          onClick={() => {
            onDelete();
            setActionsOpen(false);
          }}
        >
          Delete chat…
        </button>
      ) : null}
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
  ) : null;

  if (!navOpen) {
    return (
      <div ref={menuRef} className="relative w-full">
        <button
          {...dragProps}
          type="button"
          onClick={openChat}
          title={pinned ? `${label} (pinned)` : label}
          aria-label={pinned ? `${label}, pinned` : label}
          aria-current={active ? 'page' : undefined}
          aria-haspopup="menu"
          className={cn(
            'relative flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
            'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
            active &&
              'bg-muted ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
          )}
        >
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="absolute -right-0.5 top-1/2 -translate-y-1/2">{activityIndicator}</span>
          {pinned ? (
            <Pin className="absolute right-1 top-1 h-2 w-2 fill-accent-copper text-accent-copper" />
          ) : null}
        </button>
        {actionsMenu}
      </div>
    );
  }

  return (
    <div
      {...dragProps}
      ref={menuRef}
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
        onClick={openChat}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring [html[data-theme=sakura]_&]:min-h-6"
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {activityIndicator}
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
      {actionsMenu}
    </div>
  );
}

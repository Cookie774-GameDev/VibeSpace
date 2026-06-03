/**
 * TabStrip — Arc-style chat tabs above the canvas.
 *
 * Source of truth.
 *   The tab list is now a live projection of the chats table (via
 *   dexie-react-hooks), filtered to the active project so terminals
 *   and chats both "switch when I am in a different project". The
 *   previous version kept tabs in component state alone, which meant
 *   the strip and the nav sidebar fell out of sync — opening a chat
 *   from the sidebar didn't add a tab, and renaming via the sidebar
 *   left the tab title stale.
 *
 * Active tab.
 *   Mirrors `useUIStore.activeChatId`. We avoid a separate local
 *   `activeId` so the cross-component flow (sidebar click sets the
 *   id; the strip just reflects it) stays one-directional.
 *
 * Auto-tab-on-empty.
 *   When the list is empty we DON'T silently spawn a tab the way the
 *   old version did. With projects in the picture, "no chats" means
 *   "this project has no chats yet" — letting the user see that empty
 *   state is the friendlier behaviour. The "+" button at the right
 *   creates a chat in the active project on demand.
 *
 * Renaming.
 *   Double-click the tab title to enter inline edit mode. Enter
 *   commits, Escape cancels. Persists via `chatRepo.update`. The
 *   first AI reply will also auto-name the chat (see
 *   `lib/ai/runtime.ts`); manual edits take precedence.
 *
 * Hotkeys.
 *   Cmd+T new tab, Cmd+W close active tab, Cmd+1..9 switch by index.
 *   Reorder is gone for now — order is "newest updated first" in the
 *   query, which is what the user is asking for in practice. We can
 *   surface a dedicated `position` column later if explicit reorder
 *   becomes a recurring ask.
 */

import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { useHotkey, HOTKEYS } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { db, chatRepo } from '@/lib/db';
import { toast } from '@/components/ui/toast';
import type { Chat } from '@/types/chat';
import type { ChatId, WorkspaceId, ProjectId } from '@/types';
import { cn } from '@/lib/utils';

interface TabModel {
  id: ChatId;
  title: string;
}

const ROOT_PROJECT_KEY = '__root__';
const projectChatMemory = new Map<string, ChatId | null>();

function projectMemoryKey(projectId: ProjectId | null): string {
  return projectId ?? ROOT_PROJECT_KEY;
}

export function TabStrip() {
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  const activeChatId = useUIStore((s) => s.activeChatId);
  const setRoute = useUIStore((s) => s.setRoute);
  const setChatMode = useUIStore((s) => s.setChatMode);
  const route = useUIStore((s) => s.route);

  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const projectId = useAuthStore((s) => s.projectId) as ProjectId | null;

  // Live projection — same shape the nav sidebar uses, just trimmed
  // for the tab strip's narrow bar.
  const chats = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      const filtered = projectId
        ? rows.filter((c) => c.project_id === projectId)
        : rows.filter((c) => !c.project_id);
      return filtered.sort((a, b) => b.updated_at - a.updated_at).slice(0, 20);
    },
    [workspaceId, projectId],
    [] as Chat[],
  );

  const tabs: TabModel[] = React.useMemo(
    () =>
      (chats ?? []).map((c) => ({
        id: c.id,
        title: (c.title ?? '').trim() || 'Untitled chat',
      })),
    [chats],
  );

  const previousProjectRef = React.useRef<ProjectId | null>(projectId);

  React.useEffect(() => {
    const previousProjectId = previousProjectRef.current;
    if (previousProjectId === projectId) {
      projectChatMemory.set(projectMemoryKey(projectId), activeChatId as ChatId | null);
      return;
    }

    projectChatMemory.set(projectMemoryKey(previousProjectId), activeChatId as ChatId | null);
    previousProjectRef.current = projectId;

    const rememberedChatId = projectChatMemory.get(projectMemoryKey(projectId));
    if (rememberedChatId) {
      setActiveChat(rememberedChatId);
    }
  }, [projectId, activeChatId, setActiveChat]);

  // Detect when the active id falls outside the projected list (e.g.
  // the user switched projects). Clear the active id so the canvas
  // shows its empty state instead of silently keeping a hidden tab
  // selected.
  React.useEffect(() => {
    if (!activeChatId) {
      if (tabs.length > 0) setActiveChat(tabs[0].id);
      return;
    }
    const stillThere = tabs.some((t) => t.id === activeChatId);
    if (!stillThere) {
      setActiveChat(tabs[0]?.id ?? null);
    }
  }, [tabs, activeChatId, setActiveChat]);

  const handleSelect = React.useCallback(
    (id: ChatId) => {
      setActiveChat(id);
      // Clicking a tab should also flip the route to the chat surface
      // so a user who wandered into Terminals doesn't have to find
      // their way back via the sidebar.
      if (route !== 'chat') setRoute('chat');
    },
    [setActiveChat, route, setRoute],
  );

  const handleNewTab = React.useCallback(async () => {
    if (!workspaceId) {
      toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
      return;
    }
    try {
      const chat = await chatRepo.create({
        workspace_id: workspaceId,
        project_id: projectId ?? undefined,
        title: `New chat ${(chats?.length ?? 0) + 1}`,
        mode: 'chat',
        active_agent_ids: [],
      });
      setActiveChat(chat.id);
      setChatMode('chat');
      setRoute('chat');
    } catch (err) {
      toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
    }
  }, [workspaceId, projectId, chats, setActiveChat, setChatMode, setRoute]);

  const handleClose = React.useCallback(
    async (id: ChatId) => {
      // Determine the next active id BEFORE we mutate, so closing the
      // current tab feels responsive (no transient empty state).
      const idx = tabs.findIndex((t) => t.id === id);
      const fallback = tabs[idx + 1]?.id ?? tabs[idx - 1]?.id ?? null;
      try {
        await chatRepo.delete(id);
      } catch (err) {
        toast.error(
          'Could not close tab',
          err instanceof Error ? err.message : 'Try again.',
        );
        return;
      }
      if (id === activeChatId) {
        setActiveChat(fallback);
      }
    },
    [tabs, activeChatId, setActiveChat],
  );

  const handleRename = React.useCallback(async (id: ChatId, next: string) => {
    const trimmed = next.trim();
    if (trimmed.length === 0) return;
    try {
      await chatRepo.update(id, { title: trimmed });
    } catch (err) {
      toast.error('Could not rename', err instanceof Error ? err.message : 'Try again.');
    }
  }, []);

  const switchToIndex = React.useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (tab) handleSelect(tab.id);
    },
    [tabs, handleSelect],
  );

  // Hotkeys
  useHotkey(HOTKEYS.NEW_TAB, (e) => {
    e.preventDefault();
    void handleNewTab();
  });
  useHotkey(HOTKEYS.CLOSE_TAB, (e) => {
    e.preventDefault();
    if (activeChatId) void handleClose(activeChatId as ChatId);
  });
  useHotkey('Mod+1', (e) => {
    e.preventDefault();
    switchToIndex(0);
  });
  useHotkey('Mod+2', (e) => {
    e.preventDefault();
    switchToIndex(1);
  });
  useHotkey('Mod+3', (e) => {
    e.preventDefault();
    switchToIndex(2);
  });
  useHotkey('Mod+4', (e) => {
    e.preventDefault();
    switchToIndex(3);
  });
  useHotkey('Mod+5', (e) => {
    e.preventDefault();
    switchToIndex(4);
  });
  useHotkey('Mod+6', (e) => {
    e.preventDefault();
    switchToIndex(5);
  });
  useHotkey('Mod+7', (e) => {
    e.preventDefault();
    switchToIndex(6);
  });
  useHotkey('Mod+8', (e) => {
    e.preventDefault();
    switchToIndex(7);
  });
  useHotkey('Mod+9', (e) => {
    e.preventDefault();
    switchToIndex(8);
  });

  return (
    <div
      role="tablist"
      aria-label="Open chats"
      className="flex h-8 shrink-0 items-stretch gap-1 border-b border-border bg-panel px-2"
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto scrollbar-hidden">
        <AnimatePresence initial={false}>
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeChatId}
              onActivate={() => handleSelect(tab.id)}
              onClose={() => void handleClose(tab.id)}
              onRename={(next) => void handleRename(tab.id, next)}
            />
          ))}
        </AnimatePresence>
        {tabs.length === 0 && (
          <span className="self-center px-2 text-metadata text-muted-foreground">
            No chats in this project yet.
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center">
        <Hint label="New chat" hotkey="Mod+T">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void handleNewTab()}
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}

interface TabItemProps {
  tab: TabModel;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onRename: (next: string) => void;
}

function TabItem({ tab, active, onActivate, onClose, onRename }: TabItemProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(tab.title);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Sync the draft when the underlying title changes (e.g. AI auto-name).
  React.useEffect(() => {
    if (!editing) setDraft(tab.title);
  }, [tab.title, editing]);

  React.useEffect(() => {
    if (editing) {
      // Run after the input is in the DOM so .select() works.
      requestAnimationFrame(() => {
        inputRef.current?.select();
      });
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== tab.title) {
      onRename(draft);
    } else {
      setDraft(tab.title);
    }
  };

  const cancel = () => {
    setEditing(false);
    setDraft(tab.title);
  };

  return (
    <motion.div
      role="tab"
      aria-selected={active}
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      onClick={() => {
        if (!editing) onActivate();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={cn(
        'group flex h-7 max-w-[220px] shrink-0 cursor-default select-none items-center gap-1.5 self-center rounded-md border border-transparent px-2 text-secondary transition-colors',
        active
          ? 'bg-elevated text-foreground border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
      title={editing ? undefined : 'Double-click to rename'}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            } else {
              // Don't let typing into the rename input trigger global hotkeys.
              e.stopPropagation();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-secondary text-foreground outline-none"
          aria-label={`Rename ${tab.title}`}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      )}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity',
          'hover:bg-muted hover:text-foreground',
          active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </motion.div>
  );
}

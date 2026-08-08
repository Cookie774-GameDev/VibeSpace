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
 *   When a project has no chats yet we bootstrap one via
 *   `ensureActiveChat` so the user can start talking immediately.
 *   The "+" button still forces a brand-new tab on demand.
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
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { FileText, Pin, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { useBoundHotkey, HOTKEYS } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { db, chatRepo } from '@/lib/db';
import { toast } from '@/components/ui/toast';
import type { Chat } from '@/types/chat';
import type { ChatId, WorkspaceId, ProjectId } from '@/types';
import { cn } from '@/lib/utils';
import { ensureActiveChat } from '@/features/chat/chatLifecycle';
import { sortChatsForDisplay } from '@/features/chat/chatPin';
import { usePetPresentationStore } from '@/features/pets/petPresentationStore';
import { usePetSettingsStore } from '@/features/pets/petSettingsStore';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_CONTROL } from '@/lib/jarvis/smoke/evidenceIds';
import { useThemeMotionLayout, useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { ThoughtBloomTitle } from '@/features/rename-motion/ThoughtBloomTitle';
import { basename } from '@/features/files/projectFiles';
import { useFileWorkspace } from '@/features/files/fileWorkspaceStore';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

interface TabModel {
  id: ChatId;
  title: string;
  pinned?: boolean;
}

const ROOT_PROJECT_KEY = '__root__';
const projectChatMemory = new Map<string, ChatId | null>();
const LEGACY_TAB_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 400,
  damping: 30,
} as const);

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
  const setProjectId = useAuthStore((s) => s.setProjectId);
  const fileWorkspace = useFileWorkspace(projectId);

  // Live projection — same shape the nav sidebar uses, just trimmed
  // for the tab strip's narrow bar.
  const chats = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      const filtered = projectId
        ? rows.filter((c) => c.project_id === projectId)
        : rows.filter((c) => !c.project_id);
      return sortChatsForDisplay(filtered).slice(0, 20);
    },
    [workspaceId, projectId],
    [] as Chat[],
  );

  const tabs: TabModel[] = React.useMemo(
    () =>
      (chats ?? []).map((c) => ({
        id: c.id,
        title: (c.title ?? '').trim() || 'Untitled chat',
        pinned: Boolean(c.pinned),
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

  React.useEffect(() => {
    if (!workspaceId || activeChatId || tabs.length > 0) return;
    void ensureActiveChat({ navigateToChat: false });
  }, [workspaceId, activeChatId, tabs.length]);

  // Reconcile the active chat against the current project's tab list.
  //
  // The active chat can legitimately belong to a *different* project — e.g.
  // the user clicked "Open in Chat" from History, or jumped via the command
  // palette. The tab list here is project-scoped, so such a chat won't appear
  // in `tabs`. Previously we bumped `activeChatId` to `tabs[0]` in that case,
  // which looked like "Open in Chat opened a different/new chat" (the reported
  // bug). Instead: only bump when the chat is truly gone (deleted). If it still
  // exists in another project, switch to that project so it stays selected.
  const prevProjectIdRef = React.useRef(projectId);
  const prevActiveChatRef = React.useRef(activeChatId);
  React.useEffect(() => {
    const projectChanged = prevProjectIdRef.current !== projectId;
    const chatChanged = prevActiveChatRef.current !== activeChatId;
    prevProjectIdRef.current = projectId;
    prevActiveChatRef.current = activeChatId;

    if (!activeChatId) {
      if (tabs.length > 0) setActiveChat(tabs[0].id);
      return;
    }
    if (tabs.some((t) => t.id === activeChatId)) return;

    // The active chat is NOT in the current project's tab list.
    if (projectChanged && !chatChanged) {
      // The user deliberately switched PROJECT (the active chat didn't change).
      // Don't drag them back to the old chat's project — select a chat that
      // belongs to the project they just opened instead.
      setActiveChat(tabs[0]?.id ?? null);
      return;
    }

    if (!chatChanged) {
      // Stale cross-project selection (e.g. chats still loading after a project
      // switch). Stay in the current project — never yank the user back to the
      // chat's owning project unless they explicitly opened that chat.
      setActiveChat(tabs[0]?.id ?? null);
      return;
    }

    // The active CHAT changed (e.g. "Open in Chat" from History or a command-
    // palette jump) to a chat in another project — align the workspace to that
    // chat's project so its tab is in scope.
    let cancelled = false;
    void (async () => {
      let chat: Chat | undefined;
      try {
        chat = await chatRepo.getById(activeChatId as ChatId);
      } catch {
        chat = undefined;
      }
      if (cancelled) return;
      if (!chat) {
        // The chat was actually deleted — fall back to the first tab.
        setActiveChat(tabs[0]?.id ?? null);
        return;
      }
      const chatProject = (chat.project_id ?? null) as ProjectId | null;
      if (chatProject !== projectId) {
        // Pre-seed per-project memory so the project-switch handler keeps THIS
        // chat active rather than restoring a previously-remembered one.
        projectChatMemory.set(projectMemoryKey(chatProject), activeChatId as ChatId);
        setProjectId(chatProject);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabs, activeChatId, projectId, setActiveChat, setProjectId]);

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
      const chatId = await ensureActiveChat({ forceNew: true });
      if (!chatId) {
        toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
        return;
      }
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
        toast.error('Could not close tab', err instanceof Error ? err.message : 'Try again.');
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

  // Hotkeys (live-resolved from Settings → Hotkeys registry)
  useBoundHotkey('NEW_TAB', (e) => {
    e.preventDefault();
    void handleNewTab();
  });
  useBoundHotkey('CLOSE_TAB', (e) => {
    e.preventDefault();
    if (activeChatId) void handleClose(activeChatId as ChatId);
  });
  useBoundHotkey('TAB_1', (e) => {
    e.preventDefault();
    switchToIndex(0);
  });
  useBoundHotkey('TAB_2', (e) => {
    e.preventDefault();
    switchToIndex(1);
  });
  useBoundHotkey('TAB_3', (e) => {
    e.preventDefault();
    switchToIndex(2);
  });
  useBoundHotkey('TAB_4', (e) => {
    e.preventDefault();
    switchToIndex(3);
  });
  useBoundHotkey('TAB_5', (e) => {
    e.preventDefault();
    switchToIndex(4);
  });
  useBoundHotkey('TAB_6', (e) => {
    e.preventDefault();
    switchToIndex(5);
  });
  useBoundHotkey('TAB_7', (e) => {
    e.preventDefault();
    switchToIndex(6);
  });
  useBoundHotkey('TAB_8', (e) => {
    e.preventDefault();
    switchToIndex(7);
  });
  useBoundHotkey('TAB_9', (e) => {
    e.preventDefault();
    switchToIndex(8);
  });

  if (route === 'files') {
    return <FilesRouteTab activePath={fileWorkspace.activePath} />;
  }

  return (
    <div
      data-monochrome-surface="tab-strip"
      data-sakura-shell-region="tab-strip"
      className="sakura-shell-tab-strip flex h-8 shrink-0 items-stretch gap-1 border-b border-border bg-panel px-2"
    >
      <div
        role={tabs.length > 0 ? 'group' : undefined}
        aria-label={tabs.length > 0 ? 'Open chats' : undefined}
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto scrollbar-hidden"
      >
        <AnimatePresence initial={false}>
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeChatId}
              onActivate={() => handleSelect(tab.id)}
              onClose={() => void handleClose(tab.id)}
              onRename={(next) => void handleRename(tab.id, next)}
              onSendToPetPanel={() => {
                const petOn = usePetSettingsStore.getState().enabled;
                if (!petOn) {
                  usePetSettingsStore.getState().setEnabled(true);
                  usePetSettingsStore.getState().setOverlayVisible(true);
                }
                usePetPresentationStore.getState().registerChat(tab.id, 'main');
                usePetPresentationStore.getState().moveChat(tab.id, 'pet-mini-panel');
                usePetPresentationStore.getState().setPanelActiveChatId(tab.id);
                toast.success('Sent to Pet panel', 'Same chat thread — not a copy.');
                window.dispatchEvent(new CustomEvent('jarvis:pet:open-panel'));
              }}
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

export function FilesRouteTab({ activePath }: { activePath: string | null }) {
  const label = activePath ? basename(activePath) : 'Files';
  return (
    <div
      data-monochrome-surface="tab-strip"
      data-sakura-shell-region="tab-strip"
      className="sakura-shell-tab-strip flex h-8 shrink-0 items-stretch gap-1 border-b border-border bg-panel px-2"
    >
      <div
        role="group"
        aria-label="Files workspace"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        <div
          className="flex h-7 max-w-[280px] items-center gap-1.5 rounded-md border border-border bg-elevated px-2 text-secondary text-foreground"
          title={activePath ?? 'Files workspace'}
        >
          <FileText className="h-3 w-3 shrink-0 text-accent-copper" />
          <span className="truncate">{label}</span>
        </div>
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
  onSendToPetPanel?: () => void;
}

export function TabItem({
  tab,
  active,
  onActivate,
  onClose,
  onRename,
  onSendToPetPanel,
}: TabItemProps) {
  const themeMotionTransition = useThemeMotionTransition(LEGACY_TAB_TRANSITION);
  const themeMotionLayout = useThemeMotionLayout(true);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(tab.title);
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
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
    <>
      <motion.div
        layout={themeMotionLayout}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={themeMotionTransition}
        className={cn(
          'group flex h-7 max-w-[220px] shrink-0 cursor-default select-none items-center gap-1.5 self-center rounded-md border border-transparent px-2 text-secondary transition-colors motion-reduce:!transform-none motion-reduce:!opacity-100',
          active
            ? 'bg-elevated text-foreground border-border'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
        )}
        title={editing ? undefined : 'Double-click to rename · Right-click for Pet panel'}
      >
        {tab.pinned ? (
          <Pin
            className="h-3 w-3 shrink-0 fill-accent-copper/80 text-accent-copper"
            aria-label="Pinned"
          />
        ) : null}
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
          <button
            type="button"
            aria-pressed={active}
            tabIndex={active ? 0 : -1}
            data-sik-evidence={KERNEL_SMOKE_ENABLED && active ? SIK_CONTROL.chatReturn : undefined}
            onClick={onActivate}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate();
              }
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({ x: event.clientX, y: event.clientY });
            }}
            className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [html[data-theme=sakura]_&]:min-h-6"
          >
            <ThoughtBloomTitle title={tab.title} />
          </button>
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
            'inline-flex h-6 w-6 min-h-6 min-w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity',
            'hover:bg-muted hover:text-foreground',
            active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </motion.div>
      {menu &&
        createPortal(
          <>
            <button
              type="button"
              className="fixed inset-0 z-[200] cursor-default bg-transparent"
              aria-label="Dismiss menu"
              onClick={() => setMenu(null)}
            />
            <div
              className="fixed z-[210] min-w-[180px] rounded-lg border border-border bg-panel p-1 shadow-lg"
              style={{ left: menu.x, top: menu.y }}
              role="menu"
            >
              <button
                type="button"
                className="w-full rounded px-2.5 py-1.5 text-left text-metadata hover:bg-accent-copper/10"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onSendToPetPanel?.();
                }}
              >
                Send to Pet panel
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

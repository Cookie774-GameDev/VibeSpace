import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { motion, AnimatePresence } from 'motion/react';
import {
  Pin,
  PinOff,
  FolderTree,
  MessageSquare,
  Bot,
  Sparkles,
  FileText,
  Plus,
  Terminal,
  KanbanSquare,
  CalendarDays,
  BarChart3,
  History,
  LayoutGrid,
  Wrench,
  ChevronDown,
  Settings as SettingsIcon,
  AppWindow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import type { Route } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { db, projectRepo, chatRepo } from '@/lib/db';
import type { Project } from '@/lib/db/schema';
import type { Agent, ChatId, ProjectId, WorkspaceId } from '@/types';
import type { Chat } from '@/types/chat';
import { cn } from '@/lib/utils';
import { AgentBadge } from '@/features/agents/AgentBadge';
import { SidebarContextTree } from '@/features/context/SidebarContextTree';
import { SidebarFilesTree } from '@/features/files/SidebarFilesTree';
import { openOrFocusWorkbenchWindow } from '@/features/workbench/window';
import { useWorkbenchStore } from '@/features/workbench/store';
import { chatPinPatch, isChatPinned, sortChatsForDisplay } from '@/features/chat/chatPin';
import {
  ChatListActivityIndicator,
  mergeChatActivityEvents,
  type ChatActivityEvent,
  type ChatListRunSignal,
} from '@/features/chat/activity';
import { useChatActivityStore } from '@/features/chat/activity/activityStore';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_CONTROL, type SikControlId } from '@/lib/jarvis/smoke/evidenceIds';
import { useThemeLayoutTransition } from '@/features/appearance/themeMotion';
import {
  isKernelSmokeBindingActive,
  subscribeKernelSmokeBinding,
} from '@/lib/ai/providers/kernelSmoke';

const LEGACY_NAV_PANE_TRANSITION = Object.freeze({
  type: 'spring',
  stiffness: 400,
  damping: 30,
} as const);

const TERMINAL_MIME = 'application/x-jarvis-terminal';
const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

/**
 * NavPane - 240px expanded, 56px collapsed.
 *
 * V2 Cozy: every section is now wired to live data + actionable.
 *
 * - Pinned: chats with `pinned=true` (toggle via the pin control on each row).
 * - Projects: dexie-live list, "+ New" button creates `Project N`, click
 *   activates via `setProjectId`. The active row glows copper.
 * - Chats: dexie-live list scoped to the active workspace + project (unpinned),
 *   "+ New" creates a placeholder chat, click activates via `setActiveChat`.
 * - Agents: registered agents from the runtime store. Clicking an agent
 *   spins up a new chat with that agent active — matches the V2 ask
 *   "the buttons at the side for a specific AI agents are not working".
 *
 * NavItem click + drag are guarded — when `workspaceId` is null we still
 * render but actions toast a friendly "finishing setup..." message instead
 * of silently no-oping.
 */
export function NavPane() {
  const themeLayoutTransition = useThemeLayoutTransition(LEGACY_NAV_PANE_TRANSITION);
  const kernelSmokeBindingActive = React.useSyncExternalStore(
    subscribeKernelSmokeBinding,
    isKernelSmokeBindingActive,
    () => false,
  );
  const navOpen = useUIStore((s) => s.navOpen);
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  const setActiveAgent = useUIStore((s) => s.setActiveAgent);
  const setChatMode = useUIStore((s) => s.setChatMode);
  const activeChatId = useUIStore((s) => s.activeChatId);
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);
  const navSectionsCollapsed = useUIStore((s) => s.navSectionsCollapsed);
  const toggleNavSection = useUIStore((s) => s.toggleNavSection);

  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const localUserId = useAuthStore((s) => s.localUserId);
  const projectId = useAuthStore((s) => s.projectId) as ProjectId | null;
  const setProjectId = useAuthStore((s) => s.setProjectId);

  const agents = useAgentStore((s) => s.agents);
  const agentList = React.useMemo(() => Object.values(agents), [agents]);
  const taskRuns = useJarvisTaskRunStore((state) => state.runs);
  const taskActivityByChat = useJarvisTaskRunStore((state) => state.activityByChat);
  const liveActivityByChat = useChatActivityStore((state) => state.eventsByChat);
  const taskRunsByChat = React.useMemo(() => {
    const grouped: Record<string, ChatListRunSignal[]> = {};
    Object.values(taskRuns).forEach((run) => {
      if (!run.chatId) return;
      (grouped[run.chatId] ??= []).push(run);
    });
    return grouped;
  }, [taskRuns]);

  // Live projects + chats. dexie-react-hooks re-renders on any insert/update.
  const projects = useLiveQuery(
    () => (workspaceId ? projectRepo.listByWorkspace(workspaceId) : Promise.resolve([])),
    [workspaceId],
    [] as Project[],
  );
  const chats = useLiveQuery(
    async () => {
      if (!workspaceId) return [] as Chat[];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      // Project-scoped: a chat with no project_id is "loose" and only
      // shows when no project is active. With an active project, only
      // chats whose project_id matches are shown — that's the
      // "projects house their chats" part of the spec.
      const filtered = projectId
        ? rows.filter((c) => c.project_id === projectId)
        : rows.filter((c) => !c.project_id);
      return sortChatsForDisplay(filtered).slice(0, 50);
    },
    [workspaceId, projectId],
    [] as Chat[],
  );

  const pinnedChats = React.useMemo(() => (chats ?? []).filter((c) => isChatPinned(c)), [chats]);
  const unpinnedChats = React.useMemo(() => (chats ?? []).filter((c) => !isChatPinned(c)), [chats]);

  const onTogglePinChat = async (chat: Chat) => {
    const nextPinned = !isChatPinned(chat);
    try {
      await chatRepo.update(chat.id, chatPinPatch(nextPinned));
      toast.info(
        nextPinned ? 'Chat pinned' : 'Chat unpinned',
        nextPinned ? 'It will stay at the top of the sidebar.' : 'Moved back to Chats.',
      );
    } catch (err) {
      toast.error('Could not update pin', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const openChat = (c: Chat) => {
    setActiveChat(c.id as unknown as ChatId);
    setChatMode(c.mode);
    setRoute('chat');
  };

  // ---------- create handlers ----------

  const onCreateProject = async () => {
    if (!workspaceId) {
      toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
      return;
    }
    const existing = projects?.length ?? 0;
    const name = `Project ${existing + 1}`;
    try {
      const proj = await projectRepo.create({
        workspace_id: workspaceId,
        name,
        color_hue: ((existing + 1) * 47) % 360,
      });
      setProjectId(proj.id);
      // Land the user on the project detail page so they can fill in
      // the system-prompt context, pick agents, and rename without
      // having to right-click the row. The toast is gone — the route
      // change is its own confirmation.
      setRoute('project-detail');
    } catch (err) {
      toast.error('Could not create project', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const onCreateChat = async () => {
    if (!workspaceId) {
      toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
      return;
    }
    const existing = chats?.length ?? 0;
    const title = `New chat ${existing + 1}`;
    try {
      const chat = await chatRepo.create({
        workspace_id: workspaceId,
        project_id: projectId ?? undefined,
        title,
        mode: 'chat',
        active_agent_ids: [],
      });
      setActiveChat(chat.id);
      setChatMode('chat');
      setRoute('chat');
    } catch (err) {
      toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const onDropTerminalToProject = React.useCallback(
    async (raw: string, project: Project) => {
      const [{ parseTerminalRef }, { moveTerminalLeafToProject }] = await Promise.all([
        import('@/features/terminals/terminalRefs'),
        import('@/features/terminals/terminalProjectMove'),
      ]);
      const ref = parseTerminalRef(raw);
      if (!ref) return;
      const result = moveTerminalLeafToProject({
        ref,
        sourceProjectId: ref.projectId ?? projectId ?? null,
        targetProjectId: project.id,
        targetProjectName: project.name,
      });
      if (!result.ok) {
        toast.warning('Could not move terminal', result.reason ?? 'Try again.');
        return;
      }
      setProjectId(project.id);
      setRoute('terminal');
    },
    [projectId, setProjectId, setRoute],
  );

  /**
   * Click an agent → open the agent detail page (NOT a fresh chat).
   *
   * The old behaviour spun up a brand-new chat per click; the user
   * found that confusing because it created chat clutter and hid the
   * agent's actual configuration. The detail page surfaces the system
   * prompt + capabilities + provider, with an explicit "Start chat"
   * button that performs the previous behaviour deliberately.
   */
  const onClickAgent = (a: Agent) => {
    setActiveAgent(a.id);
    setRoute('agent-detail');
  };

  const onCreateAgent = () => {
    // The dedicated "create agent" flow lives inside the agent manager
    // (clone an existing one, then edit). The simplest route is to
    // jump there — the user can clone any agent and edit the copy.
    setActiveAgent(null);
    setRoute('agents');
  };

  return (
    <motion.aside
      aria-label="Navigation"
      data-monochrome-surface="navigation"
      data-sakura-shell-region="navigation"
      data-nav-pane="true"
      data-nav-state={navOpen ? 'expanded' : 'collapsed'}
      className="sakura-shell-navigation shrink-0 overflow-hidden bg-panel border-r border-border"
      initial={false}
      animate={{ width: navOpen ? 240 : 56 }}
      transition={themeLayoutTransition}
    >
      <div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden scrollbar-hidden">
        <NavSection
          id="workspace"
          title="Workspace"
          icon={<LayoutGrid className="h-4 w-4" />}
          navOpen={navOpen}
          collapsed={!!navSectionsCollapsed['workspace']}
          onToggleCollapsed={() => toggleNavSection('workspace')}
        >
          <RouteItem
            navOpen={navOpen}
            label="Chat"
            icon={<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
            target="chat"
            route={route}
            setRoute={setRoute}
          />
          <NavItem
            navOpen={navOpen}
            label="Workbench"
            icon={<AppWindow className="h-3.5 w-3.5 text-accent-copper" />}
            active={route === 'workbench'}
            onClick={() => {
              // ALWAYS show Workbench in this window first so it is never "nowhere to be found".
              // Then best-effort open/focus a separate native/browser window.
              setRoute('workbench');
              void openOrFocusWorkbenchWindow({
                name: useWorkbenchStore.getState().name,
              })
                .then((result) => {
                  if (result.ok) {
                    toast.success(
                      result.focusedExisting ? 'Workbench focused' : 'Workbench ready',
                      result.focusedExisting
                        ? 'Brought the Workbench window forward. It is also open in this window.'
                        : 'Workbench is open here. A separate window was also opened if the desktop shell allowed it.',
                    );
                    return;
                  }
                  toast.info(
                    'Workbench open',
                    result.reason ??
                      'Showing Workbench in this window (separate window unavailable).',
                  );
                })
                .catch((err: unknown) => {
                  toast.info(
                    'Workbench open',
                    err instanceof Error ? err.message : 'Showing Workbench in this window.',
                  );
                });
            }}
          />
          <RouteItem
            navOpen={navOpen}
            label="Canvas"
            icon={<LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />}
            target="canvas"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Terminals"
            icon={<Terminal className="h-3.5 w-3.5 text-muted-foreground" />}
            target="terminal"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Kanban"
            icon={<KanbanSquare className="h-3.5 w-3.5 text-muted-foreground" />}
            target="kanban"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Schedule"
            icon={<CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />}
            target="schedule"
            route={route}
            setRoute={setRoute}
            evidenceId={
              KERNEL_SMOKE_ENABLED && kernelSmokeBindingActive
                ? SIK_CONTROL.scheduleFixture
                : undefined
            }
          />
          <RouteItem
            navOpen={navOpen}
            label="Benchmarks"
            icon={<BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />}
            target="benchmarks"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="History"
            icon={<History className="h-3.5 w-3.5 text-muted-foreground" />}
            target="history"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Agents"
            icon={<Bot className="h-3.5 w-3.5 text-muted-foreground" />}
            target="agents"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Skills"
            icon={<Sparkles className="h-3.5 w-3.5 text-muted-foreground" />}
            target="skills"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Tools"
            icon={<Wrench className="h-3.5 w-3.5 text-muted-foreground" />}
            target="tools"
            route={route}
            setRoute={setRoute}
          />
          <RouteItem
            navOpen={navOpen}
            label="Files"
            icon={<FileText className="h-3.5 w-3.5 text-muted-foreground" />}
            target="files"
            route={route}
            setRoute={setRoute}
          />
        </NavSection>

        <NavSection
          id="pinned"
          title="Pinned"
          icon={<Pin className="h-4 w-4" />}
          navOpen={navOpen}
          collapsed={!!navSectionsCollapsed['pinned']}
          onToggleCollapsed={() => toggleNavSection('pinned')}
        >
          {pinnedChats.length === 0 ? (
            <EmptyHint navOpen={navOpen} text="Pin chats to keep them close." />
          ) : (
            pinnedChats.map((c) => (
              <ChatNavRow
                key={c.id}
                chat={c}
                navOpen={navOpen}
                active={(c.id as unknown as string) === activeChatId}
                activityEvents={mergeChatActivityEvents(
                  taskActivityByChat[String(c.id)] ?? [],
                  liveActivityByChat[String(c.id)] ?? [],
                )}
                activityRuns={taskRunsByChat[String(c.id)] ?? []}
                onOpen={() => openChat(c)}
                onTogglePin={() => void onTogglePinChat(c)}
              />
            ))
          )}
        </NavSection>

        <NavSection
          id="projects"
          title="Projects"
          icon={<FolderTree className="h-4 w-4" />}
          navOpen={navOpen}
          collapsed={!!navSectionsCollapsed['projects']}
          onToggleCollapsed={() => toggleNavSection('projects')}
          action={
            <Hint label="New project">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void onCreateProject();
                }}
                aria-label="Create project"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Hint>
          }
        >
          {(projects ?? []).length === 0 ? (
            <EmptyHint navOpen={navOpen} text="No projects yet. Hit + to create one." />
          ) : (
            (projects ?? []).map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                navOpen={navOpen}
                active={p.id === projectId}
                onActivate={() => setProjectId(p.id)}
                onTerminalHover={() => {
                  setProjectId(p.id);
                  setRoute('terminal');
                }}
                onDropTerminal={(raw) => onDropTerminalToProject(raw, p)}
                onOpenSettings={() => {
                  setProjectId(p.id);
                  setRoute('project-detail');
                }}
              />
            ))
          )}
        </NavSection>

        <NavSection
          id="chats"
          title="Chats"
          icon={<MessageSquare className="h-4 w-4" />}
          navOpen={navOpen}
          collapsed={!!navSectionsCollapsed['chats']}
          onToggleCollapsed={() => toggleNavSection('chats')}
          action={
            <Hint label="New chat">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void onCreateChat();
                }}
                aria-label="Create chat"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Hint>
          }
        >
          {unpinnedChats.length === 0 ? (
            <EmptyHint
              navOpen={navOpen}
              text={
                pinnedChats.length > 0
                  ? 'All chats are pinned above.'
                  : 'No chats yet. Hit + to start one.'
              }
            />
          ) : (
            unpinnedChats.map((c) => (
              <ChatNavRow
                key={c.id}
                chat={c}
                navOpen={navOpen}
                active={(c.id as unknown as string) === activeChatId}
                activityEvents={mergeChatActivityEvents(
                  taskActivityByChat[String(c.id)] ?? [],
                  liveActivityByChat[String(c.id)] ?? [],
                )}
                activityRuns={taskRunsByChat[String(c.id)] ?? []}
                onOpen={() => openChat(c)}
                onTogglePin={() => void onTogglePinChat(c)}
              />
            ))
          )}
        </NavSection>

        <NavSection
          id="agents"
          title="Agents"
          icon={<Bot className="h-4 w-4" />}
          navOpen={navOpen}
          collapsed={!!navSectionsCollapsed['agents']}
          onToggleCollapsed={() => toggleNavSection('agents')}
          action={
            <Hint label="New agent">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateAgent();
                }}
                aria-label="Create agent"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Hint>
          }
        >
          {agentList.length === 0 ? (
            <EmptyHint navOpen={navOpen} text="No agents loaded." />
          ) : (
            agentList.map((a) => (
              <NavItem
                key={a.id}
                navOpen={navOpen}
                label={a.name}
                icon={<AgentBadge agent={a} showName={false} size="md" />}
                onClick={() => onClickAgent(a)}
              />
            ))
          )}
        </NavSection>

        <NavSection
          id="context"
          title="Context"
          icon={<Sparkles className="h-4 w-4" />}
          navOpen={navOpen}
          active={route === 'context'}
          collapsed={!!navSectionsCollapsed['context']}
          onToggleCollapsed={() => toggleNavSection('context')}
          onTitleClick={() => setRoute('context')}
          dataTour="context"
        >
          <SidebarContextTree navOpen={navOpen} onOpenContext={() => setRoute('context')} />
        </NavSection>

        <NavSection
          id="files"
          title="Files"
          icon={<FileText className="h-4 w-4" />}
          navOpen={navOpen}
          collapsed={!!navSectionsCollapsed['files']}
          onToggleCollapsed={() => toggleNavSection('files')}
        >
          <SidebarFilesTree
            navOpen={navOpen}
            active={route === 'files'}
            onOpenFiles={() => setRoute('files')}
          />
        </NavSection>

        {/* Tiny status footer so the user knows whose workspace they're in. */}
        {navOpen && (
          <div className="mt-auto px-3 py-2 text-metadata text-muted-foreground/70 border-t border-border/60 [html[data-theme=monochrome]_&]:text-muted-foreground">
            {workspaceId ? <>Local · {localUserId?.slice(4, 8) ?? '----'}</> : <>Initializing…</>}
          </div>
        )}
      </div>
    </motion.aside>
  );
}

interface NavSectionProps {
  /** Stable id used to persist the collapsed state in `useUIStore`. */
  id: string;
  title: string;
  icon: React.ReactNode;
  navOpen: boolean;
  /** Optional trailing action button (e.g. "+") rendered in the header row. */
  action?: React.ReactNode;
  /** Highlights the section header when its backing page is active. */
  active?: boolean;
  /** When true the section body is hidden (header + chevron remains). */
  collapsed?: boolean;
  /** Click handler for the header — toggles `collapsed`. */
  onToggleCollapsed?: () => void;
  /** Optional title click handler. When present, only the chevron toggles. */
  onTitleClick?: () => void;
  /** Product-tutorial spotlight target id. */
  dataTour?: string;
  children?: React.ReactNode;
}

export function NavSection({
  id: _id,
  title,
  icon,
  navOpen,
  action,
  active,
  collapsed,
  onToggleCollapsed,
  onTitleClick,
  dataTour,
  children,
}: NavSectionProps) {
  if (!navOpen) {
    // Collapsed rail (56px). Skip the chevron entirely; the icon stack
    // is the only chrome.
    return (
      <section
        className="flex flex-col items-center gap-1 px-2 pb-2 pt-3"
        aria-label={title}
        data-tour={dataTour}
      >
        <span
          className="text-muted-foreground/60 [html[data-theme=monochrome]_&]:text-muted-foreground"
          title={title}
        >
          {icon}
        </span>
        <div className="flex w-full flex-col items-stretch gap-0.5">{children}</div>
      </section>
    );
  }
  return (
    <section className="px-2 pb-3 pt-3" data-tour={dataTour}>
      <header
        className={cn(
          'group flex items-center gap-2 px-2 pb-1.5 text-metadata uppercase tracking-wider text-muted-foreground',
          'cursor-pointer select-none rounded-sm transition-colors hover:text-foreground',
          active && 'text-foreground',
        )}
        onClick={(e) => {
          if (onTitleClick) return;
          // Don't toggle if the click landed on the trailing action
          // button (the "+" creates project/chat/agent and stops
          // propagation, but we belt-and-braces here too).
          const target = e.target as HTMLElement;
          if (target.closest('[data-nav-action="true"]')) return;
          onToggleCollapsed?.();
        }}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed?.();
          }}
          className="inline-flex h-6 w-6 min-h-6 min-w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [html[data-theme=monochrome]_&]:-mx-1 [html[data-theme=monochrome]_&]:text-muted-foreground"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          aria-expanded={!collapsed}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', collapsed && '-rotate-90')} />
        </button>
        <span className="opacity-70 shrink-0 [html[data-theme=monochrome]_&]:opacity-100">
          {icon}
        </span>
        {onTitleClick ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTitleClick();
            }}
            className="min-w-0 flex-1 truncate text-left focus-visible:outline-none [html[data-theme=sakura]_&]:min-h-6"
          >
            {title}
          </button>
        ) : (
          <span className="flex-1 truncate">{title}</span>
        )}
        {action && (
          <span data-nav-action="true" className="shrink-0">
            {action}
          </span>
        )}
      </header>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-px">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

interface ProjectRowProps {
  project: Project;
  navOpen: boolean;
  active: boolean;
  onActivate: () => void;
  onTerminalHover: () => void;
  onDropTerminal: (raw: string) => void | Promise<void>;
  onOpenSettings: () => void;
}

/**
 * One project row. Clicking the body activates the project (so chats +
 * terminals filter to it). The trailing settings cog jumps to the
 * project detail page where the user edits name / colour / context /
 * agents.
 */
export function ProjectRow({
  project: p,
  navOpen,
  active,
  onActivate,
  onTerminalHover,
  onDropTerminal,
  onOpenSettings,
}: ProjectRowProps) {
  const [terminalDragOver, setTerminalDragOver] = React.useState(false);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = React.useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  React.useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const armProjectOpen = React.useCallback(() => {
    if (hoverTimerRef.current) return;
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      onTerminalHover();
    }, 450);
  }, [onTerminalHover]);

  const projectDropProps = {
    'data-terminal-drop': 'project',
    'data-terminal-drop-project-id': p.id,
    'data-terminal-drop-project-name': p.name,
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(TERMINAL_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setTerminalDragOver(true);
      armProjectOpen();
    },
    onDragEnter: (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(TERMINAL_MIME)) return;
      setTerminalDragOver(true);
      armProjectOpen();
    },
    onDragLeave: () => {
      setTerminalDragOver(false);
      clearHoverTimer();
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      const raw = e.dataTransfer.getData(TERMINAL_MIME);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      setTerminalDragOver(false);
      clearHoverTimer();
      void onDropTerminal(raw);
    },
  } as const;

  if (!navOpen) {
    return (
      <button
        type="button"
        onClick={onActivate}
        {...projectDropProps}
        title={p.name}
        aria-label={p.name}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
          active &&
            'bg-muted ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
          terminalDragOver &&
            'bg-accent-copper/10 ring-inset ring-1 ring-accent-copper/70 [html[data-theme=monochrome]_&]:ring-0 [html[data-theme=monochrome]_&]:outline [html[data-theme=monochrome]_&]:outline-1 [html[data-theme=monochrome]_&]:outline-accent-copper',
        )}
      >
        <span
          aria-hidden
          className="h-2 w-2 rounded-full shrink-0"
          style={{
            background:
              p.color_hue !== undefined
                ? `hsl(${p.color_hue} 65% 56%)`
                : 'hsl(var(--accent-copper))',
          }}
        />
      </button>
    );
  }
  return (
    <div
      {...projectDropProps}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-body text-foreground transition-colors',
        'hover:bg-muted',
        active &&
          'bg-muted text-foreground ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
        terminalDragOver &&
          'bg-accent-copper/10 ring-inset ring-1 ring-accent-copper/70 [html[data-theme=monochrome]_&]:ring-0 [html[data-theme=monochrome]_&]:outline [html[data-theme=monochrome]_&]:outline-1 [html[data-theme=monochrome]_&]:outline-accent-copper',
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none [html[data-theme=sakura]_&]:min-h-6"
      >
        <span
          aria-hidden
          className="h-2 w-2 rounded-full shrink-0"
          style={{
            background:
              p.color_hue !== undefined
                ? `hsl(${p.color_hue} 65% 56%)`
                : 'hsl(var(--accent-copper))',
          }}
        />
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label={`Open ${p.name} settings`}
        title="Project settings"
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground [html[data-theme=sakura]_&]:h-6 [html[data-theme=sakura]_&]:w-6 [html[data-theme=sakura]_&]:min-h-6 [html[data-theme=sakura]_&]:min-w-6',
          'opacity-0 group-hover:opacity-70 [html[data-theme=monochrome]_&]:group-hover:opacity-100 hover:text-foreground hover:opacity-100',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        <SettingsIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  navOpen: boolean;
  active?: boolean;
  onClick?: () => void;
  /** Product-tutorial spotlight target id (rendered as data-tour). */
  dataTour?: string;
  evidenceId?: SikControlId;
}

function NavItem({ icon, label, navOpen, active, onClick, dataTour, evidenceId }: NavItemProps) {
  if (!navOpen) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        data-tour={dataTour}
        data-sik-evidence={evidenceId}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
          active &&
            'bg-muted ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
        )}
      >
        <span className="shrink-0">{icon}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      data-tour={dataTour}
      data-sik-evidence={evidenceId}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-body text-foreground transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
        active &&
          'bg-muted text-foreground ring-inset ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:ring-0',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  );
}

interface ChatNavRowProps {
  chat: Chat;
  navOpen: boolean;
  active?: boolean;
  activityRuns?: readonly ChatListRunSignal[];
  activityEvents?: readonly ChatActivityEvent[];
  onOpen: () => void;
  onTogglePin: () => void;
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
  const label = (chat.title || 'Untitled chat').trim() || 'Untitled chat';
  const pinned = isChatPinned(chat);

  if (!navOpen) {
    return (
      <button
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
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-7 w-full items-center gap-0.5 rounded-md pr-0.5 transition-colors',
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
      <Hint label={pinned ? 'Unpin chat' : 'Pin chat'}>
        <button
          type="button"
          data-nav-action="true"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
          aria-pressed={pinned}
          className={cn(
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors',
            'text-muted-foreground/50 hover:bg-background/80 hover:text-accent-copper [html[data-theme=monochrome]_&]:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            pinned && 'opacity-100 text-accent-copper',
          )}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      </Hint>
    </div>
  );
}

function EmptyHint({ navOpen, text }: { navOpen: boolean; text: string }) {
  if (!navOpen) return null;
  return (
    <p className="px-2 py-1 text-metadata text-muted-foreground/60 [html[data-theme=monochrome]_&]:text-muted-foreground">
      {text}
    </p>
  );
}

interface RouteItemProps {
  icon: React.ReactNode;
  label: string;
  navOpen: boolean;
  target: Route;
  route: Route;
  setRoute: (r: Route) => void;
  evidenceId?: SikControlId;
}

/**
 * Workspace-section row: behaves like a NavItem but binds the click to
 * `setRoute(target)` and reflects the active state from `route === target`.
 */
function RouteItem({ icon, label, navOpen, target, route, setRoute, evidenceId }: RouteItemProps) {
  const active = route === target;
  return (
    <NavItem
      icon={icon}
      label={label}
      navOpen={navOpen}
      active={active}
      onClick={() => setRoute(target)}
      dataTour={target}
      evidenceId={evidenceId}
    />
  );
}

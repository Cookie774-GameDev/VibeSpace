import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { motion, AnimatePresence } from 'motion/react';
import {
  Pin,
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
import { cn } from '@/lib/utils';
import { AgentBadge } from '@/features/agents/AgentBadge';
import { SidebarContextTree } from '@/features/context/SidebarContextTree';
import { SidebarFilesTree } from '@/features/files/SidebarFilesTree';

const TERMINAL_MIME = 'application/x-jarvis-terminal';

/**
 * NavPane - 240px expanded, 56px collapsed.
 *
 * V2 Cozy: every section is now wired to live data + actionable.
 *
 * - Pinned: chats with `pinned=true` (best-effort; field reserved on Chat).
 * - Projects: dexie-live list, "+ New" button creates `Project N`, click
 *   activates via `setProjectId`. The active row glows copper.
 * - Chats: dexie-live list scoped to the active workspace + project, "+ New"
 *   creates a placeholder chat, click activates via `setActiveChat`.
 * - Agents: registered agents from the runtime store. Clicking an agent
 *   spins up a new chat with that agent active — matches the V2 ask
 *   "the buttons at the side for a specific AI agents are not working".
 *
 * NavItem click + drag are guarded — when `workspaceId` is null we still
 * render but actions toast a friendly "finishing setup..." message instead
 * of silently no-oping.
 */
export function NavPane() {
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

  // Live projects + chats. dexie-react-hooks re-renders on any insert/update.
  const projects = useLiveQuery(
    () => (workspaceId ? projectRepo.listByWorkspace(workspaceId) : Promise.resolve([])),
    [workspaceId],
    [] as Project[],
  );
  const chats = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      // Project-scoped: a chat with no project_id is "loose" and only
      // shows when no project is active. With an active project, only
      // chats whose project_id matches are shown — that's the
      // "projects house their chats" part of the spec.
      const filtered = projectId
        ? rows.filter((c) => c.project_id === projectId)
        : rows.filter((c) => !c.project_id);
      // newest first
      return filtered.sort((a, b) => b.updated_at - a.updated_at).slice(0, 50);
    },
    [workspaceId, projectId],
    [],
  );

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
      data-nav-pane="true"
      className="shrink-0 overflow-hidden bg-panel border-r border-border"
      initial={false}
      animate={{ width: navOpen ? 240 : 56 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
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
          <EmptyHint navOpen={navOpen} text="Pin chats to keep them close." />
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
          {(chats ?? []).length === 0 ? (
            <EmptyHint navOpen={navOpen} text="No chats yet. Hit + to start one." />
          ) : (
            (chats ?? []).map((c) => (
              <NavItem
                key={c.id}
                navOpen={navOpen}
                label={c.title || 'Untitled chat'}
                active={(c.id as unknown as string) === activeChatId}
                icon={<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
                onClick={() => {
                  setActiveChat(c.id as unknown as ChatId);
                  setChatMode(c.mode);
                  setRoute('chat');
                }}
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
          <SidebarFilesTree navOpen={navOpen} active={route === 'files'} onOpenFiles={() => setRoute('files')} />
        </NavSection>

        {/* Tiny status footer so the user knows whose workspace they're in. */}
        {navOpen && (
          <div className="mt-auto px-3 py-2 text-metadata text-muted-foreground/70 border-t border-border/60">
            {workspaceId ? (
              <>Local · {localUserId?.slice(4, 8) ?? '----'}</>
            ) : (
              <>Initializing…</>
            )}
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
  children?: React.ReactNode;
}

function NavSection({
  id: _id,
  title,
  icon,
  navOpen,
  action,
  active,
  collapsed,
  onToggleCollapsed,
  onTitleClick,
  children,
}: NavSectionProps) {
  if (!navOpen) {
    // Collapsed rail (56px). Skip the chevron entirely; the icon stack
    // is the only chrome.
    return (
      <section
        className="flex flex-col items-center gap-1 px-2 pb-2 pt-3"
        aria-label={title}
      >
        <span className="text-muted-foreground/60" title={title}>
          {icon}
        </span>
        <div className="flex w-full flex-col items-stretch gap-0.5">{children}</div>
      </section>
    );
  }
  return (
    <section className="px-2 pb-3 pt-3">
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
        aria-expanded={!collapsed}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed?.();
          }}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform',
              collapsed && '-rotate-90',
            )}
          />
        </button>
        <span className="opacity-70 shrink-0">{icon}</span>
        {onTitleClick ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTitleClick();
            }}
            className="min-w-0 flex-1 truncate text-left focus-visible:outline-none"
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
function ProjectRow({
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
        className={cn(
          'flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
          active && 'bg-muted ring-inset ring-1 ring-accent-copper/40',
          terminalDragOver && 'bg-accent-copper/10 ring-inset ring-1 ring-accent-copper/70',
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
      className={cn(
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-body text-foreground transition-colors',
        'hover:bg-muted',
        active && 'bg-muted text-foreground ring-inset ring-1 ring-accent-copper/40',
        terminalDragOver && 'bg-accent-copper/10 ring-inset ring-1 ring-accent-copper/70',
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
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
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground',
          'opacity-0 group-hover:opacity-70 hover:text-foreground hover:opacity-100',
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
}

function NavItem({ icon, label, navOpen, active, onClick }: NavItemProps) {
  if (!navOpen) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        className={cn(
          'flex h-7 w-full items-center justify-center rounded-md text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
          active && 'bg-muted ring-inset ring-1 ring-accent-copper/40',
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
      className={cn(
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-body text-foreground transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-muted text-foreground ring-inset ring-1 ring-accent-copper/40',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </button>
  );
}

function EmptyHint({ navOpen, text }: { navOpen: boolean; text: string }) {
  if (!navOpen) return null;
  return <p className="px-2 py-1 text-metadata text-muted-foreground/60">{text}</p>;
}

interface RouteItemProps {
  icon: React.ReactNode;
  label: string;
  navOpen: boolean;
  target: Route;
  route: Route;
  setRoute: (r: Route) => void;
}

/**
 * Workspace-section row: behaves like a NavItem but binds the click to
 * `setRoute(target)` and reflects the active state from `route === target`.
 */
function RouteItem({ icon, label, navOpen, target, route, setRoute }: RouteItemProps) {
  const active = route === target;
  return (
    <NavItem
      icon={icon}
      label={label}
      navOpen={navOpen}
      active={active}
      onClick={() => setRoute(target)}
    />
  );
}

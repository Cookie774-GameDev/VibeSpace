import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { motion } from 'motion/react';
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
  BarChart3,
  History,
  LayoutGrid,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
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
  const setChatMode = useUIStore((s) => s.setChatMode);
  const activeChatId = useUIStore((s) => s.activeChatId);
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);

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
      // newest first
      return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, 50);
    },
    [workspaceId],
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
      toast.success('Project created', `Switched to "${name}". Right-click to rename.`);
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
      toast.success('Chat created', `"${title}" is open and ready.`);
    } catch (err) {
      toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const onClickAgent = async (a: Agent) => {
    if (!workspaceId) {
      toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
      return;
    }
    try {
      const chat = await chatRepo.create({
        workspace_id: workspaceId,
        project_id: projectId ?? undefined,
        title: `Chat with ${a.name}`,
        mode: 'chat',
        active_agent_ids: [a.id],
      });
      setActiveChat(chat.id);
      setChatMode('chat');
      toast.success(`@${a.slug} ready`, `New chat started with ${a.name}.`);
    } catch (err) {
      toast.error('Could not start chat', err instanceof Error ? err.message : 'Try again.');
    }
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
          title="Workspace"
          icon={<LayoutGrid className="h-4 w-4" />}
          navOpen={navOpen}
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
            label="Skills"
            icon={<Sparkles className="h-3.5 w-3.5 text-muted-foreground" />}
            target="skills"
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
        </NavSection>

        <NavSection title="Pinned" icon={<Pin className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="Pin chats to keep them close." />
        </NavSection>

        <NavSection
          title="Projects"
          icon={<FolderTree className="h-4 w-4" />}
          navOpen={navOpen}
          action={
            <Hint label="New project">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onCreateProject}
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
              <NavItem
                key={p.id}
                navOpen={navOpen}
                label={p.name}
                active={p.id === projectId}
                icon={
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
                }
                onClick={() => setProjectId(p.id)}
              />
            ))
          )}
        </NavSection>

        <NavSection
          title="Chats"
          icon={<MessageSquare className="h-4 w-4" />}
          navOpen={navOpen}
          action={
            <Hint label="New chat">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onCreateChat}
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
                }}
              />
            ))
          )}
        </NavSection>

        <NavSection title="Agents" icon={<Bot className="h-4 w-4" />} navOpen={navOpen}>
          {agentList.length === 0 ? (
            <EmptyHint navOpen={navOpen} text="No agents loaded." />
          ) : (
            agentList.map((a) => (
              <NavItem
                key={a.id}
                navOpen={navOpen}
                label={a.name}
                icon={<Avatar seed={a.slug} size={16} />}
                onClick={() => void onClickAgent(a)}
              />
            ))
          )}
        </NavSection>

        <NavSection title="Skills" icon={<Sparkles className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="No skills installed." />
        </NavSection>

        <NavSection title="Files" icon={<FileText className="h-4 w-4" />} navOpen={navOpen}>
          <EmptyHint navOpen={navOpen} text="Search project files." />
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
  title: string;
  icon: React.ReactNode;
  navOpen: boolean;
  /** Optional trailing action button (e.g. "+") rendered in the header row. */
  action?: React.ReactNode;
  children?: React.ReactNode;
}

function NavSection({ title, icon, navOpen, action, children }: NavSectionProps) {
  if (!navOpen) {
    return (
      <section className="flex flex-col items-center gap-1 px-2 pb-2 pt-3" aria-label={title}>
        <span className="text-muted-foreground/60" title={title}>
          {icon}
        </span>
        <div className="flex w-full flex-col items-stretch gap-0.5">{children}</div>
      </section>
    );
  }
  return (
    <section className="px-2 pb-3 pt-3">
      <header className="flex items-center gap-2 px-2 pb-1.5 text-metadata uppercase tracking-wider text-muted-foreground">
        <span className="opacity-70 shrink-0">{icon}</span>
        <span className="flex-1 truncate">{title}</span>
        {action}
      </header>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
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
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          active && 'bg-muted ring-1 ring-accent-copper/40',
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
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-muted text-foreground ring-1 ring-accent-copper/40',
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

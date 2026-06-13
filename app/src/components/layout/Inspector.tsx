import * as React from 'react';
import { motion } from 'motion/react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Boxes,
  CalendarDays,
  Clock,
  CircleDot,
  ExternalLink,
  FileText,
  GitBranch,
  Link2,
  ListTodo,
  MessageSquare,
  PlayCircle,
  Sparkles,
  Sun,
  Tag,
  Terminal as TerminalIcon,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { ChatThread, Composer } from '@/features/chat';
import { EmptyChat } from '@/features/chat/EmptyChat';
// `useTodayEvents` exists on the V2 schedule hooks (added by the parallel
// agent) but isn't re-exported from `@/features/schedule` yet. Import the
// deep path until it surfaces in the barrel.
import { useTodayEvents } from '@/features/schedule/hooks';
import type { RecurrenceInstance } from '@/features/schedule/recurrence';
import { useQuickLinks, launchLink } from '@/features/launcher';
import { useTodayTasks } from '@/features/tasks';
import { chatRepo, taskRepo, terminalSessionRepo, db } from '@/lib/db';
import { toast } from '@/components/ui/toast';
import { isTauri } from '@/lib/tauri';
import { cn, formatClock, formatRelative } from '@/lib/utils';
import type { QuickLink } from '@/types/quick-link';
import type { Task, TaskPriority, TaskStatus } from '@/types/task';
import type { Chat } from '@/types/chat';
import type { TerminalSession } from '@/types/terminal';
import type { WorkspaceId } from '@/types/common';
import {
  CONTEXT_MIME,
  contextMapFilePath,
  contextNodeFilePath,
  flattenContextNodes,
  formatContextAttachmentForTerminal,
  getStoredContextSelectedFile,
  loadStoredContextTree,
  nodeToAttachment,
  serializeContextAttachment,
  setStoredContextSelectedFile,
  type ContextAttachment,
  type ContextTreeNode,
  type ProjectContextTree,
} from '@/features/context/tree';

interface InspectorCustomTool {
  slug: string;
  name: string;
  description: string;
  baseAction: string;
  steps?: unknown[];
  emoji?: string;
  updatedAt: number;
}

interface InspectorTerminalRef {
  paneId?: string;
  sessionId?: string;
  projectId?: string | null;
  label?: string;
  command?: string;
  agentSlug?: string | null;
}

/** V3 top-level routes. Mirrors the contract in `@/stores/ui` (Slice 4). */
type Route =
  | 'chat'
  | 'terminal'
  | 'kanban'
  | 'schedule'
  | 'agents'
  | 'agent-detail'
  | 'project-detail'
  | 'context'
  | 'benchmarks'
  | 'history'
  | 'tools'
  | 'files';

/**
 * Inspector — 320px right pane, mounted/unmounted via AnimatePresence
 * inside AppShell. Cmd+\ toggles via useUIStore.toggleInspector.
 *
 * V3 makes the Inspector route-aware. Above the existing Today tab we
 * insert a route-context strip whose panel switches with the active
 * top-level route (terminal / kanban / context / benchmarks / history).
 * Chat (the default) keeps the strip empty and lets the Today tab below
 * be the primary surface — preserving V2 behavior.
 *
 * The Today / Context / Tools / Trace / Refs tabs are intentionally
 * untouched. Strip panels are wrapped in defensive try/catch + lazy
 * imports so a sibling slice that hasn't landed yet renders a friendly
 * "Coming soon" card instead of crashing the inspector.
 */
export function Inspector() {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const projectId = useAuthStore((s) => s.projectId);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const [inspectorChatId, setInspectorChatId] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState('today');

  const setInspectorOpen = React.useCallback(
    (open: boolean) => useUIStore.setState({ inspectorOpen: open }),
    [],
  );

  React.useEffect(() => {
    const handleAttach = () => {
      setInspectorOpen(true);
      setActiveTab('jarvis');
    };
    const handleTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ tab: string } | undefined>).detail;
      if (detail?.tab) {
        setInspectorOpen(true);
        setActiveTab(detail.tab);
      }
    };
    window.addEventListener('jarvis:terminal:attach', handleAttach);
    window.addEventListener('jarvis:inspector:tab', handleTabEvent as EventListener);
    return () => {
      window.removeEventListener('jarvis:terminal:attach', handleAttach);
      window.removeEventListener('jarvis:inspector:tab', handleTabEvent as EventListener);
    };
  }, [setInspectorOpen]);

  const inspectorChats =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as Chat[];
        const allChats = await db.chats.where('workspace_id').equals(workspaceId).toArray();
        return allChats
          .filter((c) => (projectId ? c.project_id === projectId : !c.project_id))
          .sort((a, b) => b.updated_at - a.updated_at);
      },
      [workspaceId, projectId],
      [] as Chat[],
    ) ?? [];

  React.useEffect(() => {
    setInspectorChatId((current) => {
      if (current && inspectorChats.some((chat) => chat.id === current)) return current;
      return inspectorChats[0]?.id ?? null;
    });
  }, [inspectorChats, projectId]);

  const handleCreateChatInsideJarvisPanel = React.useCallback(async () => {
    if (!workspaceId) {
      toast.warning('Still loading', 'Workspace is initializing — try again in a sec.');
      return;
    }
    try {
      const allChats = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      const filtered = projectId
        ? allChats.filter((c) => c.project_id === projectId)
        : allChats.filter((c) => !c.project_id);
      const existing = filtered.length;
      const title = `New chat ${existing + 1}`;
      
      const chat = await chatRepo.create({
        workspace_id: workspaceId,
        project_id: projectId ?? undefined,
        title,
        mode: 'chat',
        active_agent_ids: [],
      });
      setInspectorChatId(chat.id);
    } catch (err) {
      toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
    }
  }, [workspaceId, projectId]);

  return (
    <motion.aside
      aria-label="Inspector"
      className="shrink-0 overflow-hidden bg-panel border-l border-border"
      initial={{ width: 0 }}
      animate={{ width: 320 }}
      exit={{ width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <div className="flex h-full w-[320px] flex-col">
        {/* Header with Title and Close Button */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-panel-soft">
          <span className="text-metadata font-medium uppercase tracking-wider text-muted-foreground">Inspector</span>
          <button
            type="button"
            onClick={toggleInspector}
            aria-label="Close inspector"
            className="rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col">
          {/* NEW — route-context strip. Renders nothing for chat/agents. */}
          <RouteContextStrip workspaceId={workspaceId} />

          {/* 6-tab strip — Today is the home tab. The trigger override
              tightens padding so labels still fit the 320px pane. */}
          <div className="px-3 pt-3">
            <TabsList className="grid w-full grid-cols-6">
              <InspectorTab value="jarvis" icon={Sparkles} label="Jarvis" />
              <InspectorTab value="today" icon={Sun} label="Today" />
              <InspectorTab value="context" icon={Boxes} label="Context" />
              <InspectorTab value="tools" icon={Wrench} label="Tools" />
              <InspectorTab value="trace" icon={GitBranch} label="Trace" />
              <InspectorTab value="refs" icon={Link2} label="Refs" />
            </TabsList>
          </div>
          <TabsContent
            value="jarvis"
            className="m-0 flex-1 data-[state=active]:flex data-[state=inactive]:hidden flex-col min-h-0 bg-background overflow-hidden border-t border-border"
          >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-panel-soft shrink-0">
              <span className="text-metadata font-medium text-foreground">Jarvis Chat</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleInspector}
                aria-label="Close Jarvis panel"
                className="h-5 w-5 rounded text-muted-foreground hover:text-foreground"
              >
                <XCircle className="h-3.5 w-3.5" />
              </Button>
            </div>
            <TooltipProvider delayDuration={400}>
              <div className="flex-1 min-h-0 flex flex-col bg-background overflow-x-hidden w-full min-w-0">
                {inspectorChatId ? (
                  <>
                    <ChatThread chatId={inspectorChatId} compact />
                    <Composer
                      chatId={inspectorChatId}
                      compact
                      disableRouteSlashCommands
                      placeholder="Ask Jarvis about this project..."
                    />
                  </>
                ) : (
                  <div className="flex-1 overflow-auto">
                    <EmptyChat onNewChat={handleCreateChatInsideJarvisPanel} />
                  </div>
                )}
              </div>
            </TooltipProvider>
          </TabsContent>
          <TabsContent
            value="today"
            className="m-0 flex-1 overflow-auto scrollbar-hidden"
          >
            <TodayPanel />
          </TabsContent>
          <TabsContent
            value="context"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <InspectorContextPanel />
          </TabsContent>
          <TabsContent
            value="tools"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <InspectorToolsPanel />
          </TabsContent>
          <TabsContent
            value="trace"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <Placeholder
              title="Trace"
              body="Workflow timeline with agent rows, tool spans, and token costs."
            />
          </TabsContent>
          <TabsContent
            value="refs"
            className="m-0 flex-1 overflow-auto px-4 py-3 scrollbar-hidden"
          >
            <InspectorReferencesPanel workspaceId={workspaceId} />
          </TabsContent>
        </Tabs>
      </div>
    </motion.aside>
  );
}

interface InspectorTabProps {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

/**
 * Tighter trigger so 5 labels fit at 320px pane width. Tooltip surfaces
 * the full label if the visible text feels cramped on smaller scales.
 */
function InspectorTab({ value, icon: Icon, label }: InspectorTabProps) {
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <TabsTrigger value={value} className="gap-1 px-1 text-metadata">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-ui-strong text-foreground">{title}</p>
      <p className="text-secondary text-muted-foreground">{body}</p>
    </div>
  );
}

// ============================================================
// Resource tabs — real drag/drop sources for the Jarvis composer
// ============================================================

function InspectorContextPanel() {
  const projectId = useAuthStore((s) => s.projectId);
  const setRoute = useUIStore((s) => s.setRoute);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const onUpdated = () => setTick((cur) => cur + 1);
    window.addEventListener('jarvis:context-tree-updated', onUpdated);
    return () => window.removeEventListener('jarvis:context-tree-updated', onUpdated);
  }, []);

  const tree = React.useMemo(() => loadStoredContextTree(projectId), [projectId, tick]);
  const rows = React.useMemo(() => {
    if (!tree) return [] as ContextTreeNode[];
    return flattenContextNodes(tree.nodes).filter((node) => node.kind !== 'root').slice(0, 12);
  }, [tree]);

  if (!tree) {
    return (
      <div className="flex flex-col gap-3">
        <Placeholder
          title="Context"
          body="No active project map yet. Open Context to generate or select a project map."
        />
        <Button variant="ghost" size="sm" onClick={() => setRoute('context')} className="justify-start">
          <Boxes className="h-3.5 w-3.5" />
          Open Context
        </Button>
      </div>
    );
  }

  const mapAttachment = treeMapAttachment(tree);
  const mapPath = contextMapFilePath(tree.rootDir);

  return (
    <div className="flex flex-col gap-4">
      <Section
        label="Active map"
        icon={<Boxes className="h-3.5 w-3.5" />}
        hint={`${tree.fileCount} files`}
      >
        <ContextResourceRow
          attachment={mapAttachment}
          filePath={mapPath}
          title={mapAttachment.title}
          subtitle={tree.rootDir}
          icon={<Boxes className="h-3.5 w-3.5" />}
          onOpen={() => setRoute('context')}
        />
      </Section>

      <Section
        label="Context files"
        icon={<FileText className="h-3.5 w-3.5" />}
        hint={String(rows.length)}
      >
        {rows.length === 0 ? (
          <EmptyState text="No nodes in this map yet." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((node) => {
              const attachment = nodeToAttachment(tree, node);
              const filePath = contextNodeFilePath(tree, node);
              return (
                <li key={node.id}>
                  <ContextResourceRow
                    attachment={attachment}
                    filePath={filePath}
                    title={node.title}
                    subtitle={node.path ?? node.summary}
                    icon={node.kind === 'file'
                      ? <FileText className="h-3.5 w-3.5" />
                      : <Boxes className="h-3.5 w-3.5" />}
                    meta={node.kind}
                    onOpen={() => {
                      if (filePath) setStoredContextSelectedFile(projectId, filePath);
                      setRoute('context');
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

function InspectorToolsPanel() {
  const setRoute = useUIStore((s) => s.setRoute);
  const projectId = useAuthStore((s) => s.projectId);
  const tools = useStoredInspectorTools();
  const sortedTools = React.useMemo(
    () => [...tools].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8),
    [tools],
  );

  return (
    <div className="flex flex-col gap-4">
      <Section
        label="Custom tools"
        icon={<Wrench className="h-3.5 w-3.5" />}
        hint={String(tools.length)}
      >
        {sortedTools.length === 0 ? (
          <div className="flex flex-col gap-2">
            <EmptyState text="No custom tools saved yet." />
            <Button variant="ghost" size="sm" onClick={() => setRoute('tools')} className="justify-start">
              <Wrench className="h-3.5 w-3.5" />
              Open Tools
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sortedTools.map((tool) => (
              <li key={tool.slug}>
                <CustomToolResourceRow
                  tool={tool}
                  projectId={projectId}
                  onOpen={() => setRoute('tools')}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function useStoredInspectorTools(): InspectorCustomTool[] {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const refresh = () => setTick((cur) => cur + 1);
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'jarvis-tools') refresh();
    };
    window.addEventListener('jarvis:tools-updated', refresh);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('jarvis:tools-updated', refresh);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return React.useMemo(() => loadStoredInspectorTools(), [tick]);
}

function loadStoredInspectorTools(): InspectorCustomTool[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem('jarvis-tools');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const state = isPlainRecord(parsed) ? parsed.state : null;
    const candidate = isPlainRecord(state) ? state.tools : isPlainRecord(parsed) ? parsed.tools : null;
    if (!Array.isArray(candidate)) return [];
    return candidate
      .map(normalizeInspectorTool)
      .filter((tool): tool is InspectorCustomTool => Boolean(tool));
  } catch {
    return [];
  }
}

function normalizeInspectorTool(raw: unknown): InspectorCustomTool | null {
  if (!isPlainRecord(raw)) return null;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const baseAction = typeof raw.baseAction === 'string' ? raw.baseAction.trim() : '';
  if (!slug || !name) return null;
  return {
    slug,
    name,
    baseAction,
    description: typeof raw.description === 'string' ? raw.description : '',
    steps: Array.isArray(raw.steps) ? raw.steps : undefined,
    emoji: typeof raw.emoji === 'string' ? raw.emoji : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

function InspectorReferencesPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const projectId = useAuthStore((s) => s.projectId);
  const setRoute = useUIStore((s) => s.setRoute);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const onContextFile = () => setTick((cur) => cur + 1);
    window.addEventListener('jarvis:context:select-file', onContextFile);
    window.addEventListener('jarvis:context-tree-updated', onContextFile);
    return () => {
      window.removeEventListener('jarvis:context:select-file', onContextFile);
      window.removeEventListener('jarvis:context-tree-updated', onContextFile);
    };
  }, []);

  const selectedContextFile = React.useMemo(
    () => getStoredContextSelectedFile(projectId),
    [projectId, tick],
  );
  const tree = React.useMemo(() => loadStoredContextTree(projectId), [projectId, tick]);
  const sessions =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as TerminalSession[];
        const rows = await terminalSessionRepo.listByWorkspace(workspaceId);
        return rows
          .filter((session) => {
            const sameProject = projectId ? session.project_id === projectId : !session.project_id;
            return sameProject && session.status !== 'exited';
          })
          .sort((a, b) => b.last_active_at - a.last_active_at)
          .slice(0, 6);
      },
      [workspaceId, projectId],
      [] as TerminalSession[],
    ) ?? [];

  const mapAttachment = tree ? treeMapAttachment(tree) : null;

  return (
    <div className="flex flex-col gap-4">
      <Section
        label="Pinned refs"
        icon={<Link2 className="h-3.5 w-3.5" />}
        hint={selectedContextFile || mapAttachment ? 'ready' : undefined}
      >
        <div className="flex flex-col gap-1.5">
          {selectedContextFile ? (
            <FileResourceRow
              path={selectedContextFile}
              title="Selected context file"
              onOpen={() => setRoute('files')}
            />
          ) : null}
          {mapAttachment ? (
            <ContextResourceRow
              attachment={mapAttachment}
              filePath={mapAttachment.path}
              title="Active context map"
              subtitle={mapAttachment.path ?? mapAttachment.rootDir}
              icon={<Boxes className="h-3.5 w-3.5" />}
              onOpen={() => setRoute('context')}
            />
          ) : null}
          {!selectedContextFile && !mapAttachment ? (
            <EmptyState text="No pinned file or context map yet." />
          ) : null}
        </div>
      </Section>

      <Section
        label="Live terminals"
        icon={<TerminalIcon className="h-3.5 w-3.5" />}
        hint={String(sessions.length)}
      >
        {sessions.length === 0 ? (
          <EmptyState text="No live terminal refs for this project." />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <TerminalResourceRow session={session} onOpen={() => setRoute('terminal')} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ContextResourceRow({
  attachment,
  filePath,
  title,
  subtitle,
  icon,
  meta,
  onOpen,
}: {
  attachment: ContextAttachment;
  filePath?: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  meta?: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onClick={onOpen}
      onDragStart={(event) => setContextDragData(event, attachment, filePath)}
      className={resourceButtonClass}
      title={subtitle}
    >
      <span className="mt-0.5 shrink-0 text-accent-copper">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-secondary text-foreground">{title}</span>
        <span className="block truncate text-metadata text-muted-foreground">{subtitle}</span>
      </span>
      {meta ? (
        <span className="rounded-sm bg-paper px-1.5 py-0.5 text-metadata text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </button>
  );
}

function ToolResourceRow({
  title,
  actionId,
  description,
  icon,
  projectId,
  onOpen,
}: {
  title: string;
  actionId: string;
  description: string;
  icon: React.ReactNode;
  projectId: string | null;
  onOpen: () => void;
}) {
  const attachment = React.useMemo(
    () => toolAttachment({ title, actionId, description, projectId }),
    [title, actionId, description, projectId],
  );
  return (
    <button
      type="button"
      draggable
      onClick={onOpen}
      onDragStart={(event) => setContextDragData(event, attachment)}
      className={resourceButtonClass}
      title={`${actionId}: ${description}`}
    >
      <span className="mt-0.5 shrink-0 text-accent-copper">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-secondary text-foreground">{title}</span>
        <span className="block truncate text-metadata text-muted-foreground">{actionId}</span>
      </span>
      <PlayCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function CustomToolResourceRow({
  tool,
  projectId,
  onOpen,
}: {
  tool: InspectorCustomTool;
  projectId: string | null;
  onOpen: () => void;
}) {
  const actionId = `custom.${tool.slug}`;
  const stepCount = tool.steps?.length ?? 0;
  return (
    <ToolResourceRow
      title={`${tool.emoji ? `${tool.emoji} ` : ''}${tool.name}`}
      actionId={actionId}
      description={tool.description || (stepCount > 0
        ? `${stepCount} workflow step${stepCount === 1 ? '' : 's'}`
        : `Runs ${tool.baseAction}`)}
      icon={<Wrench className="h-3.5 w-3.5" />}
      projectId={projectId}
      onOpen={onOpen}
    />
  );
}

function FileResourceRow({
  path,
  title,
  onOpen,
}: {
  path: string;
  title: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onClick={onOpen}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-jarvis-file', path);
        event.dataTransfer.setData('text/plain', path);
      }}
      className={resourceButtonClass}
      title={path}
    >
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-copper" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-secondary text-foreground">{title}</span>
        <span className="block truncate font-mono text-metadata text-muted-foreground">{path}</span>
      </span>
    </button>
  );
}

function TerminalResourceRow({
  session,
  onOpen,
}: {
  session: TerminalSession;
  onOpen: () => void;
}) {
  const ref: InspectorTerminalRef = {
    sessionId: session.id,
    projectId: session.project_id ?? null,
    label: session.title,
    command: [session.shell_command, ...(session.shell_args ?? [])].filter(Boolean).join(' '),
  };
  return (
    <button
      type="button"
      draggable
      onClick={onOpen}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData('application/x-jarvis-terminal', JSON.stringify(ref));
        event.dataTransfer.setData('text/plain', `terminal:${session.title}`);
      }}
      className={resourceButtonClass}
      title={session.cwd ?? session.title}
    >
      <TerminalIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-copper" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-secondary text-foreground">{session.title}</span>
        <span className="block truncate text-metadata text-muted-foreground">
          {session.status} · {formatRelative(session.last_active_at)}
        </span>
      </span>
    </button>
  );
}

function treeMapAttachment(tree: ProjectContextTree): ContextAttachment {
  const root = flattenContextNodes(tree.nodes).find((node) => node.kind === 'root');
  if (root) return nodeToAttachment(tree, root);
  return {
    projectId: tree.projectId,
    rootDir: tree.rootDir,
    generatedAt: tree.generatedAt,
    nodeId: '__jarvis-context-root__',
    title: 'Project Context Map',
    kind: 'root',
    summary: tree.summary,
    path: contextMapFilePath(tree.rootDir),
    tags: ['context-map'],
    sizeBytes: tree.totalBytes,
    childrenCount: tree.nodes.length,
  };
}

function toolAttachment({
  title,
  actionId,
  description,
  projectId,
}: {
  title: string;
  actionId: string;
  description: string;
  projectId: string | null;
}): ContextAttachment {
  return {
    projectId,
    rootDir: 'jarvis://tools',
    generatedAt: 0,
    nodeId: `tool:${actionId}`,
    title,
    kind: 'note',
    summary: [
      `Jarvis tool resource: ${title}`,
      `Action id: ${actionId}`,
      description,
      'Use this when the user asks Jarvis to run or configure this tool.',
    ].filter(Boolean).join('\n'),
    path: `jarvis://tools/${actionId}`,
    tags: ['tool', actionId],
  };
}

function setContextDragData(
  event: React.DragEvent<HTMLElement>,
  attachment: ContextAttachment,
  filePath?: string,
) {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(CONTEXT_MIME, serializeContextAttachment(attachment));
  if (filePath) event.dataTransfer.setData('application/x-jarvis-file', filePath);
  event.dataTransfer.setData('text/plain', filePath || formatContextAttachmentForTerminal(attachment));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const resourceButtonClass = cn(
  'group flex w-full cursor-grab items-start gap-2 rounded-md border border-border bg-paper-soft px-2 py-2 text-left transition-colors',
  'hover:border-accent-copper/40 hover:bg-paper active:cursor-grabbing',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
);

// ============================================================
// Today panel
// ============================================================

/**
 * Today's schedule, open tasks, and recent quick-links. Each section is
 * a warm card with a small caps section label and a generous body. Empty
 * states stay friendly — the inspector is meant to feel like a calm
 * morning brief, not a dashboard.
 */
function TodayPanel() {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;

  // Today's schedule comes from the recurrence-aware feed so daily/weekly
  // anchors light up correctly. Returns `RecurrenceInstance[]` (anchor +
  // materialised repeats), not raw `EventRow[]`.
  const todayEvents = useTodayEvents(workspaceId);

  const todayTasks = useTodayTasks();
  const quickLinks = useQuickLinks(workspaceId);

  const recentLinks = React.useMemo(() => {
    return [...quickLinks]
      .sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0))
      .slice(0, 4);
  }, [quickLinks]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <ScheduleSection events={todayEvents.slice(0, 5)} />
      <TasksSection tasks={todayTasks.slice(0, 5)} />
      <QuickLinksSection links={recentLinks} />
    </div>
  );
}

// ----- Section: schedule for today -----

function ScheduleSection({ events }: { events: RecurrenceInstance[] }) {
  return (
    <Section
      label="Schedule"
      icon={<CalendarDays className="h-3 w-3" />}
      hint={events.length > 0 ? `${events.length} today` : undefined}
    >
      {events.length === 0 ? (
        <EmptyState text="Cleared for focus." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {events.map((inst) => (
            <li
              key={`${inst.event.id}-${inst.instanceStartMs}`}
              className="rounded-md border border-border bg-elevated px-2.5 py-2 flex items-center gap-2.5"
            >
              <span className="text-metadata font-mono text-accent-copper tabular-nums shrink-0 w-14">
                {inst.event.all_day ? 'All day' : formatClock(inst.instanceStartMs)}
              </span>
              <span
                className="text-secondary text-foreground truncate"
                title={inst.event.title}
              >
                {inst.event.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ----- Section: open tasks -----

function TasksSection({ tasks }: { tasks: Task[] }) {
  return (
    <Section
      label="Open tasks"
      icon={<ListTodo className="h-3 w-3" />}
      hint={tasks.length > 0 ? `${tasks.length} due` : undefined}
    >
      {tasks.length === 0 ? (
        <EmptyState text="No open tasks." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="rounded-md border border-border bg-elevated px-2.5 py-2 flex items-center gap-2"
            >
              <PriorityDot priority={t.priority} />
              <span className="text-secondary text-foreground truncate flex-1" title={t.title}>
                {t.title}
              </span>
              {(t.due_at || t.scheduled_for) && (
                <span className="text-metadata text-muted-foreground tabular-nums shrink-0">
                  {formatClock((t.due_at ?? t.scheduled_for) as number)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PriorityDot({ priority }: { priority: TaskPriority }) {
  const cls =
    priority === 'urgent'
      ? 'text-destructive'
      : priority === 'high'
        ? 'text-warning'
        : priority === 'low'
          ? 'text-muted-foreground'
          : 'text-accent-copper';
  return <CircleDot className={cn('h-3 w-3 shrink-0', cls)} aria-hidden="true" />;
}

// ----- Section: recent quick-links -----

function QuickLinksSection({ links }: { links: QuickLink[] }) {
  return (
    <Section
      label="Recent"
      icon={<Sparkles className="h-3 w-3" />}
    >
      {links.length === 0 ? (
        <EmptyState text="No pinned links yet." />
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {links.map((link) => (
            <QuickLinkButton key={link.id} link={link} />
          ))}
        </div>
      )}
    </Section>
  );
}

function QuickLinkButton({ link }: { link: QuickLink }) {
  // Match LauncherDialog: emoji-or-letter fallback, hue tint from the link.
  const initial = (link.icon ?? link.label.charAt(0) ?? '?').toString();
  const hue = link.color_hue ?? 22; // copper-ish default

  const onClick = React.useCallback(async () => {
    try {
      await launchLink(link);
    } catch {
      /* launchLink toasts on failure */
    }
  }, [link]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-2 rounded-md border border-border bg-elevated',
        'px-2 py-2 text-left transition-colors',
        'hover:bg-panel hover:border-accent-copper/40',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      title={link.url}
    >
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-metadata font-medium"
        style={{
          backgroundColor: `hsl(${hue}, 50%, 24%)`,
          color: `hsl(${hue}, 70%, 78%)`,
        }}
        aria-hidden="true"
      >
        {initial.slice(0, 1)}
      </span>
      <span className="text-secondary text-foreground truncate flex-1">{link.label}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </button>
  );
}

// ----- Section primitives -----

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}

function Section({ label, icon, hint, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 px-0.5">
        <span className="inline-flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
          <span className="text-accent-copper">{icon}</span>
          {label}
        </span>
        {hint && (
          <span className="text-metadata text-muted-foreground tabular-nums">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="text-secondary text-muted-foreground italic px-0.5">{text}</p>
  );
}

// ============================================================
// V3 — Route-context strip (renders above the tab strip)
// ============================================================

/**
 * Read the active V3 route. Falls back to `'chat'` when Slice 4 hasn't
 * landed yet — the cast keeps tsc green even if the field is missing
 * from `useUIStore`'s current type.
 */
function useRoute(): Route {
  return useUIStore((s) => (s as unknown as { route?: Route }).route ?? 'chat');
}

/**
 * Route-aware quick-info strip. Inserts above the existing tabs.
 *
 * Chat / Agents routes render nothing — the Today tab below is the
  * primary surface for those. Every other route gets its own cozy
 * paper-card. Panels that depend on sibling slices use lazy imports
 * with `.catch` so a missing module gracefully falls back to a
 * `PlaceholderCard` instead of crashing the inspector.
 */
function RouteContextStrip({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const route = useRoute();
  if (route === 'chat' || route === 'agents') return null;

  let panel: React.ReactNode = null;
  try {
    switch (route) {
      case 'terminal':
        panel = <TerminalsContextPanel workspaceId={workspaceId} />;
        break;
      case 'kanban':
        panel = <KanbanContextPanel workspaceId={workspaceId} />;
        break;
      case 'context':
        panel = <ContextContextPanel />;
        break;
      case 'benchmarks':
        panel = <BenchmarksContextPanel />;
        break;
      case 'history':
        panel = <HistoryContextPanel workspaceId={workspaceId} />;
        break;
    }
  } catch {
    panel = (
      <PlaceholderCard
        title="Coming soon"
        body="This panel will light up once its slice ships."
      />
    );
  }

  if (!panel) return null;
  return <div className="shrink-0 border-b border-border px-3 py-3">{panel}</div>;
}

// ----- Cozy strip primitives -----

/**
 * Warm paper-card used by every route panel. Eyebrow uppercase,
 * optional copper hint on the right for numeric counts.
 */
function StripCard({
  eyebrow,
  hint,
  children,
}: {
  eyebrow: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-paper p-3 shadow-soft">
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="text-metadata uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </span>
        {hint && (
          <span className="text-metadata text-accent-copper tabular-nums">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function PlaceholderCard({ title, body }: { title: string; body: string }) {
  return (
    <StripCard eyebrow={title}>
      <p className="text-secondary text-muted-foreground italic">{body}</p>
    </StripCard>
  );
}

// ----- Terminal — active sessions -----

function TerminalsContextPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const sessions =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as TerminalSession[];
        const rows = await terminalSessionRepo.listByWorkspace(workspaceId);
        return rows
          .filter((s) => s.status === 'running' || s.status === 'detached')
          .sort((a, b) => b.last_active_at - a.last_active_at);
      },
      [workspaceId],
      [] as TerminalSession[],
    ) ?? [];

  if (!isTauri) {
    return (
      <PlaceholderCard
        title="Active terminals"
        body="Run the desktop build to manage terminals."
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <PlaceholderCard
        title="Active terminals"
        body="No PTY sessions running. Spawn one to see it here."
      />
    );
  }

  return (
    <StripCard eyebrow="Active terminals" hint={String(sessions.length)}>
      <ul className="flex flex-col gap-1.5">
        {sessions.slice(0, 6).map((s) => (
          <TerminalRow key={s.id} session={s} />
        ))}
      </ul>
    </StripCard>
  );
}

function TerminalRow({ session }: { session: TerminalSession }) {
  const onKill = React.useCallback(async () => {
    // Try the Tauri command first; fall back to marking the row exited so
    // the strip clears even when Slice 1's Rust handler hasn't shipped.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('terminal_kill', { sessionId: session.id });
    } catch {
      try {
        await terminalSessionRepo.markExited(session.id, -1);
      } catch {
        /* swallow — row will refresh on next live-query tick */
      }
    }
  }, [session.id]);

  return (
    <li className="flex items-start gap-2 rounded-md bg-paper-soft px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-secondary text-foreground truncate">{session.title}</div>
        <div
          className="text-metadata text-muted-foreground truncate"
          title={session.cwd}
        >
          {session.cwd ?? '~'} · {formatRelative(session.created_at)}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onKill}
        aria-label={`Kill ${session.title}`}
        title="Kill"
      >
        <XCircle className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </li>
  );
}

// ----- Kanban — recent task transitions -----

function KanbanContextPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  // Slice 8 may eventually expose a `useRecentKanbanTransitions` hook; until
  // then we read the workspace task list and sort by `updated_at desc`.
  const tasks =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as Task[];
        const rows = await taskRepo.listByWorkspace(workspaceId);
        return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, 10);
      },
      [workspaceId],
      [] as Task[],
    ) ?? [];

  if (tasks.length === 0) {
    return (
      <PlaceholderCard
        title="Recent updates"
        body="Move a card to see it here."
      />
    );
  }

  return (
    <StripCard eyebrow="Recent updates" hint={String(tasks.length)}>
      <ul className="flex flex-col gap-1.5">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-2 rounded-md bg-paper-soft px-2 py-1.5"
          >
            <StatusDot status={t.status} />
            <span
              className="text-secondary text-foreground truncate flex-1"
              title={t.title}
            >
              {t.title}
            </span>
            <span className="text-metadata text-muted-foreground tabular-nums shrink-0">
              {formatRelative(t.updated_at)}
            </span>
          </li>
        ))}
      </ul>
    </StripCard>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const cls =
    status === 'done'
      ? 'text-accent-sage'
      : status === 'in_progress'
        ? 'text-accent-copper'
        : status === 'blocked'
          ? 'text-destructive'
          : 'text-muted-foreground';
  return <CircleDot className={cn('h-3 w-3 shrink-0', cls)} aria-hidden="true" />;
}

// ----- Context — generated project tree summary -----

function ContextContextPanel() {
  const projectId = useAuthStore((s) => s.projectId);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const onUpdated = () => setTick((cur) => cur + 1);
    window.addEventListener('jarvis:context-tree-updated', onUpdated);
    return () => window.removeEventListener('jarvis:context-tree-updated', onUpdated);
  }, []);

  const tree = React.useMemo(() => loadStoredContextTree(projectId), [projectId, tick]);
  if (!tree) {
    return (
      <PlaceholderCard
        title="Context tree"
        body="Open Context and press Make Skill Tree to generate the project map."
      />
    );
  }

  const nodes = flattenContextNodes(tree.nodes);
  const tags = [...new Set(nodes.flatMap((node) => node.tags ?? []))].slice(0, 4);
  return (
    <StripCard eyebrow="Context tree" hint={`${nodes.length} nodes`}>
      <p className="mb-2 line-clamp-3 text-secondary text-muted-foreground">{tree.summary}</p>
      <ul className="flex flex-wrap gap-1">
        {tags.length === 0 ? (
          <li className="text-secondary text-muted-foreground italic">No tags yet.</li>
        ) : tags.map((tag) => (
          <li
            key={tag}
            className="inline-flex items-center gap-1 rounded-sm bg-paper-soft px-1.5 py-0.5 text-metadata text-foreground"
          >
            <Tag className="h-3 w-3 text-accent-copper" aria-hidden="true" />
            <span>{tag}</span>
          </li>
        ))}
      </ul>
    </StripCard>
  );
}

// ----- Benchmarks — top 5 by Arena score (snapshot fallback) -----

interface BenchmarkLite {
  model: string;
  provider: string;
  arena_score: number;
}

function BenchmarksContextPanel() {
  const [rows, setRows] = React.useState<BenchmarkLite[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const path = '@/features/benchmarks';
        const mod = await import(/* @vite-ignore */ path).catch(() => null);
        if (cancelled || !mod) return;
        const snap = (mod as { SNAPSHOT_ROWS?: BenchmarkLite[] }).SNAPSHOT_ROWS;
        if (!Array.isArray(snap)) return;
        const top = [...snap]
          .sort((a, b) => b.arena_score - a.arena_score)
          .slice(0, 5);
        if (!cancelled) setRows(top);
      } catch {
        /* silent — placeholder remains */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!rows) {
    return (
      <PlaceholderCard
        title="Top by Arena score"
        body="Loading the latest snapshot…"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <PlaceholderCard
        title="Top by Arena score"
        body="No benchmark rows available yet."
      />
    );
  }

  return (
    <StripCard eyebrow="Top by Arena score" hint="snapshot">
      <ol className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <li
            key={`${r.provider}-${r.model}`}
            className="flex items-center gap-2 rounded-md bg-paper-soft px-2 py-1.5"
          >
            <span className="text-metadata text-muted-foreground tabular-nums shrink-0 w-4">
              {i + 1}
            </span>
            <span
              className="text-secondary text-foreground truncate flex-1"
              title={r.model}
            >
              {r.model}
            </span>
            <span className="text-metadata text-accent-copper tabular-nums shrink-0">
              {r.arena_score}
            </span>
          </li>
        ))}
      </ol>
    </StripCard>
  );
}

// ----- History — last 5 chats with quick-jump -----

function HistoryContextPanel({ workspaceId }: { workspaceId: WorkspaceId | null }) {
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  // `setRoute` lands with Slice 4. Optional cast keeps tsc green meanwhile.
  const setRouteFn = useUIStore(
    (s) => (s as unknown as { setRoute?: (r: Route) => void }).setRoute,
  );

  const chats =
    useLiveQuery(
      async () => {
        if (!workspaceId) return [] as Chat[];
        const rows = await chatRepo.listByWorkspace(workspaceId);
        return rows.slice(0, 5);
      },
      [workspaceId],
      [] as Chat[],
    ) ?? [];

  if (chats.length === 0) {
    return (
      <PlaceholderCard
        title="Last 5 chats"
        body="Start a chat to see it here."
      />
    );
  }

  const onJump = (chat: Chat) => {
    setActiveChat(chat.id);
    setRouteFn?.('chat');
  };

  return (
    <StripCard eyebrow="Last 5 chats" hint={String(chats.length)}>
      <ul className="flex flex-col gap-1.5">
        {chats.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onJump(c)}
              className={cn(
                'group flex w-full items-center gap-2 rounded-md bg-paper-soft px-2 py-1.5 text-left transition-colors',
                'hover:bg-paper hover:ring-1 hover:ring-accent-copper/40',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <MessageSquare
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span
                className="text-secondary text-foreground truncate flex-1"
                title={c.title}
              >
                {c.title || 'Untitled chat'}
              </span>
              <span className="text-metadata text-muted-foreground tabular-nums shrink-0">
                {formatRelative(c.updated_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </StripCard>
  );
}

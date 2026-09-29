import { Command } from 'cmdk';
import { Calendar, LayoutGrid, MessageSquare } from 'lucide-react';
import * as React from 'react';
import { cn, formatRelative, renderHotkey } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { AgentBadge } from '@/features/agents/AgentBadge';
import {
  createCanvasGlobalSearchIndex,
  createCanvasPersistenceRepository,
  requestCanvasGlobalSearchNavigation,
  type CanvasDocument,
  type CanvasPersistenceRepository,
} from '@/features/canvas';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { chatRepo, db } from '@/lib/db';
import type { AgentId } from '@/types';
import type { ChatId } from '@/types/common';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import {
  type Action,
  type ActionContext,
  actionSearchValue,
  emitJarvisEvent,
  useActionsForPage,
} from './actions';
import {
  type PageId,
  type RecentChat,
  type TaskListItem,
  usePaletteDataStore,
  usePaletteStore,
} from './store';

/* ------------------------------------------------------------------------- */
/* Shared item primitives                                                    */
/* ------------------------------------------------------------------------- */

const ITEM_BASE =
  'flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer select-none ' +
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground ' +
  'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

function HotkeyHint({ hotkey }: { hotkey: string }) {
  // Split the rendered hotkey into per-key chips for a more refined look.
  const rendered = renderHotkey(hotkey);
  const tokens = rendered.split(' ').filter(Boolean);
  return (
    <span className="ml-auto flex items-center gap-1 shrink-0">
      {tokens.map((t, i) => (
        <kbd key={i} className="kbd">
          {t}
        </kbd>
      ))}
    </span>
  );
}

function ActionItem({ action, ctx }: { action: Action; ctx: ActionContext }) {
  const Icon = action.icon;
  return (
    <Command.Item
      value={`${action.id} ${actionSearchValue(action)}`}
      onSelect={() => action.perform(ctx)}
      className={ITEM_BASE}
    >
      {Icon ? (
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      <span className="text-body text-foreground truncate">{action.label}</span>
      {action.description ? (
        <span className="text-secondary text-muted-foreground truncate">
          &mdash; {action.description}
        </span>
      ) : null}
      {action.hotkey ? <HotkeyHint hotkey={action.hotkey} /> : null}
    </Command.Item>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-6 text-center text-secondary text-muted-foreground">{children}</div>
  );
}

function GroupedActions({ ctx, actions }: { ctx: ActionContext; actions: Action[] }) {
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((a) => (
        <ActionItem key={a.id} action={a} ctx={ctx} />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Root page                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Lightweight category buckets for the root page so the palette has visual
 * structure without us having to encode a per-category field on every action.
 */
const ROOT_CATEGORIES: { heading: string; ids: string[] }[] = [
  { heading: 'Create', ids: ['new-chat', 'new-task'] },
  { heading: 'Switch', ids: ['switch-agent', 'switch-mode', 'theme'] },
  { heading: 'Browse', ids: ['recent-chats', 'tasks'] },
  {
    heading: 'App',
    ids: ['settings', 'toggle-voice', 'toggle-nav', 'toggle-inspector'],
  },
];

const CANVAS_SEARCH_VIEWPORT = Object.freeze({ width: 1_200, height: 800 });

export function CanvasGlobalSearchItems({
  ctx,
  repository,
}: {
  ctx: ActionContext;
  repository?: CanvasPersistenceRepository;
}) {
  const cloudSession = useAuthStore((state) => state.cloudSession);
  const localUserId = useAuthStore((state) => state.localUserId);
  const projectId = useAuthStore((state) => state.projectId);
  const search = usePaletteStore((state) => state.search);
  const defaultRepository = React.useMemo(() => createCanvasPersistenceRepository(db), []);
  const activeRepository = repository ?? defaultRepository;
  const accountId = resolveAccountIdentity({ cloudSession, localUserId })?.accountId ?? null;
  const activeProjectId = projectId ?? 'local-project';
  const [documents, setDocuments] = React.useState<readonly CanvasDocument[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    setDocuments([]);
    if (accountId === null) return () => undefined;
    const scope = {
      accountId,
      ownerId: accountId,
      projectId: activeProjectId,
    };
    void activeRepository.list(scope).then(
      (loaded) => {
        if (!cancelled) setDocuments(loaded);
      },
      () => {
        if (!cancelled) setDocuments([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, activeProjectId, activeRepository]);

  const index = React.useMemo(() => {
    if (accountId === null || documents.length === 0) return undefined;
    try {
      return createCanvasGlobalSearchIndex({
        ownerId: accountId,
        projectId: activeProjectId,
        documents,
      });
    } catch {
      return undefined;
    }
  }, [accountId, activeProjectId, documents]);

  const results = React.useMemo(() => {
    const text = search.trim();
    if (!index || text.length < 2) return [];
    try {
      return index.query({ text, limit: 20 });
    } catch {
      return [];
    }
  }, [index, search]);

  if (accountId === null || results.length === 0) return null;
  const scope = { ownerId: accountId, projectId: activeProjectId };

  return (
    <Command.Group heading="Canvas" className="palette-group">
      {results.map((result) => (
        <Command.Item
          key={`${result.documentId}:${result.objectId}`}
          value={`canvas ${result.canvasTitle} ${result.label} ${result.objectType}`}
          onSelect={() => {
            requestCanvasGlobalSearchNavigation(result, scope, CANVAS_SEARCH_VIEWPORT);
            useUIStore.getState().setRoute('canvas');
            ctx.closePalette();
          }}
          className={ITEM_BASE}
        >
          <LayoutGrid className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
          <span className="text-body text-foreground truncate">{result.label}</span>
          <span className="text-secondary text-muted-foreground truncate">
            &mdash; {result.canvasTitle}
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}

function RootPage({ ctx }: { ctx: ActionContext }) {
  const all = useActionsForPage('root');
  const byId = new Map(all.map((a) => [a.id, a]));
  const usedIds = new Set<string>();

  return (
    <>
      {ROOT_CATEGORIES.map((cat) => {
        const items = cat.ids.map((id) => byId.get(id)).filter(Boolean) as Action[];
        items.forEach((a) => usedIds.add(a.id));
        if (items.length === 0) return null;
        return (
          <Command.Group key={cat.heading} heading={cat.heading} className="palette-group">
            <GroupedActions ctx={ctx} actions={items} />
          </Command.Group>
        );
      })}

      {/* Anything registered dynamically that we didn't bucket - render under "Other". */}
      {(() => {
        const extras = all.filter((a) => !usedIds.has(a.id));
        if (extras.length === 0) return null;
        return (
          <Command.Group heading="Other" className="palette-group">
            <GroupedActions ctx={ctx} actions={extras} />
          </Command.Group>
        );
      })()}
      <CanvasGlobalSearchItems ctx={ctx} />
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Theme page                                                                */
/* ------------------------------------------------------------------------- */

function ThemePage({ ctx }: { ctx: ActionContext }) {
  const actions = useActionsForPage('theme');
  return (
    <Command.Group heading="Theme" className="palette-group">
      <GroupedActions ctx={ctx} actions={actions} />
    </Command.Group>
  );
}

/* ------------------------------------------------------------------------- */
/* Switch chat mode page                                                     */
/* ------------------------------------------------------------------------- */

function SwitchModePage({ ctx }: { ctx: ActionContext }) {
  const actions = useActionsForPage('switch-mode');
  const currentMode = useUIStore((s) => s.chatMode);
  return (
    <Command.Group heading="Chat mode" className="palette-group">
      {actions.map((a) => {
        const Icon = a.icon;
        const isActive =
          (a.id === 'mode-chat' && currentMode === 'chat') ||
          (a.id === 'mode-council' && currentMode === 'council') ||
          (a.id === 'mode-doc' && currentMode === 'doc') ||
          (a.id === 'mode-code' && currentMode === 'code');
        return (
          <Command.Item
            key={a.id}
            value={`${a.id} ${actionSearchValue(a)}`}
            onSelect={() => a.perform(ctx)}
            className={ITEM_BASE}
          >
            {Icon ? (
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
            ) : (
              <span className="h-4 w-4 shrink-0" />
            )}
            <span className="text-body text-foreground truncate">{a.label}</span>
            {a.description ? (
              <span className="text-secondary text-muted-foreground truncate">
                &mdash; {a.description}
              </span>
            ) : null}
            {isActive ? (
              <span className="ml-auto text-secondary text-accent-cyan shrink-0">Active</span>
            ) : null}
          </Command.Item>
        );
      })}
    </Command.Group>
  );
}

/* ------------------------------------------------------------------------- */
/* New page (extension hook for future "new ..." flows)                      */
/* ------------------------------------------------------------------------- */

function NewPage({ ctx }: { ctx: ActionContext }) {
  const actions = useActionsForPage('new');
  return (
    <Command.Group heading="Create" className="palette-group">
      <GroupedActions ctx={ctx} actions={actions} />
    </Command.Group>
  );
}

/* ------------------------------------------------------------------------- */
/* Switch agent page                                                         */
/* ------------------------------------------------------------------------- */

async function switchAgentForCurrentChat(agentId: AgentId, closePalette: () => void) {
  const { activeChatId, route } = useUIStore.getState();
  const { workspaceId, projectId } = useAuthStore.getState();
  if (route !== 'chat' || !activeChatId || !workspaceId) {
    toast.warning('No active chat', 'Open a chat before switching its agent.');
    return;
  }

  try {
    const chat = await chatRepo.getById(activeChatId as ChatId);
    if (
      !chat ||
      chat.archived ||
      chat.mode !== 'chat' ||
      chat.workspace_id !== workspaceId ||
      (chat.project_id ?? null) !== (projectId ?? null) ||
      !useAgentStore.getState().agents[agentId]
    ) {
      throw new Error('The active chat or agent is no longer available.');
    }
    const currentUI = useUIStore.getState();
    const currentAuth = useAuthStore.getState();
    if (
      currentUI.route !== 'chat' ||
      currentUI.activeChatId !== activeChatId ||
      currentAuth.workspaceId !== workspaceId ||
      currentAuth.projectId !== projectId
    ) {
      throw new Error('The active chat changed. Select the agent again.');
    }
    if (chat.active_agent_ids.length !== 1 || chat.active_agent_ids[0] !== agentId) {
      await chatRepo.update(chat.id, { active_agent_ids: [agentId] });
    }
    closePalette();
  } catch (error) {
    toast.error('Could not switch agent', error instanceof Error ? error.message : 'Try again.');
  }
}

function SwitchAgentPage({ ctx }: { ctx: ActionContext }) {
  const agentMap = useAgentStore((s) => s.agents);
  const agents = React.useMemo(
    () => Object.values(agentMap).sort((a, b) => a.name.localeCompare(b.name)),
    [agentMap],
  );
  const customActions = useActionsForPage('switch-agent');

  if (agents.length === 0 && customActions.length === 0) {
    return <EmptyHint>No agents registered.</EmptyHint>;
  }

  return (
    <>
      <Command.Group heading="Agents" className="palette-group">
        {agents.map((agent) => (
          <Command.Item
            key={agent.id}
            value={`agent ${agent.slug} ${agent.name} ${agent.description}`}
            onSelect={() => {
              void switchAgentForCurrentChat(agent.id, ctx.closePalette);
            }}
            className={ITEM_BASE}
          >
            <AgentBadge agent={agent} showName={false} size="md" />
            <span className="text-body text-foreground truncate">{agent.name}</span>
            {agent.description ? (
              <span className="text-secondary text-muted-foreground truncate">
                &mdash; {agent.description}
              </span>
            ) : null}
            <span className="ml-auto text-metadata text-muted-foreground font-mono shrink-0">
              {agent.model.model}
            </span>
          </Command.Item>
        ))}
      </Command.Group>

      {customActions.length > 0 ? (
        <Command.Group heading="Actions" className="palette-group">
          <GroupedActions ctx={ctx} actions={customActions} />
        </Command.Group>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Recent chats page                                                         */
/* ------------------------------------------------------------------------- */

function RecentChatItem({ chat, onSelect }: { chat: RecentChat; onSelect: (id: string) => void }) {
  return (
    <Command.Item
      value={`chat ${chat.id} ${chat.title}`}
      onSelect={() => onSelect(chat.id)}
      className={ITEM_BASE}
    >
      <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
      <span className="text-body text-foreground truncate">{chat.title || 'Untitled chat'}</span>
      <span className="ml-auto text-metadata text-muted-foreground shrink-0">
        {formatRelative(chat.updated_at)}
      </span>
    </Command.Item>
  );
}

function RecentChatsPage({ ctx }: { ctx: ActionContext }) {
  const chats = usePaletteDataStore((s) => s.recentChats);
  const setActiveChat = useUIStore((s) => s.setActiveChat);

  if (chats.length === 0) {
    return <EmptyHint>No recent chats yet.</EmptyHint>;
  }

  return (
    <Command.Group heading="Recent chats" className="palette-group">
      {chats.slice(0, 20).map((chat) => (
        <RecentChatItem
          key={chat.id}
          chat={chat}
          onSelect={(id) => {
            setActiveChat(id);
            emitJarvisEvent('jarvis:open-chat', { chatId: id });
            ctx.closePalette();
          }}
        />
      ))}
    </Command.Group>
  );
}

/* ------------------------------------------------------------------------- */
/* Tasks page                                                                */
/* ------------------------------------------------------------------------- */

function TaskItem({ task, onSelect }: { task: TaskListItem; onSelect: (id: string) => void }) {
  return (
    <Command.Item
      value={`task ${task.id} ${task.title}`}
      onSelect={() => onSelect(task.id)}
      className={ITEM_BASE}
    >
      <Calendar className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
      <span className="text-body text-foreground truncate">{task.title}</span>
      {typeof task.due_at === 'number' ? (
        <span className="ml-auto text-metadata text-muted-foreground shrink-0">
          due {formatRelative(task.due_at)}
        </span>
      ) : null}
    </Command.Item>
  );
}

function TasksPage({ ctx }: { ctx: ActionContext }) {
  const tasks = usePaletteDataStore((s) => s.tasks);
  if (tasks.length === 0) {
    return <EmptyHint>No open tasks.</EmptyHint>;
  }
  return (
    <Command.Group heading="Tasks" className="palette-group">
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          onSelect={(id) => {
            emitJarvisEvent('jarvis:open-task', { taskId: id });
            ctx.closePalette();
          }}
        />
      ))}
    </Command.Group>
  );
}

/* ------------------------------------------------------------------------- */
/* Page dispatcher                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Render the appropriate page contents inside the palette's command list.
 * Receives the {@link ActionContext} so leaf items can drive navigation.
 */
export function PageContent({ page, ctx }: { page: PageId; ctx: ActionContext }) {
  switch (page) {
    case 'root':
      return <RootPage ctx={ctx} />;
    case 'theme':
      return <ThemePage ctx={ctx} />;
    case 'switch-agent':
      return <SwitchAgentPage ctx={ctx} />;
    case 'switch-mode':
      return <SwitchModePage ctx={ctx} />;
    case 'new':
      return <NewPage ctx={ctx} />;
    case 'recent-chats':
      return <RecentChatsPage ctx={ctx} />;
    case 'tasks':
      return <TasksPage ctx={ctx} />;
    default:
      return null;
  }
}

/**
 * Convenience class for group headings - exported so the palette can target
 * the same selector if needed. Tailwind classes are also valid here.
 */
export const PAGE_GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1',
  '[&_[cmdk-group-heading]]:text-metadata [&_[cmdk-group-heading]]:uppercase',
  '[&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground',
);

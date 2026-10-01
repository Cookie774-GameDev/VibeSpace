import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, MessageSquare, Trash2 } from 'lucide-react';
import { chatRepo, db, projectRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { cn, formatRelative } from '@/lib/utils';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import type { BrowserChatBindingRow, BrowserChatSnapshotRow, Project } from '@/lib/db/schema';
import type { Chat, ChatId, ProjectId, WorkspaceId } from '@/types';
import { deleteHistoryChats, historyDeletionFeedback } from './historyDeletion';
import { browserChatProvider } from '@/features/browser-chat/providerRegistry';
import { createChatGptSnapshotRepository } from '@/features/browser-chat/chatGptExport';

const snapshotRepository = createChatGptSnapshotRepository(db);

export interface HistoryListProps {
  selectedChatId: ChatId | null;
  selectedSnapshotId?: string | null;
  onSelectChat: (id: ChatId | null) => void;
  onSelectSnapshot?: (id: string | null) => void;
  onOpenBrowserChat?: (id: ChatId) => void;
}

type ProjectFilter = 'all' | 'active';

interface PendingHistoryDeletion {
  chatIds?: ChatId[];
  snapshotId?: string;
  expectedAccountId: string;
  expectedWorkspaceId: string;
  title: string;
  description: string;
  confirmLabel: string;
}

const MAX_ROWS = 200;

/**
 * Left rail of the Session History page.
 *
 * Live-streams chats for the active workspace, sorted by `updated_at desc`
 * and capped at {@link MAX_ROWS}. Search is best-effort: titles are filtered
 * client-side, and a second live query scans message text for matches when
 * the query is at least 2 chars (kept off below that to avoid a full scan
 * on every keystroke).
 *
 * The project filter chip row is intentionally minimal — "All projects" or
 * the user's active project. Switching projects elsewhere in the app
 * automatically updates the chip.
 */
export function HistoryList({
  selectedChatId,
  selectedSnapshotId = null,
  onSelectChat,
  onSelectSnapshot,
  onOpenBrowserChat,
}: HistoryListProps) {
  const accountId = useAuthStore((s) => resolveAccountIdentity(s)?.accountId ?? null);
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const activeProjectId = useAuthStore((s) => s.projectId) as ProjectId | null;
  const agents = useAgentStore((s) => s.agents);

  const [query, setQuery] = React.useState('');
  const [projectFilter, setProjectFilter] = React.useState<ProjectFilter>('all');
  const [deleting, setDeleting] = React.useState(false);
  const [pendingDeletion, setPendingDeletion] = React.useState<PendingHistoryDeletion | null>(null);
  const cancelDeletionRef = React.useRef<HTMLButtonElement>(null);
  const selectedChatIdRef = React.useRef(selectedChatId);
  const selectedSnapshotIdRef = React.useRef(selectedSnapshotId);

  React.useLayoutEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);
  React.useLayoutEffect(() => {
    selectedSnapshotIdRef.current = selectedSnapshotId;
  }, [selectedSnapshotId]);

  React.useEffect(() => {
    if (
      pendingDeletion &&
      (pendingDeletion.expectedAccountId !== accountId ||
        pendingDeletion.expectedWorkspaceId !== String(workspaceId ?? ''))
    ) {
      setPendingDeletion(null);
    }
  }, [accountId, pendingDeletion, workspaceId]);

  // Live chat list, scoped to workspace, sorted newest-first, capped.
  const chats = useLiveQuery(
    async () => {
      if (!workspaceId) return [] as Chat[];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      rows.sort((a, b) => b.updated_at - a.updated_at);
      return rows.slice(0, MAX_ROWS);
    },
    [workspaceId],
    [] as Chat[],
  );

  // Project lookup, used to render the project chip on each row.
  const projects = useLiveQuery(
    async () => (workspaceId ? projectRepo.listByWorkspace(workspaceId) : []),
    [workspaceId],
    [] as Project[],
  );
  const projectById = React.useMemo(() => {
    const map: Record<string, Project> = {};
    for (const p of projects ?? []) map[p.id as unknown as string] = p;
    return map;
  }, [projects]);
  const activeProject = activeProjectId
    ? projectById[activeProjectId as unknown as string]
    : undefined;

  // Per-chat message count. One live scan over the messages table — fine for
  // single-user offline data and keeps row rendering O(1).
  const messageCounts = useLiveQuery(
    async () => {
      const map: Record<string, number> = {};
      await db.messages.each((m) => {
        const cid = m.chat_id as unknown as string;
        map[cid] = (map[cid] ?? 0) + 1;
      });
      return map;
    },
    [],
    {} as Record<string, number>,
  );

  // Best-effort message-content search. Only runs at length>=2 so casual
  // typing doesn't trigger full table scans.
  const messageMatches = useLiveQuery(
    async () => {
      const q = query.trim().toLowerCase();
      if (q.length < 2) return null;
      const ids = new Set<string>();
      await db.messages.each((m) => {
        for (const part of m.parts) {
          if (
            (part.kind === 'text' || part.kind === 'reasoning') &&
            part.text.toLowerCase().includes(q)
          ) {
            ids.add(m.chat_id as unknown as string);
            break;
          }
        }
      });
      return ids;
    },
    [query],
    null as Set<string> | null,
  );

  const browserBindings = useLiveQuery(
    async () => {
      if (!accountId || !workspaceId) return [] as BrowserChatBindingRow[];
      return db.browser_chat_bindings
        .where('[accountId+workspaceId]')
        .equals([accountId, String(workspaceId)])
        .toArray();
    },
    [accountId, workspaceId],
    [] as BrowserChatBindingRow[],
  );
  const browserBindingByChatId = React.useMemo(
    () => new Map(browserBindings.map((binding) => [binding.chatId, binding] as const)),
    [browserBindings],
  );

  const importedSnapshots = useLiveQuery(
    async () => {
      if (!accountId || !workspaceId) return [] as BrowserChatSnapshotRow[];
      const rows = await db.browser_chat_snapshots
        .where('[accountId+workspaceId]')
        .equals([accountId, String(workspaceId)])
        .toArray();
      return rows.sort((left, right) => right.updatedAt - left.updatedAt);
    },
    [accountId, workspaceId],
    [] as BrowserChatSnapshotRow[],
  );

  const filtered = React.useMemo(() => {
    let rows = chats ?? [];
    if (projectFilter === 'active' && activeProjectId) {
      rows = rows.filter((c) => c.project_id === activeProjectId);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((c) => {
        const titleHit = c.title.toLowerCase().includes(q);
        const bodyHit = messageMatches?.has(c.id as unknown as string) ?? false;
        return titleHit || bodyHit;
      });
    }
    return rows;
  }, [chats, query, projectFilter, activeProjectId, messageMatches]);

  const filteredSnapshots = React.useMemo(() => {
    if (projectFilter === 'active') return [] as BrowserChatSnapshotRow[];
    const q = query.trim().toLocaleLowerCase();
    if (!q) return importedSnapshots;
    return importedSnapshots.filter(
      (snapshot) =>
        snapshot.title.toLocaleLowerCase().includes(q) ||
        snapshot.messages.some((message) => message.text.toLocaleLowerCase().includes(q)),
    );
  }, [importedSnapshots, projectFilter, query]);

  const removeChats = async (request: PendingHistoryDeletion) => {
    const chatIds = request.chatIds ?? [];
    if (deleting || chatIds.length === 0) return;
    setDeleting(true);
    try {
      const result = await deleteHistoryChats(chatIds.map(String), {
        expectedAccountId: request.expectedAccountId,
        expectedWorkspaceId: request.expectedWorkspaceId,
        getActiveAccountId: () =>
          resolveAccountIdentity(useAuthStore.getState())?.accountId ?? null,
        getActiveWorkspaceId: () => {
          const active = useAuthStore.getState().workspaceId;
          return active ? String(active) : null;
        },
        read: (chatId) => chatRepo.getById(chatId as ChatId),
        remove: (chatId) =>
          chatRepo.deleteAuthorized(chatId as ChatId, {
            expectedAccountId: request.expectedAccountId,
            expectedWorkspaceId: request.expectedWorkspaceId,
            getActiveAccountId: () =>
              resolveAccountIdentity(useAuthStore.getState())?.accountId ?? null,
            getActiveWorkspaceId: () => {
              const active = useAuthStore.getState().workspaceId;
              return active ? String(active) : null;
            },
          }),
      });
      const feedback = historyDeletionFeedback(
        result,
        selectedChatIdRef.current ? String(selectedChatIdRef.current) : null,
      );
      if (feedback.clearSelection) onSelectChat(null);
      toast[feedback.tone](feedback.title, feedback.message);
    } catch (error) {
      toast.error(
        'Could not delete history',
        error instanceof Error ? error.message : 'The operation failed safely.',
      );
    } finally {
      setDeleting(false);
    }
  };

  const removeSnapshot = async (request: PendingHistoryDeletion) => {
    if (deleting || !request.snapshotId) return;
    setDeleting(true);
    try {
      if (
        resolveAccountIdentity(useAuthStore.getState())?.accountId !== request.expectedAccountId ||
        String(useAuthStore.getState().workspaceId ?? '') !== request.expectedWorkspaceId
      ) {
        throw new Error('history_scope_changed');
      }
      await snapshotRepository.remove(
        {
          accountId: request.expectedAccountId,
          workspaceId: request.expectedWorkspaceId,
        },
        request.snapshotId,
      );
      if (selectedSnapshotIdRef.current === request.snapshotId) onSelectSnapshot?.(null);
      toast.success(
        'Local snapshot deleted',
        'The imported copy was removed. The original ChatGPT conversation was not changed.',
      );
    } catch (error) {
      toast.error(
        'Could not delete snapshot',
        error instanceof Error ? error.message : 'The operation failed safely.',
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <aside
      aria-label="Past chats"
      data-sakura-surface="history-list"
      className="flex w-[320px] shrink-0 flex-col border-r border-border bg-panel"
    >
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-page-title text-foreground">History</h2>
          <p className="eyebrow mt-0.5">Past chats · replay</p>
        </div>
        <button
          type="button"
          disabled={deleting || filtered.length === 0}
          onClick={() => {
            if (!accountId || !workspaceId) return;
            const count = filtered.length;
            setPendingDeletion({
              chatIds: filtered.map((chat) => chat.id),
              expectedAccountId: accountId,
              expectedWorkspaceId: String(workspaceId),
              title: `Delete ${count} visible chat${count === 1 ? '' : 's'}?`,
              description: `${count} visible chat${count === 1 ? '' : 's'} will be permanently deleted from this workspace.`,
              confirmLabel: `Delete ${count} chat${count === 1 ? '' : 's'}`,
            });
          }}
          className="rounded px-2 py-1 text-metadata text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
        >
          Clear visible
        </button>
      </header>

      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or message"
            aria-label="Search past chats"
            className="pl-7"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <FilterChip
            active={projectFilter === 'all'}
            onClick={() => setProjectFilter('all')}
            label="All projects"
          />
          {activeProject && (
            <FilterChip
              active={projectFilter === 'active'}
              onClick={() => setProjectFilter('active')}
              label={activeProject.name}
              hue={activeProject.color_hue}
            />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden">
        {filteredSnapshots.length > 0 ? (
          <section aria-labelledby="imported-chatgpt-snapshots-heading" className="py-1">
            <h3
              id="imported-chatgpt-snapshots-heading"
              className="px-4 py-1 text-metadata font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Imported ChatGPT snapshots
            </h3>
            <ul className="flex flex-col">
              {filteredSnapshots.map((snapshot) => {
                const selected = selectedSnapshotId === snapshot.id;
                return (
                  <li key={snapshot.id} className="group flex items-start gap-1 px-1">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectChat(null);
                        onSelectSnapshot?.(snapshot.id);
                      }}
                      aria-current={selected ? 'true' : undefined}
                      className={cn(
                        'flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors',
                        'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        selected && 'bg-paper ring-1 ring-accent-copper/40',
                      )}
                    >
                      <Avatar seed={`chatgpt:${snapshot.id}`} size={24} className="mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-ui-strong text-foreground">
                            {snapshot.title}
                          </span>
                          <span className="shrink-0 text-metadata text-muted-foreground">
                            {formatRelative(snapshot.updatedAt)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <RowChip label="Imported snapshot · ChatGPT" />
                          <RowChip
                            icon={<MessageSquare className="h-3 w-3" />}
                            label={`${snapshot.messageCount} msg${snapshot.messageCount === 1 ? '' : 's'}`}
                          />
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      disabled={deleting}
                      aria-label={`Delete imported snapshot ${snapshot.title}`}
                      onClick={() => {
                        if (!accountId || !workspaceId) return;
                        setPendingDeletion({
                          snapshotId: snapshot.id,
                          expectedAccountId: accountId,
                          expectedWorkspaceId: String(workspaceId),
                          title: `Delete local snapshot ${snapshot.title}?`,
                          description:
                            'Only this imported local snapshot will be deleted. The original ChatGPT conversation and export file are not changed.',
                          confirmLabel: 'Delete local snapshot',
                        });
                      }}
                      className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {(chats ?? []).length === 0 && filteredSnapshots.length === 0 ? (
          <EmptyState message="No past chats yet." />
        ) : filtered.length === 0 && filteredSnapshots.length === 0 ? (
          <EmptyState message="No chats match this search." />
        ) : filtered.length > 0 ? (
          <ul className="flex flex-col py-1">
            {filtered.map((chat) => {
              const firstAgentId = chat.active_agent_ids?.[0];
              const agent = firstAgentId ? agents[firstAgentId] : undefined;
              const seed = agent?.slug ?? (chat.id as unknown as string);
              const project = chat.project_id
                ? projectById[chat.project_id as unknown as string]
                : undefined;
              const count = messageCounts?.[chat.id as unknown as string] ?? 0;
              const browserBinding = browserBindingByChatId.get(String(chat.id));
              const selected =
                (selectedChatId as unknown as string) === (chat.id as unknown as string);
              return (
                <li
                  key={chat.id as unknown as string}
                  className="group flex items-start gap-1 px-1"
                >
                  <button
                    type="button"
                    onClick={() =>
                      browserBinding && onOpenBrowserChat
                        ? onOpenBrowserChat(chat.id)
                        : onSelectChat(chat.id)
                    }
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors',
                      'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      selected &&
                        'bg-paper ring-1 ring-accent-copper/40 [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:ring-0',
                    )}
                  >
                    <Avatar seed={seed} size={24} className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui-strong text-foreground">
                          {chat.title || 'Untitled chat'}
                        </span>
                        <span className="shrink-0 text-metadata text-muted-foreground">
                          {formatRelative(chat.updated_at)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {project && <RowChip label={project.name} hue={project.color_hue} />}
                        <RowChip
                          icon={<MessageSquare className="h-3 w-3" />}
                          label={`${count} msg${count === 1 ? '' : 's'}`}
                        />
                        {browserBinding ? (
                          <RowChip
                            label={`Browser Chat · ${browserChatProvider(browserBinding.provider).label}`}
                          />
                        ) : null}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    aria-label={`Delete ${chat.title || 'Untitled chat'}`}
                    onClick={() => {
                      if (!accountId || !workspaceId) return;
                      const title = chat.title || 'Untitled chat';
                      setPendingDeletion({
                        chatIds: [chat.id],
                        expectedAccountId: accountId,
                        expectedWorkspaceId: String(workspaceId),
                        title: `Delete ${title}?`,
                        description: `${title} will be permanently deleted from this workspace.`,
                        confirmLabel: 'Delete chat',
                      });
                    }}
                    className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <Dialog
        open={pendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeletion(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          hideClose
          aria-labelledby="history-delete-title"
          aria-describedby="history-delete-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelDeletionRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle id="history-delete-title">{pendingDeletion?.title}</DialogTitle>
            <DialogDescription id="history-delete-description">
              {pendingDeletion?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button ref={cancelDeletionRef} type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting || pendingDeletion === null}
              onClick={() => {
                const request = pendingDeletion;
                if (!request) return;
                setPendingDeletion(null);
                if (request.snapshotId) void removeSnapshot(request);
                else void removeChats(request);
              }}
            >
              {pendingDeletion?.confirmLabel ?? 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

interface FilterChipProps {
  active: boolean;
  label: string;
  onClick: () => void;
  hue?: number;
}

function FilterChip({ active, label, onClick, hue }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-metadata font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active
          ? 'border-accent-copper/40 bg-paper text-foreground'
          : 'border-border bg-elevated text-muted-foreground hover:text-foreground',
      )}
    >
      {hue !== undefined && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: `hsl(${hue} 65% 56%)` }}
        />
      )}
      <span className="truncate max-w-[14ch]">{label}</span>
    </button>
  );
}

interface RowChipProps {
  label: string;
  hue?: number;
  icon?: React.ReactNode;
}

function RowChip({ label, hue, icon }: RowChipProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-1.5 py-0.5 text-metadata text-muted-foreground">
      {hue !== undefined && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: `hsl(${hue} 65% 56%)` }}
        />
      )}
      {icon}
      <span className="truncate max-w-[16ch]">{label}</span>
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10 text-center">
      <p className="text-secondary text-muted-foreground">{message}</p>
    </div>
  );
}

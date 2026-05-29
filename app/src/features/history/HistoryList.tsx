import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search, MessageSquare } from 'lucide-react';
import { db, projectRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { cn, formatRelative } from '@/lib/utils';
import type { Project } from '@/lib/db/schema';
import type { Chat, ChatId, ProjectId, WorkspaceId } from '@/types';

export interface HistoryListProps {
  selectedChatId: ChatId | null;
  onSelectChat: (id: ChatId) => void;
}

type ProjectFilter = 'all' | 'active';

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
export function HistoryList({ selectedChatId, onSelectChat }: HistoryListProps) {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const activeProjectId = useAuthStore((s) => s.projectId) as ProjectId | null;
  const agents = useAgentStore((s) => s.agents);

  const [query, setQuery] = React.useState('');
  const [projectFilter, setProjectFilter] = React.useState<ProjectFilter>('all');

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

  return (
    <aside
      aria-label="Past chats"
      className="flex w-[320px] shrink-0 flex-col border-r border-border bg-panel"
    >
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-display text-page-title text-foreground">History</h2>
        <p className="eyebrow mt-0.5">Past chats · replay</p>
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
        {(chats ?? []).length === 0 ? (
          <EmptyState message="No past chats yet." />
        ) : filtered.length === 0 ? (
          <EmptyState message="No chats match this search." />
        ) : (
          <ul className="flex flex-col py-1">
            {filtered.map((chat) => {
              const firstAgentId = chat.active_agent_ids?.[0];
              const agent = firstAgentId ? agents[firstAgentId] : undefined;
              const seed = agent?.slug ?? (chat.id as unknown as string);
              const project = chat.project_id
                ? projectById[chat.project_id as unknown as string]
                : undefined;
              const count = messageCounts?.[chat.id as unknown as string] ?? 0;
              const selected =
                (selectedChatId as unknown as string) === (chat.id as unknown as string);
              return (
                <li key={chat.id as unknown as string}>
                  <button
                    type="button"
                    onClick={() => onSelectChat(chat.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors',
                      'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      selected && 'bg-paper ring-1 ring-accent-copper/40',
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
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
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

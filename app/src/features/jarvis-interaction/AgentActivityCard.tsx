import * as React from 'react';
import { ChevronDown, ExternalLink, GitFork, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Part } from '@/types/chat';
import type { ChatId } from '@/types/common';
import { useJarvisInteractionStore } from './sessionStore';
import type { JarvisAgentStatus, JarvisChatAgent } from './types';
import { openNativeChildChat } from './openNativeChildChat';
import { AgentActivityIndicator } from './AgentActivityIndicator';
import './AgentActivityCard.css';

type AgentPart = Extract<Part, { kind: 'agent_card' }>;
const EMPTY_AGENTS: NonNullable<
  ReturnType<typeof useJarvisInteractionStore.getState>['agentsByChat'][string]
> = [];

export interface AgentActivityCardProps {
  part: AgentPart;
}

export interface ChatAgentActivityPanelProps {
  chatId: ChatId | string;
  fallbackAgents?: JarvisChatAgent[];
  compact?: boolean;
  className?: string;
}

const STATUS_LABELS: Record<JarvisAgentStatus, string> = {
  queued: 'queued',
  paused: 'paused',
  resuming: 'resuming',
  resumed: 'resumed',
  working: 'working',
  thinking: 'working',
  planning: 'working',
  asking_question: 'asking',
  waiting_permission: 'waiting permission',
  editing: 'working',
  testing: 'working',
  blocked: 'blocked',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const INACTIVE_STATUSES: JarvisAgentStatus[] = [
  'paused',
  'resuming',
  'resumed',
  'blocked',
  'done',
  'failed',
  'cancelled',
];
const HEADER_STATUS = 'Live agent work for this chat';

export function AgentActivityCard({ part }: AgentActivityCardProps) {
  const persistedAgent = part.agent;
  const liveAgent = useJarvisInteractionStore((state) =>
    (state.agentsByChat[String(persistedAgent.parentChatId)] ?? []).find(
      (candidate) => String(candidate.agentId) === String(persistedAgent.agentId),
    ),
  );
  const agent = liveAgent ?? persistedAgent;
  const openChildChat = () => {
    openNativeChildChat(agent.childChatId, agent.parentChatId);
  };
  return (
    <article
      data-testid="chat-agent-card"
      className="agent-task-card group rounded-xl border border-border bg-muted/40 px-3 py-2 text-foreground "
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-foreground">
              {agent.name.toLowerCase().includes('planner') ? 'Planner' : 'Subagent'}
            </span>
            <span className="truncate text-ui-strong text-foreground">{agent.name}</span>
            <span className="shrink-0 text-metadata text-muted-foreground">
              {STATUS_LABELS[agent.status]}
            </span>
          </div>
          <p className="mt-1 truncate text-secondary text-foreground" title={agent.task}>
            {cleanTask(agent.task, agent.name)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{agent.currentStep ?? STATUS_LABELS[agent.status]}</span>
            <span aria-hidden>|</span>
            <span className="truncate">{agent.modelLabel}</span>
          </div>
          <FileEvidenceDisclosure
            filesRead={agent.filesRead ?? []}
            filesEditing={agent.filesEditing ?? agent.lockedFiles}
            diff={agent.diffSummary}
            small
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={openChildChat}
          data-chat-pane-action="true"
          aria-label={`Open chat for ${agent.name}`}
          className="h-7 shrink-0 border border-border bg-muted/30 px-2 text-[11px] text-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open task
        </Button>
      </div>
    </article>
  );
}

function dismissKey(chatId: ChatId | string): string {
  return `jarvis-agent-panel-dismissed:${String(chatId)}`;
}

function readDismissedAt(chatId: ChatId | string): string | null {
  try {
    return window.sessionStorage.getItem(dismissKey(chatId));
  } catch {
    return null;
  }
}

function writeDismissedAt(chatId: ChatId | string, iso: string) {
  try {
    window.sessionStorage.setItem(dismissKey(chatId), iso);
  } catch {
    // Best-effort only; the panel just reappears on remount.
  }
}

export function ChatAgentActivityPanel({
  chatId,
  fallbackAgents = [],
  compact = false,
  className,
}: ChatAgentActivityPanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const [dismissedAt, setDismissedAt] = React.useState<string | null>(() =>
    readDismissedAt(chatId),
  );
  React.useEffect(() => {
    setDismissedAt(readDismissedAt(chatId));
  }, [chatId]);
  const storedAgents = useJarvisInteractionStore(
    (state) => state.agentsByChat[String(chatId)] ?? EMPTY_AGENTS,
  );
  const agents = React.useMemo(() => {
    return dedupeAgents([...fallbackAgents, ...storedAgents]);
  }, [fallbackAgents, storedAgents]);

  const workingAgents = agents.filter(isAgentWorking);
  const panelAgents = workingAgents;

  // A dismissal hides the panel until newer agent work starts, and survives
  // route switches within the session instead of resetting on every remount.
  const dismissed =
    dismissedAt !== null && !panelAgents.some((agent) => agent.createdAt > dismissedAt);

  if (dismissed) return null;
  if (panelAgents.length === 0) return null;

  const agentRows = panelAgents.filter((agent) => labelForAgent(agent) === 'Agent');
  const subagentRows = panelAgents.filter((agent) => labelForAgent(agent) === 'Subagent');
  const showGroupHeaders = agentRows.length > 0 && subagentRows.length > 0;

  const workingCount = workingAgents.length;
  const title = `${workingCount} Working`;
  return (
    <section
      className={cn(
        'agent-task-panel relative w-full overflow-visible rounded-[18px] border border-border bg-background text-foreground',
        className,
      )}
      aria-label="Multitask activity"
      data-chat-agent-panel="connected"
      data-compact={compact ? 'true' : 'false'}
    >
      <div className="overflow-hidden rounded-[17px]">
        <div
          className={cn(
            'flex items-center border-b border-border bg-muted/20',
            compact ? 'gap-1.5 px-2 py-1.5' : 'gap-2.5 px-3 py-2',
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <GitFork
              className={cn('shrink-0 text-foreground ', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')}
            />
            <span className="shrink-0 text-ui-strong font-semibold text-foreground">{title}</span>
            <span className="truncate text-metadata text-muted-foreground">{HEADER_STATUS}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? 'Collapse multitask activity' : 'Expand multitask activity'}
            aria-expanded={expanded}
            className={cn(
              'border border-border bg-muted/30 text-foreground hover:bg-muted/40 hover:text-foreground',
              compact && 'h-6 gap-1 px-1.5 text-[10px]',
            )}
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                expanded ? 'rotate-0' : '-rotate-90',
              )}
            />
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => {
              const iso = new Date().toISOString();
              writeDismissedAt(chatId, iso);
              setDismissedAt(iso);
            }}
            aria-label="Dismiss multitask activity"
            className={cn(
              'rounded-full border border-border bg-muted/40 text-foreground hover:bg-muted/40',
              compact ? 'h-6 w-6' : 'h-7 w-7',
            )}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {expanded ? (
          <div
            className={cn(
              compact &&
                'max-h-[min(46vh,22rem)] overflow-y-auto overscroll-contain text-[12px] [scrollbar-gutter:stable]',
            )}
            data-testid="chat-agent-activity-scroll"
            tabIndex={compact ? 0 : undefined}
            aria-label={compact ? 'Live agent work' : undefined}
          >
            {showGroupHeaders && agentRows.length > 0 && (
              <div className="border-b border-border bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-foreground">
                Agents ({agentRows.length})
              </div>
            )}
            <div className="divide-y divide-border">
              {agentRows.map((agent, index) => (
                <AgentActivityRow
                  key={String(agent.agentId)}
                  agent={agent}
                  index={index + 1}
                  compact={compact}
                />
              ))}
            </div>
            {showGroupHeaders && subagentRows.length > 0 && (
              <div className="border-y border-border bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-foreground">
                Subagents ({subagentRows.length})
              </div>
            )}
            <div className="divide-y divide-border">
              {subagentRows.map((agent, index) => (
                <AgentActivityRow
                  key={String(agent.agentId)}
                  agent={agent}
                  index={agentRows.length + index + 1}
                  compact={compact}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div
        data-testid="chat-agent-connector"
        className="pointer-events-none absolute left-1/2 top-full h-8 w-24 -translate-x-1/2"
        aria-hidden
      >
        <div className="mx-auto h-5 w-px" />
        <div className="mx-auto -mt-1 h-4 w-4 rotate-45 rounded-[4px] border-b border-r border-border bg-background " />
      </div>
    </section>
  );
}

function AgentActivityRow({
  agent,
  index,
  compact = false,
}: {
  agent: JarvisChatAgent;
  index: number;
  compact?: boolean;
}) {
  const filesRead = agent.filesRead ?? [];
  const filesEditing = agent.filesEditing ?? agent.lockedFiles;
  const openChildChat = () => {
    openNativeChildChat(agent.childChatId, agent.parentChatId);
  };
  const diff = agent.diffSummary;

  return (
    <article
      className={cn('bg-muted/20', compact ? 'px-2 py-1.5' : 'px-3 py-2')}
      data-testid="chat-agent-activity-row"
      data-compact={compact ? 'true' : 'false'}
    >
      <div
        className={cn(
          'grid min-w-0 items-center',
          compact
            ? 'grid-cols-[26px_minmax(0,1fr)_auto] gap-1.5'
            : 'grid-cols-[34px_minmax(0,1fr)_auto] gap-2',
        )}
      >
        <div
          className={cn(
            'flex items-center justify-center text-foreground',
            compact ? 'h-6 w-6 text-[11px]' : 'h-8 w-8 text-sm',
          )}
        >
          <span className="sr-only">{index}</span>
          <AgentActivityIndicator agent={agent} />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-foreground">
              {labelForAgent(agent)}
            </span>
            <span
              className="truncate text-ui-strong text-foreground"
              title={cleanTask(agent.task, agent.name)}
            >
              {agent.name}
            </span>
            <span className="shrink-0 text-metadata text-muted-foreground">
              {STATUS_LABELS[agent.status]}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-secondary text-foreground">
            {cleanTask(agent.task, agent.name)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="truncate">{agent.currentStep ?? STATUS_LABELS[agent.status]}</span>
            <span aria-hidden>|</span>
            <span className="truncate">{agent.modelLabel}</span>
          </div>
          <FileEvidenceDisclosure filesRead={filesRead} filesEditing={filesEditing} diff={diff} />
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={openChildChat}
          data-chat-pane-action="true"
          aria-label={`Open chat for ${agent.name}`}
          className={cn(
            'shrink-0 gap-1 border border-border bg-muted/30 text-foreground hover:bg-muted/40 hover:text-foreground',
            compact ? 'h-6 w-6 px-0' : 'px-2 text-[11px]',
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className={compact ? 'sr-only' : undefined}>Open task</span>
        </Button>
      </div>
    </article>
  );
}

function FileEvidenceDisclosure({
  filesRead,
  filesEditing,
  diff,
  small = false,
}: {
  filesRead: string[];
  filesEditing: string[];
  diff?: JarvisChatAgent['diffSummary'];
  small?: boolean;
}) {
  const hasDiff = Boolean(diff && (diff.addedLines !== 0 || diff.removedLines !== 0));
  if (filesRead.length === 0 && filesEditing.length === 0 && !hasDiff) return null;
  return (
    <details className="mt-1.5 rounded-lg border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
      <summary className="cursor-pointer select-none text-foreground">Files and changes</summary>
      <div className="mt-1.5 space-y-1 border-t border-border pt-1.5">
        {filesRead.length > 0 ? <FileEvidenceList label="Read" files={filesRead} /> : null}
        {filesEditing.length > 0 ? <FileEvidenceList label="Changed" files={filesEditing} /> : null}
        {hasDiff && diff ? <DiffCounts diff={diff} small={small} /> : null}
      </div>
    </details>
  );
}

function FileEvidenceList({ label, files }: { label: string; files: string[] }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-1.5">
      <span className="text-foreground">{label}</span>
      <ul className="min-w-0 space-y-0.5">
        {files.map((file) => (
          <li key={`${label}:${file}`} className="truncate font-mono" title={file}>
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiffCounts({
  diff,
  small = false,
}: {
  diff: NonNullable<JarvisChatAgent['diffSummary']>;
  small?: boolean;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-end gap-3 font-mono',
        small ? 'text-[10px]' : 'text-[12px]',
      )}
      aria-label="Line changes"
    >
      <span className="text-emerald-400">+{diff.addedLines}</span>
      <span className="text-red-400">-{diff.removedLines}</span>
    </span>
  );
}

function cleanTask(task: string, fallback: string): string {
  const cleaned = task.replace(/^\/(?:multitask|subagents)\s+/i, '').trim();
  return cleaned || fallback;
}

function labelForAgent(agent: JarvisChatAgent): 'Agent' | 'Subagent' {
  return /^\/subagents\b/i.test(agent.task) ? 'Subagent' : 'Agent';
}

function isAgentWorking(agent: JarvisChatAgent): boolean {
  return !INACTIVE_STATUSES.includes(agent.status);
}

function dedupeAgents(agents: JarvisChatAgent[]): JarvisChatAgent[] {
  const byId = new Map<string, JarvisChatAgent>();
  for (const agent of agents) {
    const id = String(agent.agentId);
    const existing = byId.get(id);
    byId.set(id, existing ? newerAgent(existing, agent) : agent);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function newerAgent(a: JarvisChatAgent, b: JarvisChatAgent): JarvisChatAgent {
  const aTime = Date.parse(a.updatedAt || a.createdAt);
  const bTime = Date.parse(b.updatedAt || b.createdAt);
  return bTime >= aTime ? { ...a, ...b } : { ...b, ...a };
}

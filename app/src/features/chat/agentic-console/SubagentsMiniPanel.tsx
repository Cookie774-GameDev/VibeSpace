import * as React from 'react';
import { Bot, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';
import { openNativeChildChat } from '@/features/jarvis-interaction/openNativeChildChat';
import type { NativeTaskRun } from './nativeTaskRuns';

const EMPTY_AGENTS: JarvisChatAgent[] = [];
const EMPTY_NATIVE_RUNS: readonly NativeTaskRun[] = [];

function formatElapsed(createdAt: string, updatedAt: string, now = Date.now()): string {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  const base = Number.isFinite(start) ? start : now;
  const tip = Number.isFinite(end) ? Math.max(end, base) : now;
  const ms = Math.max(0, tip - base);
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

export function SubagentsMiniPanel({
  chatId,
  open,
  onClose,
  nativeRuns = EMPTY_NATIVE_RUNS,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
  nativeRuns?: readonly NativeTaskRun[];
}) {
  const agents = useJarvisInteractionStore(
    (state) => state.agentsByChat[String(chatId)] ?? EMPTY_AGENTS,
  );
  const native = nativeRuns.filter(run => !run.sessionId || !agents.some(agent => agent.harnessSessionId === run.sessionId));
  if (!open) return null;

  return (
    <div
      className="agentic-subagents-panel"
      role="dialog"
      aria-label="Runs for this chat"
      data-testid="agentic-subagents-panel"
    >
      <div className="agentic-subagents-panel__header">
        <strong>Runs</strong>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close runs"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {agents.length + native.length === 0 ? (
        <p className="agentic-subagents-panel__empty">No subagents running for this chat.</p>
      ) : (
        <ul className="agentic-subagents-panel__list">
          {agents.map((agent) => (
            <SubagentRow key={String(agent.agentId)} agent={agent} />
          ))}
          {native.map(run => <li key={run.id} className="agentic-subagents-panel__row">
            <div className="agentic-subagents-panel__icon" aria-hidden><Bot className="h-3.5 w-3.5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="agentic-subagents-panel__badge">Run</span>
                <span className="break-words text-[12px] font-medium text-foreground">{run.name}</span>
                <span className="text-[10px] uppercase text-muted-foreground">{run.status === 'error' ? 'failed' : run.status}</span>
              </div>
              {run.currentStep && <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{run.currentStep}</p>}
              {run.modelLabel && <p className="mt-0.5 break-all text-[10px] text-muted-foreground">{run.modelLabel}</p>}
            </div>
          </li>)}
        </ul>
      )}
    </div>
  );
}

function SubagentRow({ agent }: { agent: JarvisChatAgent }) {
  const label = agent.name.toLowerCase().includes('planner')
    ? 'Planner'
    : agent.name.toLowerCase().includes('subagent')
      ? 'Subagent'
      : 'Agent';
  return (
    <li className="agentic-subagents-panel__row">
      <div className="agentic-subagents-panel__icon" aria-hidden>
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="agentic-subagents-panel__badge">{label}</span>
          <span className="truncate text-[12px] font-medium text-foreground">{agent.name}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {agent.status}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={agent.task}>
          {agent.task}
        </p>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="truncate" title={agent.modelLabel}>
            {agent.modelLabel}
          </span>
          <span>{formatElapsed(agent.createdAt, agent.updatedAt)}</span>
          {agent.currentStep ? <span className="truncate">{agent.currentStep}</span> : null}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label={`Open chat for ${agent.name}`}
        title="Open native VibeSpace chat"
        data-chat-pane-action="true"
        onClick={() => openNativeChildChat(String(agent.childChatId))}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

export function SubagentsHeaderButton({
  chatId,
  className,
  nativeRuns = EMPTY_NATIVE_RUNS,
}: {
  chatId: string;
  className?: string;
  nativeRuns?: readonly NativeTaskRun[];
}) {
  const [open, setOpen] = React.useState(false);
  const agents = useJarvisInteractionStore(
    (state) => state.agentsByChat[String(chatId)] ?? EMPTY_AGENTS,
  );
  const count = agents.length + nativeRuns.filter(run => !run.sessionId || !agents.some(agent => agent.harnessSessionId === run.sessionId)).length;
  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        className="agentic-session__subagents-btn"
        aria-label={count === 1 ? '1 Run' : `${count} Runs`}
        aria-expanded={open}
        data-testid="agentic-subagents-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <Bot aria-hidden="true" />
        {count} {count === 1 ? 'Run' : 'Runs'}
      </button>
      <SubagentsMiniPanel chatId={chatId} open={open} nativeRuns={nativeRuns} onClose={() => setOpen(false)} />
    </div>
  );
}

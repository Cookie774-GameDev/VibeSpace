import * as React from 'react';
import { Bot, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';
import { openNativeChildChat } from '@/features/jarvis-interaction/openNativeChildChat';
import type { NativeTaskRun } from './nativeTaskRuns';
import { usePagedChatMessages } from '../hooks';
import { MessageBubble } from '../MessageBubble';
import {
  requestBoundChildReply,
  requestNativeSubagentReply,
} from '@/features/jarvis-interaction/nativeSubagentReply';

const EMPTY_AGENTS: JarvisChatAgent[] = [];
const EMPTY_NATIVE_RUNS: readonly NativeTaskRun[] = [];

export function subagentStatusLabel(status: string): string {
  switch (status.toLowerCase()) {
    case 'paused':
      return 'Paused';
    case 'resuming':
      return 'Resuming';
    case 'resumed':
      return 'Resumed';
    case 'working':
    case 'running':
    case 'thinking':
    case 'planning':
    case 'editing':
    case 'testing':
      return 'Working';
    case 'done':
    case 'completed':
      return 'Completed';
    case 'failed':
    case 'error':
      return 'Failed';
    case 'cancelled':
    case 'canceled':
      return 'Cancelled';
    case 'queued':
    case 'pending':
      return 'Queued';
    case 'asking_question':
      return 'Waiting for answer';
    case 'waiting_permission':
      return 'Waiting for approval';
    case 'blocked':
      return 'Blocked';
    case 'unknown':
      return 'Status unavailable';
    default:
      return status ? `${status[0]!.toUpperCase()}${status.slice(1)}` : 'Status unavailable';
  }
}

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
  const native = nativeRuns.filter(
    (run) => !run.sessionId || !agents.some((agent) => agent.harnessSessionId === run.sessionId),
  );
  if (!open) return null;

  return (
    <div
      className="agentic-subagents-panel"
      role="dialog"
      aria-label="Subagents for this chat"
      data-testid="agentic-subagents-panel"
    >
      <div className="agentic-subagents-panel__header">
        <strong>Subagents</strong>
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
            <SubagentRow key={String(agent.agentId)} agent={agent} parentChatId={chatId} />
          ))}
          {native.map((run) => (
            <li key={run.id} className="agentic-subagents-panel__row">
              <div className="agentic-subagents-panel__icon" aria-hidden>
                <Bot className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="agentic-subagents-panel__badge">Run</span>
                  <span className="break-words text-[12px] font-medium text-foreground">
                    {run.name}
                  </span>
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {subagentStatusLabel(String(run.status))}
                  </span>
                </div>
                {run.currentStep && (
                  <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                    {run.currentStep}
                  </p>
                )}
                <p className="mt-1 break-all text-[11px] text-muted-foreground">
                  {run.modelLabel ?? 'Model not reported'}
                  {run.reasoningEffort ? ` · ${run.reasoningEffort}` : ''}
                </p>
                {run.result && (
                  <pre
                    className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 text-xs"
                    aria-label={`${run.name} result`}
                  >
                    {run.result}
                  </pre>
                )}
                {run.error && (
                  <p className="mt-2 break-words text-xs text-destructive">{run.error}</p>
                )}
                {run.sessionId && run.harness ? (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Details and reply
                    </summary>
                    <p className="mt-2 break-all text-[10px] text-muted-foreground">
                      {run.harness === 'codex' ? 'Codex' : 'OpenCode'} · {run.sessionId}
                    </p>
                    <SubagentReplyBox
                      name={run.name}
                      requestReply={(text) =>
                        requestNativeSubagentReply({ parentChatId: chatId, run, text })
                      }
                    />
                  </details>
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Native reply unavailable: session route not reported.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentRow({ agent, parentChatId }: { agent: JarvisChatAgent; parentChatId: string }) {
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
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="agentic-subagents-panel__badge">{label}</span>
          <span className="break-words text-[12px] font-medium text-foreground">{agent.name}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {subagentStatusLabel(String(agent.status))}
          </span>
        </div>
        <p className="mt-1 break-words text-[12px] text-muted-foreground" title={agent.task}>
          {agent.task}
        </p>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="break-all" title={agent.modelLabel}>
            {agent.modelLabel}
          </span>
          <span>{formatElapsed(agent.createdAt, agent.updatedAt)}</span>
          {agent.currentStep ? <span className="break-words">{agent.currentStep}</span> : null}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label={`Open child side panel for ${agent.name}`}
        title="Open child in this chat"
        data-chat-pane-action="true"
        data-testid={`open-subagent-child-${String(agent.agentId)}`}
        onClick={() => openNativeChildChat(String(agent.childChatId), parentChatId)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function SubagentReplyBox({
  name,
  requestReply,
}: {
  name: string;
  requestReply: (text: string) => Promise<void>;
}) {
  const [text, setText] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const submitting = React.useRef(false);
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current || !text.trim()) return;
        submitting.current = true;
        setPending(true);
        setNotice('');
        try {
          await requestReply(text);
          setText('');
          setNotice('Reply requested through the native agent.');
        } catch (error) {
          setNotice(error instanceof Error ? error.message : 'Could not request this reply.');
        } finally {
          submitting.current = false;
          setPending(false);
        }
      }}
    >
      <textarea
        aria-label={`Reply to ${name}`}
        placeholder="Send follow-up work"
        value={text}
        maxLength={32_768}
        disabled={pending}
        onChange={(event) => setText(event.target.value)}
        className="min-h-16 w-full resize-y rounded-md border border-border bg-background p-2 text-xs text-foreground"
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending || !text.trim()}>
        {pending ? 'Requesting…' : 'Request reply'}
      </Button>
      {notice && (
        <p role="status" className="break-words text-[11px] text-muted-foreground">
          {notice}
        </p>
      )}
    </form>
  );
}

export function SubagentChatSidePanel({
  agent,
  onClose,
}: {
  agent: JarvisChatAgent;
  onClose: () => void;
}) {
  const { messages, hasOlder, loadOlder } = usePagedChatMessages(String(agent.childChatId));

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={`Child chat for ${agent.name}`}
      data-testid="subagent-child-side-panel"
      className="agentic-subagent-child-panel absolute inset-y-2 right-2 z-30 flex w-[min(34rem,95%)] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-xl"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            Sub-agent child chat
          </div>
          <strong className="block break-words text-sm" title={agent.name}>
            {agent.name}
          </strong>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wide">
          {subagentStatusLabel(String(agent.status))}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close child chat"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      <div className="shrink-0 space-y-1 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        <p className="break-words text-foreground" title={agent.task}>
          {agent.task}
        </p>
        <p className="break-all">{agent.modelLabel || 'Model not reported'}</p>
        {agent.currentStep && <p className="break-words">{agent.currentStep}</p>}
        {agent.summary && (
          <p className="whitespace-pre-wrap break-words text-foreground">{agent.summary}</p>
        )}
        {agent.error ? <p className="break-words text-destructive">{agent.error}</p> : null}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-3"
        role="log"
        aria-label={`${agent.name} messages`}
      >
        {hasOlder ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mb-3 w-full"
            onClick={loadOlder}
          >
            Load earlier messages
          </Button>
        ) : null}
        {messages.length > 0 ? (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble
                key={String(message.id)}
                message={message}
                compact
                showActivityLedger={false}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No child messages have been recorded yet.
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-3 pb-3">
        {agent.harnessSessionId ? (
          <SubagentReplyBox
            key={String(agent.childChatId)}
            name={agent.name}
            requestReply={(text) => requestBoundChildReply({ agent, text })}
          />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Native reply unavailable: child session not bound.
          </p>
        )}
      </div>
    </aside>
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
  const count =
    agents.length +
    nativeRuns.filter(
      (run) => !run.sessionId || !agents.some((agent) => agent.harnessSessionId === run.sessionId),
    ).length;
  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        className="agentic-session__subagents-btn"
        aria-label={count === 1 ? '1 Subagent' : `${count} Subagents`}
        aria-expanded={open}
        data-testid="agentic-subagents-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <Bot aria-hidden="true" />
        {count} {count === 1 ? 'Subagent' : 'Subagents'}
      </button>
      <SubagentsMiniPanel
        chatId={chatId}
        open={open}
        nativeRuns={nativeRuns}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

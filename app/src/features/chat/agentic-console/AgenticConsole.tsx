import * as React from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  FileCode2,
  Gauge,
  GitCompareArrows,
  MoreHorizontal,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import type { JarvisCreatorKind } from '@/features/jarvis-creator/contracts';
import { MessageBubble } from '../MessageBubble';
import type { ChatActivityEvent, ChatActivityStatus } from '../activity/types';
import {
  MAX_MOUNTED_BLOCKS,
  TRANSCRIPT_PAGE_SIZE,
  formatUnifiedDiffLines,
  projectAgenticTranscript,
  summarizeAgenticSession,
  windowTranscriptBlocks,
  type AgenticSessionEvidence,
  type AgenticSessionSummary,
  type TranscriptBlock,
} from './projection';
import {
  CONSOLE_PREFERENCE_EVENT,
  CONSOLE_PROFILES,
  loadConsolePreferences,
  saveConsolePreferences,
  type ConsolePreferences,
  type ConsoleProfile,
} from './preferences';
import { AgentMotionIndicator, resolveAgentMotion } from './AgentMotionIndicator';
import { SubagentsHeaderButton } from './SubagentsMiniPanel';
import { buildChatSessionExport, downloadChatSessionExport } from './sessionExport';
import './agentic-console.css';

export interface AgenticConsoleProps {
  chatId: string;
  messages: readonly Message[];
  activity: readonly ChatActivityEvent[];
  compact?: boolean;
  creatorDraftKind?: JarvisCreatorKind;
  sessionEvidence?: AgenticSessionEvidence;
  actions?: {
    cancel?: () => void | Promise<void>;
    retry?: () => void | Promise<void>;
    continue?: () => void | Promise<void>;
  };
}

type BoundaryProps = {
  children: React.ReactNode;
  fallback: React.ReactNode;
};

type BoundaryState = { failed: boolean };

export class AgenticConsoleErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    console.error('[AgenticConsole] Projection failed; restored classic transcript.');
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function useConsolePreferences(): [
  ConsolePreferences,
  (patch: Partial<ConsolePreferences>) => void,
] {
  const [preferences, setPreferences] = React.useState(loadConsolePreferences);
  React.useEffect(() => {
    const refresh = () => setPreferences(loadConsolePreferences());
    window.addEventListener(CONSOLE_PREFERENCE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CONSOLE_PREFERENCE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const update = React.useCallback(
    (patch: Partial<ConsolePreferences>) => {
      const next = { ...preferences, ...patch, version: 1 as const };
      saveConsolePreferences(next);
      setPreferences(next);
    },
    [preferences],
  );
  return [preferences, update];
}

function formatMetric(value: number | '—', suffix = ''): string {
  return value === '—' ? '—' : `${value.toLocaleString()}${suffix}`;
}

function formatDuration(durationMs: number | '—'): string {
  if (durationMs === '—') return '—';
  if (durationMs < 1000) return `${durationMs} ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function statusLabel(status: AgenticSessionSummary['status']): string {
  if (status === 'queued') return 'Queued';
  if (status === 'planning') return 'Planning';
  if (status === 'running') return 'Running';
  if (status === 'blocked') return 'Blocked';
  if (status === 'partial') return 'Partial';
  if (status === 'error') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'recovering') return 'Recovering';
  if (status === 'done') return 'Complete';
  return 'Idle';
}

function SessionHeader({
  chatId,
  summary,
  preferences,
  onPreferences,
  actions,
  onExpandAll,
  onCollapseAll,
  onCopySummary,
  onExport,
}: {
  chatId: string;
  summary: AgenticSessionSummary;
  preferences: ConsolePreferences;
  onPreferences: (patch: Partial<ConsolePreferences>) => void;
  actions?: AgenticConsoleProps['actions'];
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onCopySummary: () => void;
  onExport: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const invoke = (action: (() => void | Promise<void>) | undefined) => {
    if (!action) return;
    const report = (error: unknown) => {
      toast.error('Run action failed', error instanceof Error ? error.message : 'Please retry.');
    };
    try {
      void Promise.resolve(action()).catch(report);
    } catch (error) {
      report(error);
    }
  };
  return (
    <header
      className="agentic-session"
      aria-label="Agentic session summary"
      data-testid="jarvis-session-panel"
    >
      <div className="agentic-session__identity">
        <span className={cn('agentic-status-dot', `is-${summary.status}`)} aria-hidden="true" />
        <div className="agentic-session__title">
          <strong aria-label="Session status">{statusLabel(summary.status)}</strong>
          <span title={summary.currentOperation}>{summary.currentOperation}</span>
        </div>
      </div>
      <div className="agentic-session__metrics-row">
        <button
          type="button"
          className="agentic-session__metrics"
          aria-label="Open session details"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span>
            <FileCode2 aria-hidden="true" />
            {summary.fileCount} {summary.fileCount === 1 ? 'file' : 'files'}
          </span>
          <span className="is-add">+{summary.addedLines}</span>
          <span className="is-remove">-{summary.removedLines}</span>
          <span>{formatMetric(summary.tokenCount, ' tokens')}</span>
          <span title="Elapsed time">
            <Clock3 aria-hidden="true" />
            {formatDuration(summary.durationMs)}
          </span>
          <span className="agentic-session__model" title={summary.model}>
            {summary.model}
          </span>
        </button>
        <SubagentsHeaderButton chatId={chatId} />
      </div>
      <div className="agentic-session__actions">
        {actions?.continue ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Continue run"
            onClick={() => invoke(actions.continue)}
          >
            Continue
          </Button>
        ) : null}
        {actions?.retry ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Retry run"
            onClick={() => invoke(actions.retry)}
          >
            <RotateCcw />
          </Button>
        ) : null}
        {actions?.cancel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel run"
            onClick={() => invoke(actions.cancel)}
          >
            <Circle />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Chat console settings"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Settings2 />
        </Button>
        {open ? (
          <div className="agentic-settings" role="dialog" aria-label="Chat console settings">
            <dl className="agentic-settings__evidence">
              <div>
                <dt>Model</dt>
                <dd>{summary.model}</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{summary.context}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>
                  {summary.startedAt === '—'
                    ? '—'
                    : new Date(summary.startedAt).toLocaleTimeString()}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(summary.durationMs)}</dd>
              </div>
            </dl>
            <label>
              <span>Console theme</span>
              <select
                aria-label="Console theme"
                value={preferences.profile}
                onChange={(event) =>
                  onPreferences({ profile: event.currentTarget.value as ConsoleProfile })
                }
              >
                {CONSOLE_PROFILES.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="agentic-settings__row">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Use classic chat view"
                onClick={() => onPreferences({ view: 'classic' })}
              >
                Classic view
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onPreferences({
                    density: preferences.density === 'compact' ? 'comfortable' : 'compact',
                  })
                }
              >
                {preferences.density === 'compact' ? 'Comfortable' : 'Compact'} density
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="agentic-settings__wide"
              onClick={() =>
                onPreferences({
                  caret: preferences.caret === 'block' ? 'standard' : 'block',
                })
              }
            >
              {preferences.caret === 'block' ? 'Use standard caret' : 'Use block caret'}
            </Button>
            <div className="agentic-settings__controls">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Expand all transcript details"
                onClick={onExpandAll}
              >
                Expand all
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Collapse all transcript details"
                onClick={onCollapseAll}
              >
                Collapse all
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Copy session summary"
                onClick={onCopySummary}
              >
                Copy summary
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Export session"
                onClick={onExport}
              >
                Export session
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function statusIcon(status: ChatActivityStatus) {
  if (status === 'done') return <Check aria-hidden="true" />;
  if (status === 'error') return <AlertCircle aria-hidden="true" />;
  if (status === 'running') return <Play aria-hidden="true" />;
  if (status === 'cancelled') return <RotateCcw aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function activityIcon(kind: string) {
  if (kind === 'file') return <FileCode2 aria-hidden="true" />;
  if (kind === 'url') return <Search aria-hidden="true" />;
  if (kind === 'agent' || kind === 'subagent') return <Bot aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

function PromptBand({ block }: { block: Extract<TranscriptBlock, { kind: 'prompt' }> }) {
  const [expanded, setExpanded] = React.useState(false);
  const long = block.text.length > 520 || block.text.split('\n').length > 8;
  return (
    <article className="agentic-prompt-band" data-message-id={block.message.id}>
      <div className="agentic-prompt-band__meta">
        <strong>You</strong>
        <time dateTime={new Date(block.message.created_at).toISOString()}>
          {new Date(block.message.created_at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <p className={cn('agentic-prompt-band__text', long && !expanded && 'is-clamped')}>
        {block.text}
      </p>
      {long ? (
        <button
          type="button"
          className="agentic-inline-action"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show preview' : 'Show full prompt'}
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
      ) : null}
    </article>
  );
}

function copyText(text: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success('Copied'))
    .catch(() => toast.error('Copy failed'));
}

function DiffView({ block }: { block: Extract<TranscriptBlock, { kind: 'diff' }> }) {
  const lines = React.useMemo(() => formatUnifiedDiffLines(block.diff), [block.diff]);
  const motion = resolveAgentMotion({
    status: block.status,
    activityKind: 'diff',
    title: block.title,
    filePath: block.filePath,
  });
  return (
    <article className="agentic-diff" aria-label={`Diff ${block.filePath ?? block.title}`}>
      <div className="agentic-block-head">
        <span>
          {motion ? <AgentMotionIndicator motion={motion} /> : null}
          <GitCompareArrows aria-hidden="true" />
          <strong>{block.filePath ?? block.title}</strong>
        </span>
        <span className="agentic-block-head__metrics">
          {block.addedLines != null ? <b className="is-add">+{block.addedLines}</b> : null}
          {block.removedLines != null ? <b className="is-remove">-{block.removedLines}</b> : null}
          <button type="button" aria-label="Copy diff" onClick={() => copyText(block.diff)}>
            <Copy aria-hidden="true" />
          </button>
        </span>
      </div>
      <pre>
        {lines.map((line, index) => (
          <code
            key={`${index}:${line.text.slice(0, 20)}`}
            className={cn(
              'agentic-diff-line',
              line.kind === 'add' && 'agentic-diff-line--add',
              line.kind === 'remove' && 'agentic-diff-line--remove',
              line.kind === 'meta' && 'agentic-diff-line--meta',
            )}
          >
            <span className="agentic-diff-line__number" aria-hidden="true">
              {line.oldLine ?? ''}
            </span>
            <span className="agentic-diff-line__number" aria-hidden="true">
              {line.newLine ?? ''}
            </span>
            <span className="agentic-diff-line__text">{line.text || ' '}</span>
          </code>
        ))}
      </pre>
    </article>
  );
}

function CommandView({
  block,
  motionActive,
}: {
  block: Extract<TranscriptBlock, { kind: 'command' }>;
  motionActive: boolean;
}) {
  return (
    <article className="agentic-command" aria-label={`Command ${block.command}`}>
      <div className="agentic-block-head">
        <span>
          {motionActive && !block.output && !block.error ? (
            <AgentMotionIndicator motion="cursor-forge" />
          ) : null}
          <TerminalSquare aria-hidden="true" />
          <strong>{block.tool}</strong>
          {block.cwd ? <small>{block.cwd}</small> : null}
        </span>
        <span className="agentic-block-head__metrics">
          {block.exitCode != null ? (
            <b className={block.exitCode === 0 ? 'is-add' : 'is-remove'}>exit {block.exitCode}</b>
          ) : null}
          {block.durationMs != null ? <small>{formatDuration(block.durationMs)}</small> : null}
          <button type="button" aria-label="Copy command" onClick={() => copyText(block.command)}>
            <Copy aria-hidden="true" />
          </button>
        </span>
      </div>
      <pre>
        <code>
          <span aria-hidden="true">$ </span>
          {block.command}
        </code>
      </pre>
      {block.output || block.error ? (
        <pre className={cn('agentic-command__output', block.error && 'is-error')}>
          <code>{block.error ?? block.output}</code>
        </pre>
      ) : null}
    </article>
  );
}

function ToolView({ block }: { block: Extract<TranscriptBlock, { kind: 'tool' }> }) {
  return (
    <details className="agentic-tool">
      <summary>
        <Wrench aria-hidden="true" />
        <strong>{block.tool}</strong>
        <span>{block.error ? 'Failed' : block.output ? 'Complete' : 'Requested'}</span>
      </summary>
      <div>
        <small>Arguments</small>
        <pre>{block.args}</pre>
        {block.output || block.error ? (
          <>
            <small>{block.error ? 'Error' : 'Result'}</small>
            <pre className={block.error ? 'is-error' : undefined}>
              {block.error ?? block.output}
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

function BlockView({
  block,
  finalAnswerId,
  compact,
  creatorDraftKind,
  motionActive,
}: {
  block: TranscriptBlock;
  finalAnswerId?: string;
  compact?: boolean;
  creatorDraftKind?: JarvisCreatorKind;
  motionActive: boolean;
}) {
  if (block.kind === 'prompt') return <PromptBand block={block} />;
  if (block.kind === 'answer') {
    return (
      <article
        className={cn('agentic-answer', block.id === finalAnswerId && 'is-final')}
        data-message-id={block.message.id}
      >
        <div className="agentic-answer__meta">
          <Sparkles aria-hidden="true" />
          <strong>{block.id === finalAnswerId ? 'Final response' : 'Assistant'}</strong>
          {block.message.usage?.model ? <span>{block.message.usage.model}</span> : null}
        </div>
        <div className="agentic-answer__text">{block.text}</div>
      </article>
    );
  }
  if (block.kind === 'reasoning') {
    return (
      <details className="agentic-reasoning">
        <summary>
          {motionActive ? <AgentMotionIndicator motion="cursor-forge" /> : null}
          <Gauge aria-hidden="true" />
          Reasoning
        </summary>
        <p>{block.text}</p>
      </details>
    );
  }
  if (block.kind === 'activity') {
    const motion = resolveAgentMotion({
      status: block.status,
      activityKind: block.activityKind,
      title: block.title,
      detail: block.detail,
      filePath: block.filePath,
    });
    return (
      <div className={cn('agentic-activity', `is-${block.status}`)}>
        {motion ? <AgentMotionIndicator motion={motion} /> : null}
        <span className="agentic-activity__kind">{activityIcon(block.activityKind)}</span>
        <span className="agentic-activity__status">{statusIcon(block.status)}</span>
        <strong>{block.title}</strong>
        {block.filePath ? <code>{block.filePath}</code> : null}
        {block.detail ? <span>{block.detail}</span> : null}
      </div>
    );
  }
  if (block.kind === 'diff') return <DiffView block={block} />;
  if (block.kind === 'command') return <CommandView block={block} motionActive={motionActive} />;
  if (block.kind === 'tool') return <ToolView block={block} />;
  return (
    <div className="agentic-legacy" data-agentic-fallback="structured-message">
      <MessageBubble
        message={block.message}
        compact={compact}
        creatorDraftKind={creatorDraftKind}
      />
    </div>
  );
}

export function AgenticConsole({
  chatId,
  messages,
  activity,
  compact = false,
  creatorDraftKind,
  sessionEvidence,
  actions,
}: AgenticConsoleProps) {
  const [preferences, updatePreferences] = useConsolePreferences();
  const [mountedCount, setMountedCount] = React.useState(MAX_MOUNTED_BLOCKS);
  const rootRef = React.useRef<HTMLElement>(null);
  const blocks = React.useMemo(
    () =>
      projectAgenticTranscript(messages, activity, {
        preserveAssistantMessages: creatorDraftKind != null,
      }),
    [messages, activity, creatorDraftKind],
  );
  const summary = React.useMemo(
    () => summarizeAgenticSession(messages, activity, sessionEvidence),
    [messages, activity, sessionEvidence],
  );
  const motionActive =
    summary.status === 'queued' ||
    summary.status === 'planning' ||
    summary.status === 'running' ||
    summary.status === 'recovering';
  const windowed = React.useMemo(
    () => windowTranscriptBlocks(blocks, mountedCount),
    [blocks, mountedCount],
  );
  const finalAnswerId = [...blocks].reverse().find((block) => block.kind === 'answer')?.id;
  const loadCount = Math.min(TRANSCRIPT_PAGE_SIZE, windowed.remaining);

  React.useEffect(() => {
    document.documentElement.dataset.agenticConsoleCaret =
      preferences.view === 'agentic' ? preferences.caret : 'standard';
  }, [preferences.caret, preferences.view]);

  const setDetailsOpen = (open: boolean) => {
    rootRef.current?.querySelectorAll<HTMLDetailsElement>('details').forEach((details) => {
      details.open = open;
    });
  };

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== 't')
        return;
      const target = event.target;
      if (
        (target instanceof Element &&
          target.matches('input, textarea, select, [contenteditable="true"]')) ||
        !rootRef.current?.isConnected
      ) {
        return;
      }
      const details = [...rootRef.current.querySelectorAll<HTMLDetailsElement>('details')];
      if (details.length === 0) return;
      event.preventDefault();
      const nextOpen = details.some((detail) => !detail.open);
      details.forEach((detail) => {
        detail.open = nextOpen;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const summaryText = [
    `Status: ${statusLabel(summary.status)}`,
    `Operation: ${summary.currentOperation}`,
    `Files: ${summary.fileCount}`,
    `Changes: +${summary.addedLines} -${summary.removedLines}`,
    `Tokens: ${formatMetric(summary.tokenCount)}`,
    `Model: ${summary.model}`,
    `Duration: ${formatDuration(summary.durationMs)}`,
  ].join('\n');
  const exportSession = () => {
    const exportBlocks = blocks.map((block) => {
      if ('message' in block) {
        const { message: _message, ...safeBlock } = block;
        if (block.kind === 'legacy') {
          return {
            ...safeBlock,
            note: 'Structured message content remains in canonical chat storage.',
          };
        }
        return safeBlock;
      }
      return block;
    });
    // Per-chat lightweight log: full messages for this chatId + projection blocks.
    downloadChatSessionExport(
      buildChatSessionExport({
        chatId,
        messages,
        summary,
        blocks: exportBlocks,
      }),
    );
  };

  if (preferences.view === 'classic') {
    return (
      <div className="agentic-view-notice" role="status">
        <span>Classic chat view selected.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => updatePreferences({ view: 'agentic' })}
        >
          Use agentic console
        </Button>
      </div>
    );
  }

  // Empty idle chats: do not double empty-state. Once there are messages,
  // activity, or run evidence, always mount the session mini command center.
  const hasTranscriptWork =
    messages.length > 0 || activity.length > 0 || Boolean(sessionEvidence) || blocks.length > 0;
  if (!hasTranscriptWork) return null;

  return (
    <section
      ref={rootRef}
      role="region"
      aria-label="Agentic chat console"
      data-agentic-console
      data-console-theme={preferences.profile}
      data-console-density={preferences.density}
      data-console-caret={preferences.caret}
      data-chat-id={chatId}
      className={cn('agentic-console', compact && 'is-compact')}
    >
      <SessionHeader
        chatId={chatId}
        summary={summary}
        preferences={preferences}
        onPreferences={updatePreferences}
        actions={actions}
        onExpandAll={() => setDetailsOpen(true)}
        onCollapseAll={() => setDetailsOpen(false)}
        onCopySummary={() => copyText(summaryText)}
        onExport={exportSession}
      />
      {blocks.length > 0 ? (
        <div className="agentic-transcript" aria-label="Agentic transcript">
          {windowed.remaining > 0 ? (
            <button
              type="button"
              className="agentic-history"
              aria-label={`Load ${loadCount} older events`}
              onClick={() => setMountedCount((count) => count + TRANSCRIPT_PAGE_SIZE)}
            >
              <MoreHorizontal aria-hidden="true" />
              Load {loadCount} older events
            </button>
          ) : null}
          {windowed.visible.map((block) => (
            <BlockView
              key={block.id}
              block={block}
              finalAnswerId={finalAnswerId}
              compact={compact}
              creatorDraftKind={creatorDraftKind}
              motionActive={motionActive}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

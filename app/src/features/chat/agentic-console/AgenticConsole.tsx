import { StreamingChatPreview } from '../StreamingChatPreview';
import * as React from 'react';
import { ThemedSelect } from '@/components/ui/themed-select';
import { NotesSessionReferences } from '../../notes/NotesSessionReferences';
import { parseChatNoteReference } from '../../notes/notesChatReferences';
import { ThinkingDisclosure } from '../ThinkingDisclosure';
import { ResponseDetails } from '../ResponseDetails';
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
  GitCompareArrows,
  MoreHorizontal,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import type { JarvisCreatorKind } from '@/features/jarvis-creator/contracts';
import { MessageBubble } from '../MessageBubble';
import { MessagePart } from '../MessagePart';
import { AssistantActivityLedger } from '../activity-ledger/AssistantActivityLedger';
import {
  projectAssistantActivityLedger,
  type AssistantActivityLedgerProjection,
} from '../activity-ledger/ledgerProjection';
import type { ChatActivityEvent, ChatActivityStatus } from '../activity/types';
import {
  MAX_MOUNTED_BLOCKS,
  TRANSCRIPT_PAGE_SIZE,
  formatUnifiedDiffLines,
  projectAgenticTranscript,
  projectAgenticTranscriptWindow,
  sanitizeConsoleText,
  summarizeAgenticSession,
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
import { PerceptibleAgentMotionIndicator, resolveAgentMotion } from './AgentMotionIndicator';
import { SubagentsHeaderButton } from './SubagentsMiniPanel';
import { collectNativeTaskRuns, type NativeTaskRun } from './nativeTaskRuns';
import { buildChatSessionExport, downloadChatSessionExport } from './sessionExport';
import { loadChatDebugLog } from './chatDebugLogData';
import { downloadChatDebugLog } from './chatDebugLogHtml';
import { chatRepo, messageRepo } from '@/lib/db';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { useJarvisCommandCenterBinding } from '@/features/jarvis-command-center/JarvisCommandCenter';
import './agentic-console.css';

export interface AgenticConsoleProps {
  chatId: string;
  messages: readonly Message[];
  activity: readonly ChatActivityEvent[];
  compact?: boolean;
  creatorDraftKind?: JarvisCreatorKind;
  sessionEvidence?: AgenticSessionEvidence;
  headerProgress?: React.ReactNode;
  actions?: {
    cancel?: () => void | Promise<void>;
    retry?: () => void | Promise<void>;
    retryLabel?: string;
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

function HeaderProgressSlot({
  children,
  present,
  onPresenceChange,
}: {
  children: React.ReactNode;
  present: boolean;
  onPresenceChange: (present: boolean) => void;
}) {
  const slotRef = React.useRef<HTMLDivElement>(null);
  const updatePresence = React.useCallback(() => {
    onPresenceChange(Boolean(slotRef.current?.hasChildNodes()));
  }, [onPresenceChange]);

  React.useLayoutEffect(updatePresence);
  React.useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const observer = new MutationObserver(updatePresence);
    observer.observe(slot, { childList: true });
    return () => observer.disconnect();
  }, [updatePresence]);

  return (
    <div
      ref={slotRef}
      className={present ? 'agentic-session__progress' : undefined}
      hidden={!present}
    >
      {children}
    </div>
  );
}

function SessionHeader({
  chatId,
  messages,
  summary,
  nativeRuns,
  preferences,
  headerProgress,
  onPreferences,
  actions,
  onExpandAll,
  onCollapseAll,
  onCopySummary,
  onExport,
  onHtmlExport,
  htmlExportBusy,
}: {
  chatId: string;
  messages: readonly Message[];
  summary: AgenticSessionSummary;
  nativeRuns: readonly NativeTaskRun[];
  preferences: ConsolePreferences;
  headerProgress?: React.ReactNode;
  onPreferences: (patch: Partial<ConsolePreferences>) => void;
  actions?: AgenticConsoleProps['actions'];
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onCopySummary: () => void;
  onExport: () => void;
  onHtmlExport: () => void;
  htmlExportBusy: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [hasHeaderProgress, setHasHeaderProgress] = React.useState(false);
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
      role="group"
      data-testid="jarvis-session-panel"
      data-has-progress={hasHeaderProgress ? 'true' : undefined}
    >
      <div className="agentic-session__identity">
        <span className={cn('agentic-status-dot', `is-${summary.status}`)} aria-hidden="true" />
        <div className="agentic-session__title">
          <strong role="status" aria-label="Session status">{statusLabel(summary.status)}</strong>
          <span title={summary.currentOperation}>{summary.currentOperation}</span>
        </div>
      </div>
      <HeaderProgressSlot present={hasHeaderProgress} onPresenceChange={setHasHeaderProgress}>
        {headerProgress}
      </HeaderProgressSlot>
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
          <span title={summary.tokenCount === '—' ? 'Token usage unavailable' : summary.tokenProvenance === 'estimated' ? 'Estimated token usage' : 'Reported token usage'}>
            {summary.tokenProvenance === 'estimated' && summary.tokenCount !== '—' ? 'Estimated ' : ''}
            {formatMetric(summary.tokenCount, ' tokens')}
          </span>
          <span title="Elapsed time">
            <Clock3 aria-hidden="true" />
            {formatDuration(summary.durationMs)}
          </span>
          <span className="agentic-session__model" title={summary.model}>
            {summary.model}
          </span>
        </button>
        <SubagentsHeaderButton chatId={chatId} nativeRuns={nativeRuns} />
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
            aria-label={actions.retryLabel ?? 'Retry run'}
            title={actions.retryLabel ?? 'Retry run'}
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
            <NotesSessionReferences messages={messages} />
            <label>
              <span>Console theme</span>
              <ThemedSelect
                label="Console theme"
                value={preferences.profile}
                onChange={(value) =>
                  onPreferences({ profile: value as ConsoleProfile })
                }
                options={CONSOLE_PROFILES.map(profile => ({ value: profile.id, label: profile.label }))}
              />
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Export HTML log"
                disabled={htmlExportBusy}
                onClick={onHtmlExport}
              >
                {htmlExportBusy ? 'Building HTML log…' : 'Export HTML log'}
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

function LiveTurnStatus({ event, compact }: { event: ChatActivityEvent; compact?: boolean }) {
  const motion = resolveAgentMotion({
    status: event.status,
    activityCategory: event.category,
    activityKind: event.kind,
    semanticIntent: event.semanticIntent,
    title: event.title,
    detail: event.detail,
    filePath: event.filePath,
  });
  if (!motion) return null;
  const thinking = event.category === 'thinking';
  const publicDetail = !thinking && event.detail ? sanitizeConsoleText(event.detail, 320).trim() : '';

  return (
    <div
      className="agentic-live-status"
      role="status"
      aria-live="polite"
      data-live-turn-status
      data-live-turn-category={event.category ?? event.kind}
    >
      <PerceptibleAgentMotionIndicator motion={motion} compact={compact} />
      <span className="agentic-live-status__text">
        {thinking ? 'Jarvis is thinking…' : event.title}
        {publicDetail ? ` · ${publicDetail}` : ''}
      </span>
    </div>
  );
}

type ActiveSessionStatus = Extract<
  AgenticSessionSummary['status'],
  'queued' | 'planning' | 'running' | 'recovering'
>;

function PreEventTurnStatus({
  status,
  compact,
}: {
  status: ActiveSessionStatus;
  compact?: boolean;
}) {
  const label =
    status === 'queued'
      ? 'Jarvis is queued…'
      : status === 'planning'
        ? 'Jarvis is planning…'
        : status === 'recovering'
          ? 'Jarvis is reconnecting…'
          : 'Jarvis is thinking…';
  const motion = resolveAgentMotion({ status: 'running', activityCategory: 'thinking' });

  return (
    <div
      className="agentic-live-status"
      role="status"
      aria-live="polite"
      data-live-turn-status
      data-live-turn-category={status}
      data-live-turn-source="session"
    >
      <PerceptibleAgentMotionIndicator motion={motion} compact={compact} />
      <span className="agentic-live-status__text">{label}</span>
    </div>
  );
}

function copyText(text: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success('Copied'))
    .catch(() => toast.error('Copy failed'));
}

function DiffView({
  block,
  compact,
}: {
  block: Extract<TranscriptBlock, { kind: 'diff' }>;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const detailId = React.useId();
  const lines = React.useMemo(() => formatUnifiedDiffLines(block.diff), [block.diff]);
  const label = block.status === 'done' ? 'Edited files'
    : block.status === 'error' ? 'Edit failed'
      : block.status === 'cancelled' ? 'Edit cancelled'
        : block.status === 'pending' ? 'Proposed file changes' : 'Editing files';
  const motion = resolveAgentMotion({
    status: block.status,
    activityCategory: block.activityCategory,
    activityKind: 'diff',
    title: block.title,
    filePath: block.filePath,
  });
  return (
    <section className="min-w-0">
      <button type="button" className="assistant-activity-ledger__disclosure"
        aria-expanded={expanded} aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}>
        <ChevronRight aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', expanded && 'rotate-90')} />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{label} · {block.filePath ?? block.title}</span>
      </button>
      <div id={detailId} hidden={!expanded}>
      {expanded ? (
    <article className="agentic-diff" aria-label={`Diff ${block.filePath ?? block.title}`}>
      <div className="agentic-block-head">
        <span>
          <PerceptibleAgentMotionIndicator motion={motion} compact={compact} />
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
      ) : null}
      </div>
    </section>
  );
}

function BlockView({
  block,
  finalAnswerId,
  compact,
  creatorDraftKind,
  nativeCheckpoint = false,
  hideNativeCheckpoint = false,
}: {
  block: TranscriptBlock;
  finalAnswerId?: string;
  compact?: boolean;
  creatorDraftKind?: JarvisCreatorKind;
  nativeCheckpoint?: boolean;
  hideNativeCheckpoint?: boolean;
}) {
  if (block.kind === 'prompt') return <PromptBand block={block} />;
  if (block.kind === 'answer') {
    const finalAnswerIndex = block.message.parts.reduce((last, part, index) => part.kind === 'text' && part.text.trim() ? index : last, -1);
    const finalInMessage = block.id === `message:${block.message.id}:answer:${finalAnswerIndex}`;
    if (nativeCheckpoint) {
      if (hideNativeCheckpoint) return null;
      const final = block.id === finalAnswerId;
      return (
        <div
          className={cn('agentic-native-checkpoint', final && 'is-final')}
          data-native-assistant-checkpoint={final ? 'final' : 'true'}
          data-native-final-answer={final ? 'true' : undefined}
          data-message-id={block.message.id}
        >
          <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
          <div className="agentic-native-checkpoint__text">
            {block.text}
            {finalInMessage ? <ResponseDetails usage={block.message.usage} /> : null}
          </div>
        </div>
      );
    }
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
        {finalInMessage ? <ResponseDetails usage={block.message.usage} /> : null}
      </article>
    );
  }
  if (block.kind === 'reasoning') {
    return <ThinkingDisclosure text={block.text} />;
  }
  if (block.kind === 'activity') {
    if (block.activityCategory === 'thinking' && block.title === 'Thinking' && block.status === 'running') {
      return <ThinkingDisclosure text={block.detail ?? ''} />;
    }
    // Chat-level lifecycle events do not have durable assistant-message
    // correlation. Render them once in the current turn activity ledger instead of
    // manufacturing a wall of standalone assistant/status messages.
    return null;
  }
  if (block.kind === 'diff') return <DiffView block={block} compact={compact} />;
  // Persisted command/tool payloads are represented by the privacy-safe
  // AssistantActivityLedger at their message boundary. Never expose their
  // arguments, command text, stdout, stderr, environment, or raw results here.
  if (block.kind === 'command' || block.kind === 'tool') return null;
  return (
    <div className="agentic-legacy" data-agentic-fallback="structured-message">
      <MessageBubble
        message={block.message.role === 'user'
          ? { ...block.message, parts: block.message.parts.filter((part) => !parseChatNoteReference(part)) }
          : block.message}
        compact={compact}
        creatorDraftKind={creatorDraftKind}
        showActivityLedger={false}
      />
    </div>
  );
}

function isInlineLedgerLegacyBlock(block: TranscriptBlock, latestUserTurnStartedAt: number) {
  if (
    block.kind !== 'legacy' ||
    block.message.role !== 'assistant' ||
    block.message.created_at < latestUserTurnStartedAt
  ) {
    return false;
  }
  const hasProse = block.message.parts.some(
    (part) => part.kind === 'text' && part.text.trim().length > 0,
  );
  const hasContextReferences = block.message.parts.some(
    (part) => part.kind === 'jarvis_source_ref',
  );
  const canSplitWithoutChangingInteractiveContent = block.message.parts.every(
    (part) =>
      part.kind === 'text' ||
      part.kind === 'jarvis_source_ref' ||
      part.kind === 'tool_call' ||
      part.kind === 'tool_result',
  );
  return hasProse && hasContextReferences && canSplitWithoutChangingInteractiveContent;
}

function terminalStatus(status: AgenticSessionSummary['status']): boolean {
  return (
    status === 'done' ||
    status === 'blocked' ||
    status === 'partial' ||
    status === 'error' ||
    status === 'cancelled'
  );
}

function formatAuditCount(value: number): string {
  return value.toLocaleString();
}

function formatAuditDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1_000) return '<1s';
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function SessionCompletionAudit({
  ledger,
  durationMs,
  expanded,
  onExpandedChange,
  status,
}: {
  ledger: AssistantActivityLedgerProjection;
  durationMs?: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  status: AgenticSessionSummary['status'];
}) {
  const elapsed = durationMs ?? ledger.durationMs ?? 0;
  const actionText = `${formatAuditCount(ledger.actionsTotal)} ${ledger.actionsTotal === 1 ? 'action' : 'actions'}`;
  const statusLabel =
    status === 'error'
      ? 'Failed'
      : status === 'cancelled'
        ? 'Cancelled'
        : status === 'blocked'
          ? 'Blocked'
          : status === 'partial'
            ? 'Partial'
            : undefined;
  const metrics = [
    ledger.readsTotal > 0 ? `Read ${formatAuditCount(ledger.readsTotal)}` : '',
    ledger.searchesTotal > 0 ? `Searched ${formatAuditCount(ledger.searchesTotal)}` : '',
    ledger.commandsTotal > 0
      ? `Ran ${formatAuditCount(ledger.commandsTotal)} ${ledger.commandsTotal === 1 ? 'command' : 'commands'}`
      : '',
    ledger.editedFilesTotal > 0
      ? `Edited ${formatAuditCount(ledger.editedFilesTotal)} ${ledger.editedFilesTotal === 1 ? 'file' : 'files'}`
      : '',
    ledger.verifiedChecksTotal > 0
      ? `Verified ${formatAuditCount(ledger.verifiedChecksTotal)} ${ledger.verifiedChecksTotal === 1 ? 'check' : 'checks'}`
      : '',
  ].filter(Boolean);

  return (
    <section
      className="agentic-turn-audit"
      aria-label="Completed work audit"
      data-terminal-status={status}
      data-work-details-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className="agentic-turn-audit__disclosure"
        aria-label={`${expanded ? 'Collapse' : 'Expand'} completed work details`}
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        <ChevronDown
          className={cn('agentic-turn-audit__chevron', expanded && 'is-expanded')}
          aria-hidden="true"
        />
        <strong>
          Worked for {formatAuditDuration(elapsed)} · {actionText}
        </strong>
        {statusLabel ? <span className="agentic-turn-audit__status">{statusLabel}</span> : null}
        <span className="agentic-turn-audit__metrics" aria-label="Recorded work totals">
          {metrics.map((metric) => (
            <span key={metric}>{metric}</span>
          ))}
        </span>
      </button>
    </section>
  );
}

export function shouldRenderInlineLegacyLedger(
  message: Message,
  hasTurnToolEvidence: boolean,
): boolean {
  return (
    !hasTurnToolEvidence ||
    message.parts.some((part) => part.kind === 'tool_call' || part.kind === 'tool_result')
  );
}

export function selectAssistantLedgerOwnerIds(messages: readonly Message[]): ReadonlySet<string> {
  const owners = new Set<string>();
  let turn: Message[] = [];
  const commitTurn = () => {
    const assistants = turn.filter((message) => message.role === 'assistant');
    const owner =
      [...assistants]
        .reverse()
        .find((message) =>
          message.parts.some(
            (part) =>
              part.kind === 'action_proposal' ||
              part.kind === 'tool_call' ||
              part.kind === 'tool_result',
          ),
        ) ?? assistants.at(-1);
    if (owner) owners.add(String(owner.id));
    turn = [];
  };
  for (const message of messages) {
    if (message.role === 'user') commitTurn();
    turn.push(message);
  }
  commitTurn();
  return owners;
}

type NativeCheckpointLedgerPlacement = Readonly<{
  sourceId: string;
  message: Message;
  needsNeutralCheckpoint?: boolean;
}>;

function nativeCheckpointLedgerPlacements(
  blocks: readonly TranscriptBlock[],
  messagesBySource: ReadonlyMap<string, Message>,
): ReadonlyMap<string, NativeCheckpointLedgerPlacement> {
  const placements = new Map<string, NativeCheckpointLedgerPlacement>();
  const blocksBySource = new Map<string, TranscriptBlock[]>();
  for (const block of blocks) {
    const sourceBlocks = blocksBySource.get(block.sourceId);
    if (sourceBlocks) sourceBlocks.push(block);
    else blocksBySource.set(block.sourceId, [block]);
  }
  for (const [sourceId, message] of messagesBySource) {
    if (!ownsNativeOpenCodeChronology(message)) continue;
    const sourceBlocks = blocksBySource.get(sourceId) ?? [];

    let callIds = new Set<string>();
    let lastToolBlockId: string | undefined;
    let hasAssistantCheckpoint = false;
    const hasAnyAssistantCheckpoint = sourceBlocks.some((block) => block.kind === 'answer');
    let phaseIndex = 0;
    const sourcePlacementIds: string[] = [];
    const flush = () => {
      if (!lastToolBlockId || callIds.size === 0) return;
      const scopedParts = message.parts.filter(
        (part) =>
          (part.kind === 'tool_call' || part.kind === 'tool_result') && callIds.has(part.call_id),
      );
      if (scopedParts.length > 0) {
        placements.set(lastToolBlockId, {
          sourceId,
          ...(!hasAssistantCheckpoint && !hasAnyAssistantCheckpoint
            ? { needsNeutralCheckpoint: true }
            : {}),
          message: {
            ...message,
            id: `${String(message.id)}:checkpoint:${phaseIndex}` as Message['id'],
            parts: scopedParts,
            usage: undefined,
          },
        });
        sourcePlacementIds.push(lastToolBlockId);
        phaseIndex += 1;
      }
      callIds = new Set<string>();
      lastToolBlockId = undefined;
    };

    for (const block of sourceBlocks) {
      if (block.kind === 'answer') {
        flush();
        hasAssistantCheckpoint = true;
      } else if (block.kind === 'command' || block.kind === 'tool') {
        callIds.add(block.callId);
        lastToolBlockId = block.id;
      }
    }
    flush();
    const finalPlacementId = sourcePlacementIds.at(-1);
    const finalPlacement = finalPlacementId ? placements.get(finalPlacementId) : undefined;
    if (finalPlacementId && finalPlacement && message.usage) {
      placements.set(finalPlacementId, {
        ...finalPlacement,
        message: { ...finalPlacement.message, usage: message.usage },
      });
    }
  }
  return placements;
}

function ownsNativeOpenCodeChronology(message: Message, modelHint?: string): boolean {
  if (message.role !== 'assistant') return false;
  const hasTools = message.parts.some(
    (part) => part.kind === 'tool_call' || part.kind === 'tool_result',
  );
  if (!hasTools) return false;
  const publicTextParts = message.parts.filter(
    (part) => part.kind === 'text' && part.text.trim().length > 0,
  ).length;
  const model = (message.usage?.model ?? modelHint ?? '').toLocaleLowerCase('en-US');
  return publicTextParts > 1 || model.includes('opencode');
}

function nativeTranscriptMessage(message: Message, modelHint?: string): Message {
  if (!ownsNativeOpenCodeChronology(message, modelHint)) return message;
  const projectedModel = message.usage?.model ?? modelHint;
  return {
    ...message,
    ...(projectedModel ? { usage: { ...(message.usage ?? {}), model: projectedModel } } : {}),
    parts: message.parts.filter(
      (part) => part.kind !== 'jarvis_source_ref',
    ),
  };
}

function latestTurnAuditMessage(
  messages: readonly Message[],
  latestUserTurnStartedAt: number,
): Message | undefined {
  const assistants = messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.created_at >= latestUserTurnStartedAt &&
      message.parts.some((part) => part.kind === 'tool_call' || part.kind === 'tool_result'),
  );
  const finalAssistant = assistants.at(-1);
  if (!finalAssistant) return undefined;

  return {
    ...finalAssistant,
    id: `${String(finalAssistant.id)}:turn-audit` as Message['id'],
    parts: assistants.flatMap((message) => message.parts),
    created_at: assistants.reduce(
      (earliest, message) => Math.min(earliest, message.created_at),
      finalAssistant.created_at,
    ),
    updated_at: assistants.reduce(
      (latest, message) => Math.max(latest, message.updated_at),
      finalAssistant.updated_at,
    ),
  };
}

export function AgenticConsole({
  chatId,
  messages,
  activity,
  compact = false,
  creatorDraftKind,
  sessionEvidence,
  headerProgress,
  actions,
}: AgenticConsoleProps) {
  const [preferences, updatePreferences] = useConsolePreferences();
  const [mountedCount, setMountedCount] = React.useState(MAX_MOUNTED_BLOCKS);
  const [latestTurnDetailsExpanded, setLatestTurnDetailsExpanded] = React.useState(true);
  const rootRef = React.useRef<HTMLElement>(null);
  const summary = React.useMemo(
    () => summarizeAgenticSession(messages, activity, sessionEvidence),
    [messages, activity, sessionEvidence],
  );
  const transcriptMessages = React.useMemo(
    () => messages.map((message) => nativeTranscriptMessage(message, summary.model)),
    [messages, summary.model],
  );
  const transcriptWindow = React.useMemo(
    () =>
      projectAgenticTranscriptWindow(transcriptMessages, activity, mountedCount, {
        preserveAssistantMessages: creatorDraftKind != null,
      }),
    [transcriptMessages, activity, mountedCount, creatorDraftKind],
  );
  const blocks = transcriptWindow.visible;
  const latestUserTurnStartedAt = React.useMemo(
    () =>
      messages.reduce(
        (latest, message) =>
          message.role === 'user' ? Math.max(latest, message.created_at) : latest,
        Number.NEGATIVE_INFINITY,
      ),
    [messages],
  );
  const finalAnswerId = [...blocks].reverse().find((block) =>
    block.kind === 'answer' && block.message.created_at >= latestUserTurnStartedAt)?.id;
  const turnActivity = React.useMemo(
    () => activity.filter((event) => (event.startedAt ?? event.ts) >= latestUserTurnStartedAt),
    [activity, latestUserTurnStartedAt],
  );
  const hasTurnToolEvidence = React.useMemo(
    () =>
      messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.created_at >= latestUserTurnStartedAt &&
          message.parts.some((part) => part.kind === 'tool_call' || part.kind === 'tool_result'),
      ),
    [latestUserTurnStartedAt, messages],
  );
  const turnAuthoritativeDurationMs =
    typeof summary.durationMs === 'number' &&
    summary.durationMs > 0 &&
    typeof summary.startedAt === 'number' &&
    summary.startedAt >= latestUserTurnStartedAt
      ? summary.durationMs
      : undefined;
  const sessionIsActive =
    summary.status === 'queued' ||
    summary.status === 'planning' ||
    summary.status === 'running' ||
    summary.status === 'recovering';
  const nativeRuns = React.useMemo(
    () => collectNativeTaskRuns(messages, turnActivity, latestUserTurnStartedAt, !sessionIsActive),
    [messages, turnActivity, latestUserTurnStartedAt, sessionIsActive],
  );
  const liveTurnActivity = React.useMemo(
    () =>
      [...turnActivity]
        .reverse()
        .find((event) => event.status === 'pending' || event.status === 'running'),
    [turnActivity],
  );
  const turnAuditMessage = React.useMemo(
    () => latestTurnAuditMessage(messages, latestUserTurnStartedAt),
    [latestUserTurnStartedAt, messages],
  );
  const turnAuditLedger = React.useMemo(
    () => (turnAuditMessage ? projectAssistantActivityLedger(turnAuditMessage) : undefined),
    [turnAuditMessage],
  );
  const showTurnCompletionAudit = Boolean(
    terminalStatus(summary.status) &&
    !sessionIsActive &&
    turnAuditLedger &&
    turnAuditLedger.actionsTotal > 0,
  );
  const latestTurnActivityCollapsed = showTurnCompletionAudit && !latestTurnDetailsExpanded;

  React.useEffect(() => {
    setLatestTurnDetailsExpanded(true);
  }, [latestUserTurnStartedAt]);
  const latestActiveEvidenceAt = React.useMemo(
    () =>
      turnActivity.reduce(
        (latest, event) =>
          event.status === 'running' || event.status === 'pending'
            ? Math.max(latest, event.startedAt ?? event.ts)
            : latest,
        Number.NEGATIVE_INFINITY,
      ),
    [turnActivity],
  );
  const latestAssistantMessageId = React.useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            message.created_at >= latestUserTurnStartedAt &&
            message.updated_at >= latestActiveEvidenceAt,
        )?.id,
    [latestActiveEvidenceAt, latestUserTurnStartedAt, messages],
  );
  const turnActivityMessage = React.useMemo<Message | undefined>(() => {
    // Durable assistant message parts own their own response-phase ledgers.
    // Uncorrelated live events get one latest-turn fallback only when no such
    // evidence exists, preventing duplicate or guessed receipts.
    if (turnActivity.length === 0 || hasTurnToolEvidence) return undefined;
    let startedAt = turnActivity[0]!.startedAt ?? turnActivity[0]!.ts;
    let updatedAt = turnActivity[0]!.endedAt ?? turnActivity[0]!.ts;
    for (let index = 1; index < turnActivity.length; index += 1) {
      const event = turnActivity[index]!;
      const eventStartedAt = event.startedAt ?? event.ts;
      const eventUpdatedAt = event.endedAt ?? event.ts;
      if (eventStartedAt < startedAt) startedAt = eventStartedAt;
      if (eventUpdatedAt > updatedAt) updatedAt = eventUpdatedAt;
    }
    return {
      id: `session-activity:${chatId}` as Message['id'],
      chat_id: chatId as Message['chat_id'],
      role: 'assistant',
      // Activity events are not durably correlated to one assistant message.
      // Bound the fallback to the latest user turn without guessing a phase.
      parts: [],
      created_at: startedAt,
      updated_at: updatedAt,
    };
  }, [chatId, hasTurnToolEvidence, turnActivity]);
  const inlineLedgerLegacyBlock = React.useMemo(
    () =>
      [...blocks]
        .reverse()
        .find((block) => isInlineLedgerLegacyBlock(block, latestUserTurnStartedAt)),
    [blocks, latestUserTurnStartedAt],
  );
  const inlineLedgerLegacyId = inlineLedgerLegacyBlock?.id;
  const loadCount = Math.min(TRANSCRIPT_PAGE_SIZE, transcriptWindow.remaining);
  const messagesBySource = React.useMemo(
    () =>
      new Map<string, Message>(
        transcriptMessages.map((message) => [`message:${String(message.id)}`, message] as const),
      ),
    [transcriptMessages],
  );
  const assistantLedgerOwnerIds = React.useMemo(
    () => selectAssistantLedgerOwnerIds(messages),
    [messages],
  );
  const nativeCheckpointLedgers = React.useMemo(
    () => nativeCheckpointLedgerPlacements(blocks, messagesBySource),
    [blocks, messagesBySource],
  );
  const nativeCheckpointSourceIds = React.useMemo(
    () => new Set([...nativeCheckpointLedgers.values()].map((placement) => placement.sourceId)),
    [nativeCheckpointLedgers],
  );
  const lastVisibleIndexBySource = React.useMemo(() => {
    const indexes = new Map<string, number>();
    blocks.forEach((block, index) => indexes.set(block.sourceId, index));
    return indexes;
  }, [blocks]);
  const latestPromptBlockId = React.useMemo(
    () =>
      [...blocks]
        .reverse()
        .find(
          (block) =>
            block.kind === 'prompt' && block.message.created_at === latestUserTurnStartedAt,
        )?.id,
    [blocks, latestUserTurnStartedAt],
  );

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
    const exportBlocks = projectAgenticTranscript(messages, activity, {
      preserveAssistantMessages: creatorDraftKind != null,
    }).map((block) => {
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

  const binding = useJarvisCommandCenterBinding();
  const [htmlExportBusy, setHtmlExportBusy] = React.useState(false);
  const htmlExportFlight = React.useRef(false);
  const exportChatRef = React.useRef(chatId);
  exportChatRef.current = chatId;
  React.useEffect(() => {
    exportChatRef.current = chatId;
    return () => { exportChatRef.current = ''; };
  }, [chatId]);
  const exportHtmlLog = async () => {
    if (htmlExportFlight.current) return;
    const accountId = getActiveAccountIdentity()?.accountId;
    if (!accountId) {
      toast.error('HTML log unavailable', 'Wait for account loading to finish.');
      return;
    }
    htmlExportFlight.current = true;
    setHtmlExportBusy(true);
    try {
      const log = await loadChatDebugLog({
        accountId,
        chatId,
        listMessages: () => messageRepo.listByChat(chatId as Message['chat_id']),
        getChat: () => chatRepo.getById(chatId as Message['chat_id']),
        activity,
        dataPort: binding?.hostPort.accountId === accountId ? binding.dataPort : undefined,
        isCurrent: () => exportChatRef.current === chatId && getActiveAccountIdentity()?.accountId === accountId,
        rendererUptimeMs: performance.now(),
      });
      downloadChatDebugLog(log);
    } catch {
      toast.error('HTML log not exported', 'The chat/account changed or its saved records could not be read. Try again.');
    } finally {
      htmlExportFlight.current = false;
      if (exportChatRef.current) setHtmlExportBusy(false);
    }
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
    messages.length > 0 ||
    activity.length > 0 ||
    Boolean(sessionEvidence) ||
    transcriptWindow.total > 0;
  if (!hasTranscriptWork) return null;

  const turnTopMatter = (
    <>
      {latestPromptBlockId && sessionIsActive ? (
        liveTurnActivity ? (
          <LiveTurnStatus event={liveTurnActivity} compact={compact} />
        ) : (
          <PreEventTurnStatus status={summary.status as ActiveSessionStatus} compact={compact} />
        )
      ) : null}
      {showTurnCompletionAudit && turnAuditLedger ? (
        <SessionCompletionAudit
          ledger={turnAuditLedger}
          durationMs={turnAuthoritativeDurationMs}
          expanded={latestTurnDetailsExpanded}
          onExpandedChange={setLatestTurnDetailsExpanded}
          status={summary.status}
        />
      ) : null}
    </>
  );

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
        messages={messages}
        summary={summary}
        nativeRuns={nativeRuns}
        preferences={preferences}
        headerProgress={headerProgress}
        onPreferences={updatePreferences}
        actions={actions}
        onExpandAll={() => setDetailsOpen(true)}
        onCollapseAll={() => setDetailsOpen(false)}
        onCopySummary={() => copyText(summaryText)}
        onExport={exportSession}
        onHtmlExport={() => { void exportHtmlLog(); }}
        htmlExportBusy={htmlExportBusy}
      />
      {blocks.length > 0 ? (
        <div className="agentic-transcript" role="region" aria-label="Agentic transcript">
          {transcriptWindow.remaining > 0 ? (
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
          {!latestPromptBlockId ? turnTopMatter : null}
          {blocks.map((block, index) => {
            const sourceMessage = messagesBySource.get(block.sourceId);
            const sourceIsLatestAssistantTurn = Boolean(
              sourceMessage?.role === 'assistant' &&
              sourceMessage.created_at >= latestUserTurnStartedAt,
            );
            const nativeCheckpointLedger = nativeCheckpointLedgers.get(block.id);
            const inlineLegacyMessage =
              block.id === inlineLedgerLegacyId && block.kind === 'legacy'
                ? block.message
                : undefined;
            const inlineContextReferences = inlineLegacyMessage?.parts.filter(
              (part) => part.kind === 'jarvis_source_ref',
            );
            const showLedger =
              sourceMessage?.role === 'assistant' &&
              lastVisibleIndexBySource.get(block.sourceId) === index &&
              assistantLedgerOwnerIds.has(String(sourceMessage.id)) &&
              !nativeCheckpointSourceIds.has(block.sourceId) &&
              !(latestTurnActivityCollapsed && sourceIsLatestAssistantTurn) &&
              !(turnActivityMessage && sourceMessage.created_at >= latestUserTurnStartedAt);
            return (
              <React.Fragment key={block.id}>
                {inlineLegacyMessage ? (
                  <div className="agentic-legacy" data-agentic-fallback="structured-message">
                    <MessageBubble
                      message={{
                        ...inlineLegacyMessage,
                        parts: inlineLegacyMessage.parts.filter((part) => part.kind === 'text'),
                      }}
                      compact={compact}
                      creatorDraftKind={creatorDraftKind}
                      showActivityLedger={false}
                    />
                  </div>
                ) : (
                  <BlockView
                    block={block}
                    finalAnswerId={finalAnswerId}
                    compact={compact}
                    creatorDraftKind={creatorDraftKind}
                    nativeCheckpoint={nativeCheckpointSourceIds.has(block.sourceId)}
                    hideNativeCheckpoint={
                      latestTurnActivityCollapsed &&
                      sourceIsLatestAssistantTurn &&
                      block.id !== finalAnswerId
                    }
                  />
                )}
                {block.id === latestPromptBlockId ? turnTopMatter : null}
                {nativeCheckpointLedger &&
                !(latestTurnActivityCollapsed && sourceIsLatestAssistantTurn) ? (
                  <>
                    {nativeCheckpointLedger.needsNeutralCheckpoint && sessionIsActive ? (
                      <div
                        className="agentic-native-checkpoint is-neutral-fallback"
                        data-native-assistant-checkpoint="fallback"
                      >
                        <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
                        <div className="agentic-native-checkpoint__text">Working…</div>
                      </div>
                    ) : null}
                    <AssistantActivityLedger
                      message={nativeCheckpointLedger.message}
                      compact={compact}
                      active={sessionIsActive && sourceMessage?.id === latestAssistantMessageId}
                      presentation="opencode-chronology"
                    />
                  </>
                ) : null}
                {showLedger ? (
                  <AssistantActivityLedger
                    message={sourceMessage}
                    compact={compact}
                    active={sessionIsActive && sourceMessage.id === latestAssistantMessageId}
                  />
                ) : null}
                {(block.id === inlineLedgerLegacyId ||
                  (!inlineLedgerLegacyId && block.id === finalAnswerId)) &&
                turnActivityMessage ? (
                  <AssistantActivityLedger
                    message={turnActivityMessage}
                    correlatedEvents={turnActivity}
                    authoritativeDurationMs={turnAuthoritativeDurationMs}
                    compact={compact}
                    active={sessionIsActive}
                  />
                ) : null}
                {inlineLegacyMessage && inlineContextReferences?.length ? (
                  <div
                    className="agentic-context-references"
                    aria-label="Assistant context references"
                  >
                    {inlineContextReferences.map((part, partIndex) => (
                      <MessagePart
                        key={`${part.source.id}:${partIndex}`}
                        part={part}
                        allParts={inlineLegacyMessage.parts}
                        messageId={inlineLegacyMessage.id}
                        chatId={inlineLegacyMessage.chat_id}
                      />
                    ))}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
          <StreamingChatPreview chatId={chatId} fallback={turnActivityMessage && !inlineLedgerLegacyId && !finalAnswerId ? (
            <AssistantActivityLedger
              message={turnActivityMessage}
              correlatedEvents={turnActivity}
              authoritativeDurationMs={turnAuthoritativeDurationMs}
              compact={compact}
              active={sessionIsActive}
            />
          ) : null} />
        </div>
      ) : null}
    </section>
  );
}

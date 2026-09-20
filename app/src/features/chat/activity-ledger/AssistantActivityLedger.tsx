import * as React from 'react';
import {
  ChevronDown,
  Clock3,
  FileText,
  PlugZap,
  Search,
  TerminalSquare,
  Users,
  Wrench,
} from 'lucide-react';
import type { Message } from '@/types';
import { cn } from '@/lib/utils';
import { FileAttachmentPreview } from '../FileAttachmentPreview';
import { ToolDetailsInspector } from './ToolDetailsInspector';
import { resolveToolChatRoot } from './toolFileActions';
import type { ChatActivityEvent } from '../activity/types';
import {
  PerceptibleAgentMotionIndicator,
  resolveAgentMotion,
} from '../agentic-console/AgentMotionIndicator';
import {
  projectAssistantActivityLedger,
  type AssistantActivityReceipt,
  type AssistantActivityLedgerProjection,
  type LedgerReceiptKind,
  type LedgerUsageValue,
} from './ledgerProjection';
import './activity-ledger.css';

export const DETAIL_PAGE_SIZE = 40;

export type AssistantActivityLedgerPresentation = 'default' | 'opencode-chronology';

function formatCount(value: number): string {
  return value.toLocaleString();
}

function usageText(label: 'In' | 'Out', usage: LedgerUsageValue): string {
  if (usage.value === null) return '';
  return `${label} ${usage.provenance === 'estimated' ? '≈' : ''}${formatCount(usage.value)}`;
}

function usageTitle(usage: LedgerUsageValue): string {
  if (usage.source === 'provider-reported') return 'Exact provider usage';
  if (usage.source === 'response-metadata') return 'Exact response metadata';
  if (usage.provenance === 'estimated') return 'Estimated locally';
  return 'Usage unavailable';
}

function metric(label: string, value: number): string {
  return `${label} ${formatCount(value)}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs > 0 && durationMs < 1_000) return '<1s';
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function actionLabel(value: number): string {
  return `${formatCount(value)} ${value === 1 ? 'action' : 'actions'}`;
}

function commandMetric(value: number): string {
  return `Ran ${formatCount(value)} ${value === 1 ? 'command' : 'commands'}`;
}

function joinedPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases.at(-1)}`;
}

function phaseSummary(ledger: AssistantActivityLedgerProjection, active: boolean): string {
  const running = [...ledger.receipts]
    .reverse()
    .find((receipt) => receipt.status === 'running' || receipt.status === 'pending');
  if (active && running) {
    const target = running.fileLabel ? ` ${running.fileLabel}` : '';
    const action =
      running.kind === 'read'
        ? `reading${target}`
        : running.kind === 'edit'
          ? `editing${target}`
          : running.kind === 'search'
            ? 'searching'
            : running.kind === 'command'
              ? 'running a command'
              : running.kind === 'check'
                ? 'verifying a check'
                : running.kind === 'subagent'
                  ? 'coordinating a subagent'
                  : 'working on the current action';
    return `I’m ${action} now. No next action is recorded yet.`;
  }

  if (active) {
    return `I recorded ${actionLabel(ledger.actionsTotal)} in this active response. No current or next action is recorded yet.`;
  }
  if (ledger.status === 'cancelled') {
    return `I recorded ${actionLabel(ledger.actionsTotal)} before this response was cancelled. No next action is recorded for this response.`;
  }
  if (ledger.status === 'error') {
    return `I recorded ${actionLabel(ledger.actionsTotal)} before this response encountered an error. No next action is recorded for this response.`;
  }
  const phrases = [
    ledger.readsTotal > 0
      ? `read ${formatCount(ledger.readsTotal)} ${ledger.readsTotal === 1 ? 'file' : 'files'}`
      : '',
    ledger.searchesTotal > 0
      ? `completed ${formatCount(ledger.searchesTotal)} ${ledger.searchesTotal === 1 ? 'search' : 'searches'}`
      : '',
    ledger.commandsTotal > 0
      ? `ran ${formatCount(ledger.commandsTotal)} ${ledger.commandsTotal === 1 ? 'command' : 'commands'}`
      : '',
    ledger.editedFilesTotal > 0
      ? `edited ${formatCount(ledger.editedFilesTotal)} ${ledger.editedFilesTotal === 1 ? 'file' : 'files'}`
      : '',
    ledger.verifiedChecksTotal > 0
      ? `verified ${formatCount(ledger.verifiedChecksTotal)} ${ledger.verifiedChecksTotal === 1 ? 'check' : 'checks'}`
      : '',
  ].filter(Boolean);
  return `I completed ${formatCount(ledger.actionsTotal)} recorded ${ledger.actionsTotal === 1 ? 'action' : 'actions'}${phrases.length ? `: ${joinedPhrases(phrases)}` : ''}. No next action is recorded for this response.`;
}

type ActivityPhaseKind = 'context' | 'tools' | 'verification';

type ActivityPhase = Readonly<{
  kind: ActivityPhaseKind;
  receipts: readonly AssistantActivityReceipt[];
}>;

function phaseKind(receipt: AssistantActivityReceipt): ActivityPhaseKind {
  if (receipt.kind === 'read' || receipt.kind === 'search') return 'context';
  if (receipt.kind === 'check') return 'verification';
  return 'tools';
}

function partitionActivityPhases(
  receipts: readonly AssistantActivityReceipt[],
): readonly ActivityPhase[] {
  const phases: Array<{ kind: ActivityPhaseKind; receipts: AssistantActivityReceipt[] }> = [];
  for (const receipt of receipts) {
    const kind = phaseKind(receipt);
    const current = phases.at(-1);
    if (!current || current.kind !== kind) phases.push({ kind, receipts: [receipt] });
    else current.receipts.push(receipt);
  }
  return phases;
}

function phaseProjection(
  base: AssistantActivityLedgerProjection,
  phase: ActivityPhase,
  terminalPhase: boolean,
): AssistantActivityLedgerProjection {
  const receipts = phase.receipts;
  const reads = new Set(
    receipts
      .filter((receipt) => receipt.kind === 'read' && receipt.status === 'done')
      .map((receipt) => receipt.filePath ?? receipt.fileLabel ?? receipt.id),
  );
  const edits = new Set(
    receipts
      .filter((receipt) => receipt.kind === 'edit')
      .map((receipt) => receipt.filePath ?? receipt.fileLabel ?? receipt.id),
  );
  const checks = receipts.filter((receipt) => receipt.kind === 'check');
  const startedAt = receipts[0]?.ts ?? base.startedAt;
  const last = receipts.at(-1);
  const endedAt = last
    ? last.ts + (last.durationMs ?? 0)
    : terminalPhase
      ? base.endedAt
      : undefined;
  const status = terminalPhase
    ? base.status
    : receipts.some((receipt) => receipt.status === 'error')
      ? 'error'
      : receipts.some((receipt) => receipt.status === 'cancelled')
        ? 'cancelled'
        : 'done';
  const running = receipts
    .filter((receipt) => receipt.status === 'running' || receipt.status === 'pending')
    .at(-1);
  return {
    status,
    ...(running ? { currentOperation: running.label } : {}),
    actionsTotal: receipts.length,
    readsTotal: reads.size,
    searchesTotal: receipts.filter((receipt) => receipt.kind === 'search').length,
    commandsTotal: receipts.filter((receipt) => receipt.kind === 'command').length,
    editedFilesTotal: edits.size,
    verifiedChecksTotal: checks.filter((receipt) => receipt.status === 'done').length,
    failedChecksTotal: checks.filter((receipt) => receipt.status === 'error').length,
    subagentsTotal: receipts.filter((receipt) => receipt.kind === 'subagent').length,
    usage: terminalPhase
      ? base.usage
      : {
          input: { value: null, provenance: 'unavailable', source: 'unavailable' },
          output: { value: null, provenance: 'unavailable', source: 'unavailable' },
        },
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt, durationMs: Math.max(0, endedAt - startedAt) }),
    receipts,
    omittedReceipts: 0,
  };
}

function completedPhaseSummary(phase: ActivityPhase, next?: ActivityPhase): string {
  const projection = phaseProjection(
    {
      status: 'done',
      actionsTotal: 0,
      readsTotal: 0,
      searchesTotal: 0,
      commandsTotal: 0,
      editedFilesTotal: 0,
      verifiedChecksTotal: 0,
      failedChecksTotal: 0,
      subagentsTotal: 0,
      usage: {
        input: { value: null, provenance: 'unavailable', source: 'unavailable' },
        output: { value: null, provenance: 'unavailable', source: 'unavailable' },
      },
      startedAt: phase.receipts[0]?.ts ?? 0,
      receipts: phase.receipts,
      omittedReceipts: 0,
    },
    phase,
    false,
  );
  const phrases = [
    projection.readsTotal
      ? `read ${formatCount(projection.readsTotal)} ${projection.readsTotal === 1 ? 'file' : 'files'}`
      : '',
    projection.searchesTotal
      ? `completed ${formatCount(projection.searchesTotal)} ${projection.searchesTotal === 1 ? 'search' : 'searches'}`
      : '',
    projection.commandsTotal
      ? `ran ${formatCount(projection.commandsTotal)} ${projection.commandsTotal === 1 ? 'command' : 'commands'}`
      : '',
    projection.editedFilesTotal
      ? `edited ${formatCount(projection.editedFilesTotal)} ${projection.editedFilesTotal === 1 ? 'file' : 'files'}`
      : '',
    projection.verifiedChecksTotal
      ? `verified ${formatCount(projection.verifiedChecksTotal)} ${projection.verifiedChecksTotal === 1 ? 'check' : 'checks'}`
      : '',
    projection.failedChecksTotal
      ? `recorded ${formatCount(projection.failedChecksTotal)} failed ${projection.failedChecksTotal === 1 ? 'check' : 'checks'}`
      : '',
    projection.subagentsTotal
      ? `recorded ${formatCount(projection.subagentsTotal)} ${projection.subagentsTotal === 1 ? 'subagent action' : 'subagent actions'}`
      : '',
  ].filter(Boolean);
  const first = `I ${joinedPhrases(phrases) || `recorded ${actionLabel(projection.actionsTotal)}`}${phase.kind === 'context' ? ' to gather context' : ''}.`;
  if (!next) return `${first} No next action is recorded for this response.`;
  const nextText =
    next.kind === 'context'
      ? 'gathered the next recorded context'
      : next.kind === 'verification'
        ? `verified the recorded project ${next.receipts.length === 1 ? 'check' : 'checks'}`
        : 'used the recorded project tools';
  return `${first} Next, I ${nextText}.`;
}

function phaseTitle(kind: ActivityPhaseKind): string {
  if (kind === 'context') return 'Context';
  if (kind === 'verification') return 'Verification';
  return 'Tools';
}

function receiptIcon(receipt: AssistantActivityReceipt) {
  const { kind } = receipt;
  if (receipt.plugin || receipt.mcpServer) return <PlugZap aria-hidden="true" />;
  if (kind === 'read' || kind === 'edit') return <FileText aria-hidden="true" />;
  if (kind === 'search') return <Search aria-hidden="true" />;
  if (kind === 'command') return <TerminalSquare aria-hidden="true" />;
  if (kind === 'subagent') return <Users aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

function chronologyTitle(ledger: AssistantActivityLedgerProjection, active: boolean): string {
  if (ledger.status === 'error') return `${actionLabel(ledger.actionsTotal)} · failed`;
  if (ledger.status === 'cancelled') return `${actionLabel(ledger.actionsTotal)} · cancelled`;
  if (active) return `Working · ${actionLabel(ledger.actionsTotal)}`;
  const kinds = new Set(ledger.receipts.map((receipt) => receipt.kind));
  if (kinds.size !== 1) return actionLabel(ledger.actionsTotal);
  const kind = [...kinds][0];
  if (kind === 'read') {
    const count = ledger.receipts.length;
    return `Read ${formatCount(count)} ${count === 1 ? 'file' : 'files'}`;
  }
  if (kind === 'edit') {
    const count = ledger.editedFilesTotal || ledger.receipts.length;
    return `Edited ${formatCount(count)} ${count === 1 ? 'file' : 'files'}`;
  }
  if (kind === 'command') return commandMetric(ledger.commandsTotal || ledger.receipts.length);
  if (kind === 'check') {
    const count = ledger.verifiedChecksTotal || ledger.receipts.length;
    return `Verified ${formatCount(count)} ${count === 1 ? 'check' : 'checks'}`;
  }
  return actionLabel(ledger.actionsTotal);
}

function chronologyReceiptText(receipt: AssistantActivityReceipt): string {
  const target = receipt.fileLabel ? ` ${receipt.fileLabel}` : '';
  const verbs: Record<LedgerReceiptKind, Readonly<[string, string]>> = {
    read: ['Read', 'Reading'],
    search: ['Searched', 'Searching'],
    command: ['Ran command', 'Running command'],
    edit: ['Edited', 'Editing'],
    check: ['Verified check', 'Verifying check'],
    subagent: ['Coordinated subagent', 'Coordinating subagent'],
    other: ['Used tool', 'Using tool'],
  };
  const [settled, running] = verbs[receipt.kind];
  if (receipt.status === 'error') return `Failed: ${running.toLocaleLowerCase('en-US')}${target}`;
  if (receipt.status === 'cancelled') {
    return `Cancelled: ${running.toLocaleLowerCase('en-US')}${target}`;
  }
  if (receipt.status === 'running' || receipt.status === 'pending') return `${running}${target}`;
  return `${settled}${target}`;
}

export function AssistantActivityLedger({
  message,
  correlatedEvents = [],
  projectRoot: suppliedProjectRoot,
  compact = false,
  active = false,
  responseStatus,
  authoritativeDurationMs,
  presentation = 'default',
}: {
  message: Message;
  correlatedEvents?: readonly ChatActivityEvent[];
  projectRoot?: string;
  compact?: boolean;
  /** Persisted message evidence is historical unless a caller owns live turn correlation. */
  active?: boolean;
  /** Terminal status supplied only by the owning current run. */
  responseStatus?: 'cancelled' | 'error';
  /** Stable duration supplied by the owning canonical run/session projection. */
  authoritativeDurationMs?: number;
  presentation?: AssistantActivityLedgerPresentation;
}) {
  const [storedRoot, setStoredRoot] = React.useState<{ chatId: string; root: string }>();
  React.useEffect(() => {
    if (suppliedProjectRoot) return;
    let disposed = false;
    void resolveToolChatRoot(String(message.chat_id))
      .then((root) => {
        if (!disposed) setStoredRoot(root ? { chatId: String(message.chat_id), root } : undefined);
      })
      .catch(() => {
        if (!disposed) setStoredRoot(undefined);
      });
    return () => {
      disposed = true;
    };
  }, [message.chat_id, suppliedProjectRoot]);
  const projectRoot =
    suppliedProjectRoot ??
    (storedRoot?.chatId === String(message.chat_id) ? storedRoot.root : undefined);
  const ledger = React.useMemo(() => {
    const projected = projectAssistantActivityLedger(message, correlatedEvents);
    return !active && responseStatus ? { ...projected, status: responseStatus } : projected;
  }, [message, correlatedEvents, active, responseStatus]);
  const phases = React.useMemo(
    () => (presentation === 'opencode-chronology' ? [] : partitionActivityPhases(ledger.receipts)),
    [ledger.receipts, presentation],
  );
  const hasUsage = ledger.usage.input.value !== null || ledger.usage.output.value !== null;
  if (ledger.actionsTotal === 0 && !hasUsage) return null;

  if (phases.length > 1) {
    return (
      <div className="assistant-activity-ledger-sequence" data-activity-phase-count={phases.length}>
        {phases.map((phase, index) => {
          const terminalPhase = index === phases.length - 1;
          const projected = phaseProjection(ledger, phase, terminalPhase);
          const phaseActive = active && terminalPhase;
          return (
            <AssistantActivityLedgerBlock
              key={`${phase.kind}:${phase.receipts[0]?.id ?? index}`}
              ledger={projected}
              summary={
                phaseActive || projected.status === 'cancelled' || projected.status === 'error'
                  ? phaseSummary(projected, phaseActive)
                  : completedPhaseSummary(phase, phases[index + 1])
              }
              title={`${phaseTitle(phase.kind)} · ${actionLabel(projected.actionsTotal)}`}
              correlatedEvents={phaseActive ? correlatedEvents : []}
              projectRoot={projectRoot}
              compact={compact}
              active={phaseActive}
              authoritativeDurationMs={terminalPhase ? authoritativeDurationMs : undefined}
            />
          );
        })}
      </div>
    );
  }

  return (
    <AssistantActivityLedgerBlock
      ledger={ledger}
      summary={phaseSummary(ledger, active)}
      correlatedEvents={correlatedEvents}
      projectRoot={projectRoot}
      compact={compact}
      active={active}
      authoritativeDurationMs={authoritativeDurationMs}
      presentation={presentation}
    />
  );
}

function AssistantActivityLedgerBlock({
  ledger,
  summary,
  title,
  correlatedEvents = [],
  projectRoot,
  compact = false,
  active = false,
  authoritativeDurationMs,
  presentation = 'default',
}: {
  ledger: AssistantActivityLedgerProjection;
  summary: string;
  title?: string;
  correlatedEvents?: readonly ChatActivityEvent[];
  projectRoot?: string;
  compact?: boolean;
  active?: boolean;
  authoritativeDurationMs?: number;
  presentation?: AssistantActivityLedgerPresentation;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [visibleCount, setVisibleCount] = React.useState(DETAIL_PAGE_SIZE);
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);
  const controlLabelId = React.useId();
  const titleId = React.useId();
  const metricsId = React.useId();
  const hasUsage = ledger.usage.input.value !== null || ledger.usage.output.value !== null;

  const visible = ledger.receipts.slice(0, visibleCount);
  const remaining = Math.max(0, ledger.receipts.length - visible.length);
  const runningReceipt = [...ledger.receipts]
    .reverse()
    .find((receipt) => receipt.status === 'running' || receipt.status === 'pending');
  const runningEvent = [...correlatedEvents]
    .reverse()
    .find((event) => event.status === 'running' || event.status === 'pending');
  const live = active;
  const durationMs =
    ledger.durationMs !== undefined && ledger.durationMs > 0
      ? ledger.durationMs
      : typeof authoritativeDurationMs === 'number' &&
          Number.isFinite(authoritativeDurationMs) &&
          authoritativeDurationMs >= 0
        ? authoritativeDurationMs
        : ledger.durationMs;
  const continuousResponseTitle =
    presentation === 'opencode-chronology'
      ? chronologyTitle(ledger, active)
      : (title ??
        (live
          ? `${ledger.currentOperation ?? 'Working'} · ${actionLabel(ledger.actionsTotal)}`
          : durationMs !== undefined
            ? `Worked for ${formatDuration(durationMs)} · ${actionLabel(ledger.actionsTotal)}`
            : `Activity · ${actionLabel(ledger.actionsTotal)}`));
  const motion = resolveAgentMotion(
    runningEvent
      ? {
          status: runningEvent.status,
          activityCategory: runningEvent.category,
          activityKind: runningEvent.kind,
          semanticIntent: runningEvent.semanticIntent,
          title: runningEvent.title,
          detail: runningEvent.detail,
          filePath: runningEvent.filePath,
        }
      : {
          status: live ? 'running' : 'done',
          activityKind:
            runningReceipt?.kind === 'subagent'
              ? 'subagent'
              : runningReceipt?.kind === 'read' || runningReceipt?.kind === 'edit'
                ? 'file'
                : 'tool',
        },
  );
  return (
    <section
      className={cn(
        'assistant-activity-ledger',
        compact && 'is-compact',
        presentation === 'opencode-chronology' && 'is-opencode-chronology',
      )}
      data-assistant-activity-ledger="true"
      data-ledger-active={active ? 'true' : 'false'}
      data-ledger-presentation={presentation}
    >
      {presentation === 'default' ? (
        <p
          className="assistant-activity-ledger__phase-summary"
          aria-live={active ? 'polite' : 'off'}
        >
          {summary}
        </p>
      ) : null}
      <button
        type="button"
        className="assistant-activity-ledger__disclosure"
        aria-expanded={expanded}
        aria-labelledby={`${controlLabelId} ${titleId}`}
        aria-describedby={presentation === 'default' ? metricsId : undefined}
        onClick={() => setExpanded((value) => !value)}
      >
        <span id={controlLabelId} className="sr-only">
          {expanded ? 'Hide activity details' : 'Show activity details'}
        </span>
        <ChevronDown
          className={cn('assistant-activity-ledger__chevron', expanded && 'is-open')}
          aria-hidden="true"
        />
        {presentation === 'default' ? (
          <PerceptibleAgentMotionIndicator motion={motion} compact />
        ) : null}
        <span id={titleId} className="assistant-activity-ledger__title">
          {continuousResponseTitle}
        </span>
        {presentation === 'default' ? (
          <span id={metricsId} className="assistant-activity-ledger__metrics">
            {ledger.readsTotal > 0 ? <span>{metric('Read', ledger.readsTotal)}</span> : null}
            {ledger.searchesTotal > 0 ? (
              <span>{metric('Searched', ledger.searchesTotal)}</span>
            ) : null}
            {ledger.commandsTotal > 0 ? <span>{commandMetric(ledger.commandsTotal)}</span> : null}
            {ledger.editedFilesTotal > 0 ? (
              <span>{metric('Edited', ledger.editedFilesTotal)}</span>
            ) : null}
            {ledger.verifiedChecksTotal > 0 ? (
              <span>{metric('Verified', ledger.verifiedChecksTotal)}</span>
            ) : null}
            {ledger.subagentsTotal > 0 ? (
              <span>{metric('Subagents', ledger.subagentsTotal)}</span>
            ) : null}
            {ledger.usage.input.value !== null ? (
              <span title={usageTitle(ledger.usage.input)}>
                {usageText('In', ledger.usage.input)}
              </span>
            ) : null}
            {ledger.usage.output.value !== null ? (
              <span title={usageTitle(ledger.usage.output)}>
                {usageText('Out', ledger.usage.output)}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div
          className="assistant-activity-ledger__inspector"
          role="region"
          aria-label="Assistant activity details"
        >
          {ledger.omittedReceipts > 0 ? (
            <p className="assistant-activity-ledger__notice">
              {formatCount(ledger.omittedReceipts)} older receipts are summarized in the totals.
            </p>
          ) : null}
          <div
            className="assistant-activity-ledger__receipts"
            role="list"
            aria-label="Activity receipts"
          >
            {visible.map((receipt) => (
              <ReceiptRow
                key={receipt.id}
                receipt={receipt}
                projectRoot={projectRoot}
                canPreview={Boolean(projectRoot && receipt.filePath)}
                onPreview={() => receipt.filePath && setPreviewPath(receipt.filePath)}
                presentation={presentation}
              />
            ))}
          </div>
          {remaining > 0 ? (
            <button
              type="button"
              className="assistant-activity-ledger__more"
              onClick={() => setVisibleCount((count) => count + DETAIL_PAGE_SIZE)}
              aria-label={`Show ${Math.min(DETAIL_PAGE_SIZE, remaining)} more activity receipts`}
            >
              Show {Math.min(DETAIL_PAGE_SIZE, remaining)} more
            </button>
          ) : null}
          {hasUsage && presentation === 'default' ? (
            <div className="assistant-activity-ledger__usage" aria-label="Usage">
              <UsageLine label="Input" usage={ledger.usage.input} />
              <UsageLine label="Output" usage={ledger.usage.output} />
            </div>
          ) : null}
          {previewPath && projectRoot ? (
            <FileAttachmentPreview
              path={previewPath}
              projectRoot={projectRoot}
              onClose={() => setPreviewPath(null)}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ReceiptRow({
  receipt,
  projectRoot,
  canPreview,
  onPreview,
  presentation,
}: {
  receipt: AssistantActivityReceipt;
  projectRoot?: string;
  canPreview: boolean;
  onPreview: () => void;
  presentation: AssistantActivityLedgerPresentation;
}) {
  const chronology = presentation === 'opencode-chronology';
  const content = (
    <>
      <span className="assistant-activity-ledger__receipt-icon">{receiptIcon(receipt)}</span>
      <span className="assistant-activity-ledger__receipt-label">
        {chronology ? chronologyReceiptText(receipt) : receipt.label}
      </span>
      {receipt.detail ? (
        <span className="assistant-activity-ledger__receipt-detail">{receipt.detail}</span>
      ) : null}
      {receipt.toolName ? (
        <span
          className="assistant-activity-ledger__receipt-detail"
          data-receipt-tool={receipt.toolName}
        >
          Tool: {receipt.toolName}
        </span>
      ) : null}
      {receipt.plugin ? (
        <span
          className="assistant-activity-ledger__receipt-detail"
          data-receipt-plugin={receipt.plugin}
        >
          Used plugin: {receipt.plugin}
        </span>
      ) : null}
      {receipt.mcpServer ? (
        <span
          className="assistant-activity-ledger__receipt-detail"
          data-receipt-mcp-server={receipt.mcpServer}
        >
          Used MCP server: {receipt.mcpServer}
        </span>
      ) : null}
      {receipt.callId ? (
        <span
          className="assistant-activity-ledger__receipt-detail"
          data-receipt-call-id={receipt.callId}
        >
          Call: {receipt.callId}
        </span>
      ) : null}
      {!chronology && receipt.fileLabel ? (
        <span className="assistant-activity-ledger__path">{receipt.fileLabel}</span>
      ) : null}
      {!chronology && receipt.durationMs !== undefined ? (
        <span className="assistant-activity-ledger__duration">
          <Clock3 aria-hidden="true" />
          {receipt.durationMs}ms
        </span>
      ) : null}
      {!chronology && receipt.status !== 'done' ? (
        <span className={cn('assistant-activity-ledger__status', `is-${receipt.status}`)}>
          {receipt.status}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      role="listitem"
      data-testid="activity-ledger-receipt"
      data-receipt-status={receipt.status}
      aria-label={chronology ? chronologyReceiptText(receipt) : undefined}
    >
      {canPreview ? (
        <button type="button" className="assistant-activity-ledger__receipt" onClick={onPreview}>
          {content}
        </button>
      ) : (
        <div className="assistant-activity-ledger__receipt">{content}</div>
      )}
      {receipt.toolDetails ? (
        <ToolDetailsInspector
          details={receipt.toolDetails}
          status={receipt.status}
          projectRoot={projectRoot}
        />
      ) : null}
    </div>
  );
}

function UsageLine({ label, usage }: { label: 'Input' | 'Output'; usage: LedgerUsageValue }) {
  if (usage.value === null) return <p>{label} usage unavailable</p>;
  return (
    <p>
      <strong>{label}</strong> {usage.provenance === 'estimated' ? '≈' : ''}
      {formatCount(usage.value)}
      <span>{usageTitle(usage)}</span>
    </p>
  );
}

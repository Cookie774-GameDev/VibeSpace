import * as React from 'react';
import type { ChatActivityEvent } from './types';
import './chat-list-activity.css';

export type ChatListActivityVisualState =
  'idle' | 'queued' | 'thinking' | 'streaming' | 'tool' | 'complete' | 'error' | 'cancelled';

export interface ChatListRunSignal {
  chatId?: string;
  status: string;
  updatedAt?: string | number;
  requiresManualRecovery?: boolean;
}

export interface ChatListActivityResolution {
  state: ChatListActivityVisualState;
  label: string;
  cycleMs: number;
  intensity: number;
  expiresAt?: number;
  terminalAt?: number;
}

const ERROR_SETTLE_MS = 3_200;
const CADENCE_WINDOW_MS = 4_000;
const ACTIVE_TOOL_KINDS = new Set<ChatActivityEvent['kind']>(['tool', 'file', 'diff', 'url']);
const QUEUED_STATUSES = new Set([
  'queued',
  'waiting',
  'waiting-for-approval',
  'waiting-for-input',
  'awaiting_approval',
  'blocked',
]);
const THINKING_STATUSES = new Set(['planning', 'thinking', 'preparing']);
const RUNNING_STATUSES = new Set(['running', 'streaming', 'in_progress']);
const COMPLETE_STATUSES = new Set(['completed', 'complete', 'done', 'succeeded']);
const ERROR_STATUSES = new Set(['failed', 'error', 'timed_out']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

function timestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function labelFor(state: ChatListActivityVisualState): string {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'thinking':
      return 'thinking';
    case 'streaming':
      return 'streaming output';
    case 'tool':
      return 'running a tool';
    case 'complete':
      return 'Reply ready';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'needs attention';
    default:
      return 'idle';
  }
}

function resolution(
  state: ChatListActivityVisualState,
  cycleMs: number,
  intensity: number,
  expiresAt?: number,
  terminalAt?: number,
): ChatListActivityResolution {
  return {
    state,
    label: labelFor(state),
    cycleMs,
    intensity,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
  };
}

export function resolveChatListActivity({
  runs,
  events,
  nowMs = Date.now(),
}: {
  runs: readonly ChatListRunSignal[];
  events: readonly ChatActivityEvent[];
  nowMs?: number;
}): ChatListActivityResolution {
  const orderedRuns = [...runs].sort(
    (left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt),
  );
  // A terminal run cannot stop the animation for another run still doing work.
  const latestRun =
    orderedRuns.find((run) => {
      const status = run.status.toLowerCase();
      return (
        !run.requiresManualRecovery &&
        (RUNNING_STATUSES.has(status) ||
          THINKING_STATUSES.has(status) ||
          QUEUED_STATUSES.has(status))
      );
    }) ?? orderedRuns[0];
  const status = latestRun?.status.toLowerCase() ?? '';
  const latestEvent = [...events].sort((left, right) => right.ts - left.ts)[0];
  const activeEvent = [...events]
    .reverse()
    .find((event) => event.status === 'pending' || event.status === 'running');

  if (ERROR_STATUSES.has(status) || CANCELLED_STATUSES.has(status)) {
    const changedAt = timestamp(latestRun?.updatedAt);
    if (changedAt > 0 && nowMs - changedAt <= ERROR_SETTLE_MS) {
      return resolution(
        CANCELLED_STATUSES.has(status) ? 'cancelled' : 'error',
        0,
        1,
        changedAt + ERROR_SETTLE_MS,
        changedAt,
      );
    }
    return resolution('idle', 0, 0);
  }

  if (COMPLETE_STATUSES.has(status)) {
    const changedAt = timestamp(latestRun?.updatedAt);
    return changedAt > 0
      ? resolution('complete', 2_800, 0.72, undefined, changedAt)
      : resolution('idle', 0, 0);
  }

  if (latestRun?.requiresManualRecovery) {
    return resolution('error', 0, 0.8);
  }

  if (activeEvent && ACTIVE_TOOL_KINDS.has(activeEvent.kind)) {
    return resolution('tool', 720, 0.82);
  }

  if (RUNNING_STATUSES.has(status) || activeEvent) {
    const recentCount = events.reduce(
      (count, event) => count + (nowMs - event.ts <= CADENCE_WINDOW_MS ? 1 : 0),
      0,
    );
    if (latestEvent && nowMs - latestEvent.ts <= CADENCE_WINDOW_MS) {
      const normalized = Math.min(1, Math.max(0.08, recentCount / 8));
      const cycleMs = Math.round(1_600 - normalized * 1_080);
      return resolution('streaming', Math.max(450, cycleMs), normalized);
    }
    return resolution('thinking', 1_100, 0.45);
  }

  if (THINKING_STATUSES.has(status)) return resolution('thinking', 1_100, 0.45);
  if (QUEUED_STATUSES.has(status)) return resolution('queued', 1_600, 0.28);

  if (
    (latestEvent?.status === 'error' || latestEvent?.status === 'cancelled') &&
    nowMs - latestEvent.ts <= ERROR_SETTLE_MS
  ) {
    return resolution(
      latestEvent.status === 'cancelled' ? 'cancelled' : 'error',
      0,
      1,
      latestEvent.ts + ERROR_SETTLE_MS,
      latestEvent.ts,
    );
  }
  // Only the top-level agent finishing can stand in for a missing run signal.
  if (latestEvent?.kind === 'agent' && latestEvent.status === 'done') {
    return resolution('complete', 2_800, 0.72, undefined, latestEvent.ts);
  }
  return resolution('idle', 0, 0);
}

export interface ChatListActivityIndicatorProps {
  chatId?: string;
  chatLabel?: string;
  acknowledgedThrough?: number;
  forceUnread?: boolean;
  runs: readonly ChatListRunSignal[];
  events: readonly ChatActivityEvent[];
  now?: () => number;
}

export function ChatListActivityIndicator({
  chatId,
  chatLabel = 'Chat',
  acknowledgedThrough = 0,
  forceUnread = false,
  runs,
  events,
  now = Date.now,
}: ChatListActivityIndicatorProps) {
  const [nowMs, setNowMs] = React.useState(now);
  const resolved = React.useMemo(() => {
    const result = resolveChatListActivity({
      runs: chatId ? runs.filter((run) => run.chatId === chatId) : runs,
      events: chatId ? events.filter((event) => String(event.chatId) === chatId) : events,
      nowMs,
    });
    if (forceUnread && result.state === 'idle') return resolution('complete', 2_800, 0.72);
    if (result.terminalAt && result.terminalAt <= acknowledgedThrough)
      return forceUnread ? resolution('complete', 2_800, 0.72) : resolution('idle', 0, 0);
    return result;
  }, [acknowledgedThrough, chatId, events, forceUnread, nowMs, runs]);

  React.useEffect(() => {
    setNowMs(now());
  }, [events, now, runs]);

  React.useEffect(() => {
    if (!resolved.expiresAt) return undefined;
    const delay = Math.max(0, resolved.expiresAt - now()) + 20;
    const timeout = window.setTimeout(() => setNowMs(now()), delay);
    return () => window.clearTimeout(timeout);
  }, [now, resolved.expiresAt]);

  const style = {
    '--chat-activity-cycle': `${resolved.cycleMs}ms`,
    '--chat-activity-intensity': String(resolved.intensity),
  } as React.CSSProperties;

  return (
    <>
      <span
        aria-hidden="true"
        className="chat-activity-slot"
        data-testid="chat-activity-slot"
        data-chat-activity-label={resolved.label}
        title={`${chatLabel}: ${resolved.label}`}
      >
        {resolved.state === 'idle' ? null : (
          <span
            className="chat-activity-indicator"
            data-chat-activity-indicator
            data-agent-motion="magnetic-matrix"
            data-state={resolved.state}
            style={style}
          >
            {resolved.state === 'complete' ? (
              <span
                aria-hidden="true"
                className="chat-activity-completion-dot"
                data-chat-activity-completion-dot
              />
            ) : resolved.state === 'error' || resolved.state === 'cancelled' ? (
              <span className="chat-activity-terminal" aria-hidden="true">
                {resolved.state === 'error' ? '!' : '−'}
              </span>
            ) : (
              Array.from({ length: 16 }, (_, index) => (
                <i
                  key={index}
                  data-chat-activity-cell
                  style={{ '--chat-activity-index': index } as React.CSSProperties}
                />
              ))
            )}
          </span>
        )}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {resolved.state === 'idle' ? '' : `${chatLabel}: ${resolved.label}`}
      </span>
    </>
  );
}

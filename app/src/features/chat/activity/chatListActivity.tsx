import * as React from 'react';
import type { ChatActivityEvent } from './types';
import './chat-list-activity.css';

export type ChatListActivityVisualState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'streaming'
  | 'tool'
  | 'complete'
  | 'error';

export interface ChatListRunSignal {
  chatId?: string;
  status: string;
  updatedAt?: string | number;
}

export interface ChatListActivityResolution {
  state: ChatListActivityVisualState;
  label: string;
  cycleMs: number;
  intensity: number;
  expiresAt?: number;
}

const SETTLE_MS = 3_200;
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
const ERROR_STATUSES = new Set(['failed', 'error', 'timed_out', 'cancelled']);

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
      return 'completed';
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
): ChatListActivityResolution {
  return {
    state,
    label: labelFor(state),
    cycleMs,
    intensity,
    ...(expiresAt === undefined ? {} : { expiresAt }),
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
  const latestRun = [...runs].sort(
    (left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt),
  )[0];
  const status = latestRun?.status.toLowerCase() ?? '';
  const latestEvent = [...events].sort((left, right) => right.ts - left.ts)[0];
  const activeEvent = [...events]
    .reverse()
    .find((event) => event.status === 'pending' || event.status === 'running');

  if (ERROR_STATUSES.has(status)) {
    const changedAt = timestamp(latestRun?.updatedAt);
    if (changedAt > 0 && nowMs - changedAt <= SETTLE_MS) {
      return resolution('error', 460, 1, changedAt + SETTLE_MS);
    }
    return resolution('idle', 0, 0);
  }

  if (COMPLETE_STATUSES.has(status)) {
    const changedAt = timestamp(latestRun?.updatedAt);
    if (changedAt > 0 && nowMs - changedAt <= SETTLE_MS) {
      return resolution('complete', 620, 0.72, changedAt + SETTLE_MS);
    }
    return resolution('idle', 0, 0);
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

  if (latestEvent?.status === 'error' && nowMs - latestEvent.ts <= SETTLE_MS) {
    return resolution('error', 460, 1, latestEvent.ts + SETTLE_MS);
  }
  if (latestEvent?.status === 'done' && nowMs - latestEvent.ts <= SETTLE_MS) {
    return resolution('complete', 620, 0.72, latestEvent.ts + SETTLE_MS);
  }
  return resolution('idle', 0, 0);
}

export interface ChatListActivityIndicatorProps {
  runs: readonly ChatListRunSignal[];
  events: readonly ChatActivityEvent[];
  now?: () => number;
}

export function ChatListActivityIndicator({
  runs,
  events,
  now = Date.now,
}: ChatListActivityIndicatorProps) {
  const [nowMs, setNowMs] = React.useState(now);
  const resolved = React.useMemo(
    () => resolveChatListActivity({ runs, events, nowMs }),
    [events, nowMs, runs],
  );

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
      >
        {resolved.state === 'idle' ? null : (
          <span
            className="chat-activity-indicator"
            data-chat-activity-indicator
            data-agent-motion="magnetic-matrix"
            data-state={resolved.state}
            style={style}
          >
            {Array.from({ length: 16 }, (_, index) => (
              <i
                key={index}
                data-chat-activity-cell
                style={{ '--chat-activity-index': index } as React.CSSProperties}
              />
            ))}
          </span>
        )}
      </span>
      {resolved.state === 'idle' ? null : (
        <span className="sr-only">Chat activity: {resolved.label}</span>
      )}
    </>
  );
}

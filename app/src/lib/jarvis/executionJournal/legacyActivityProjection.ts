import type {
  ChatActivityCategory,
  ChatActivityEvent,
  ChatActivityKind,
  ChatActivityStatus,
} from '@/features/chat/activity/types';
import type { JarvisEvent, JarvisRun } from '@/lib/jarvis/contracts/execution';

const MAX_PROJECTION_ITEMS = 500;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_PROJECTION_ITEMS;
  return Math.max(1, Math.min(MAX_PROJECTION_ITEMS, Math.trunc(value)));
}

function activityKind(type: JarvisEvent['type']): ChatActivityKind {
  switch (type) {
    case 'artifact':
      return 'file';
    case 'retrieval':
      return 'url';
    case 'tool':
    case 'terminal':
    case 'approval':
    case 'warning':
    case 'error':
      return 'tool';
    default:
      return 'agent';
  }
}

function activityCategory(type: JarvisEvent['type']): ChatActivityCategory {
  switch (type) {
    case 'artifact':
      return 'file';
    case 'retrieval':
      return 'file';
    case 'tool':
    case 'terminal':
    case 'approval':
    case 'warning':
    case 'error':
      return 'thinking';
    case 'message':
      return 'response';
    case 'context':
      return 'context';
    case 'run_state':
    case 'model':
      return 'thinking';
  }
}

function activityTitle(type: JarvisEvent['type']): string {
  switch (type) {
    case 'run_state':
      return 'Jarvis status';
    case 'model':
      return 'Jarvis model activity';
    case 'context':
      return 'Jarvis context activity';
    case 'retrieval':
      return 'Jarvis retrieval activity';
    case 'tool':
      return 'Jarvis tool activity';
    case 'terminal':
      return 'Jarvis terminal activity';
    case 'approval':
      return 'Jarvis approval activity';
    case 'artifact':
      return 'Jarvis artifact activity';
    case 'message':
      return 'Jarvis message activity';
    case 'warning':
      return 'Jarvis warning';
    case 'error':
      return 'Jarvis error';
  }
}

function activityStatus(event: JarvisEvent, run: JarvisRun): ChatActivityStatus {
  if (event.type === 'error') return 'error';
  const status = event.status ?? run.status;
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'timed_out') return 'error';
  if (status === 'queued' || status === 'compiling') return 'pending';
  if (status === 'running' || status === 'awaiting_approval') return 'running';
  return 'done';
}

function internalKey(run: JarvisRun, event: JarvisEvent): string {
  const sources = event.sourceRefs
    .filter((source) => source.accountId === run.accountId)
    .map((source) => `source:${source.id}`)
    .sort();
  const artifacts = event.artifactIds.map((id) => `artifact:${id}`).sort();
  return [`run:${run.id}`, `event:${event.seq}`, ...sources, ...artifacts].join('|');
}

export function projectJarvisEventsForLegacyActivity(input: {
  run: JarvisRun;
  events: readonly JarvisEvent[];
  limit?: number;
}): readonly ChatActivityEvent[] {
  const limit = clampLimit(input.limit);
  const chatId = input.run.chatId ?? `jarvis-run:${input.run.id}`;
  const events = input.events
    .filter((event) => event.runId === input.run.id)
    .sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt)
    .slice(-limit)
    .map((event) =>
      Object.freeze({
        id: internalKey(input.run, event),
        chatId,
        kind: activityKind(event.type),
        category: activityCategory(event.type),
        status: activityStatus(event, input.run),
        title: activityTitle(event.type),
        ...(event.safeSummary?.trim() ? { detail: event.safeSummary.trim() } : {}),
        ts: event.createdAt,
        ...(event.status === 'running' ? { startedAt: event.createdAt } : {}),
        ...(['completed', 'partial', 'failed', 'timed_out', 'cancelled'].includes(
          event.status ?? '',
        )
          ? { endedAt: event.createdAt }
          : {}),
      }),
    );
  return Object.freeze(events);
}

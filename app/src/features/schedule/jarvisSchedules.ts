import type { EventCreateInput } from '@/lib/db/repositories';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import type { EventRow } from '@/types/event';
import type { AgentId, WorkspaceId } from '@/types/common';

export type JarvisScheduleRecurrence =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'weekdays'
  | 'custom_interval'
  | 'custom_days';

export type JarvisScheduleRunHistoryStatus =
  | 'dispatched'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface JarvisScheduleRunHistoryEntryV1 {
  schemaVersion: 1;
  at: number;
  runId: string;
  requestId: string;
  status: JarvisScheduleRunHistoryStatus;
  summary?: string;
}

export interface JarvisScheduleLegacyRunHistoryEntry {
  schemaVersion: 0;
  at: number;
  status: 'success' | 'error';
  summary?: string;
}

export type JarvisScheduleRunHistoryEntry =
  | JarvisScheduleRunHistoryEntryV1
  | JarvisScheduleLegacyRunHistoryEntry;

export interface JarvisScheduleMetadata {
  kind: 'jarvis_schedule';
  prompt: string;
  recurrence: JarvisScheduleRecurrence;
  /**
   * For `custom_interval` only: fixed spacing between runs in milliseconds
   * (e.g. 2 hours = 7_200_000). Ignored for other recurrence kinds.
   */
  intervalMs?: number;
  modelSelection: ChatModelSelection;
  agentId: AgentId | string;
  createdBy: 'jarvis' | 'user';
  lastRunAt?: number;
  nextRunAt?: number;
  /** Dedicated chat that collects this action's outputs. Created on first run. */
  outputChatId?: string;
  runHistory: JarvisScheduleRunHistoryEntry[];
  errorHistory: Array<{ at: number; error: string }>;
}

/** Minimum custom interval (5 minutes) so rapid loops cannot thrash the runner. */
export const JARVIS_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Maximum custom interval (~30 days). */
export const JARVIS_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeJarvisIntervalMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < JARVIS_MIN_INTERVAL_MS || rounded > JARVIS_MAX_INTERVAL_MS) return undefined;
  return rounded;
}

export function intervalMsFromParts(
  amount: number,
  unit: 'minutes' | 'hours' | 'days',
): number | undefined {
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const mult = unit === 'minutes' ? 60_000 : unit === 'hours' ? 3_600_000 : 86_400_000;
  return normalizeJarvisIntervalMs(amount * mult);
}

export function formatJarvisIntervalLabel(intervalMs: number | undefined): string {
  if (!intervalMs) return 'Every interval';
  const minutes = Math.round(intervalMs / 60_000);
  if (minutes < 60) return `Every ${minutes} min`;
  const hours = Math.round(intervalMs / 3_600_000);
  if (hours < 48 && intervalMs % 3_600_000 === 0) return `Every ${hours} hr`;
  const days = Math.round(intervalMs / 86_400_000);
  if (intervalMs % 86_400_000 === 0) return `Every ${days} day${days === 1 ? '' : 's'}`;
  return `Every ${minutes} min`;
}

/**
 * Persist updated Jarvis schedule metadata back onto an event row while
 * preserving the rest of the source_ref payload. History arrays are capped so
 * long-lived recurring actions cannot grow the row without bound.
 */
export const JARVIS_SCHEDULE_HISTORY_CAP = 20;

export function withJarvisScheduleMetadata(
  event: EventRow,
  metadata: JarvisScheduleMetadata,
): Partial<EventRow> {
  const bounded: JarvisScheduleMetadata = {
    ...metadata,
    runHistory: metadata.runHistory.slice(-JARVIS_SCHEDULE_HISTORY_CAP),
    errorHistory: metadata.errorHistory.slice(-JARVIS_SCHEDULE_HISTORY_CAP),
  };
  return {
    source_ref: {
      ...event.source_ref,
      context: {
        kind: event.source_ref?.context?.kind ?? 'memory',
        ...event.source_ref?.context,
        id: serializeJarvisScheduleMetadata(bounded),
      },
    },
  };
}

export function serializeJarvisScheduleMetadata(metadata: JarvisScheduleMetadata): string {
  return `jarvis_schedule:${JSON.stringify({
    ...metadata,
    runHistory: metadata.runHistory.map((entry) => {
      if (entry.schemaVersion === 1) return entry;
      const { schemaVersion: _schemaVersion, ...legacy } = entry;
      return legacy;
    }),
  })}`;
}

function normalizeRunHistory(value: unknown): JarvisScheduleRunHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): JarvisScheduleRunHistoryEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (!Number.isFinite(record.at)) return [];
    const summary = typeof record.summary === 'string' ? record.summary : undefined;
    if (
      record.schemaVersion === 1 &&
      typeof record.runId === 'string' &&
      record.runId.length > 0 &&
      typeof record.requestId === 'string' &&
      record.requestId.length > 0 &&
      ['dispatched', 'completed', 'partial', 'failed', 'cancelled', 'timed_out'].includes(
        String(record.status),
      )
    ) {
      return [
        {
          schemaVersion: 1,
          at: record.at as number,
          runId: record.runId,
          requestId: record.requestId,
          status: record.status as JarvisScheduleRunHistoryStatus,
          ...(summary === undefined ? {} : { summary }),
        },
      ];
    }
    if (
      (record.schemaVersion === undefined || record.schemaVersion === 0) &&
      (record.status === 'success' || record.status === 'error')
    ) {
      return [
        {
          schemaVersion: 0,
          at: record.at as number,
          status: record.status,
          ...(summary === undefined ? {} : { summary }),
        },
      ];
    }
    return [];
  });
}

export function parseJarvisScheduleMetadata(event: EventRow): JarvisScheduleMetadata | null {
  const raw = event.source_ref?.context?.id;
  if (!raw?.startsWith('jarvis_schedule:')) return null;
  try {
    const parsed = JSON.parse(raw.slice('jarvis_schedule:'.length)) as JarvisScheduleMetadata;
    if (parsed?.kind !== 'jarvis_schedule') return null;
    const intervalMs = normalizeJarvisIntervalMs(parsed.intervalMs);
    return {
      ...parsed,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      runHistory: normalizeRunHistory(parsed.runHistory).slice(-JARVIS_SCHEDULE_HISTORY_CAP),
      errorHistory: Array.isArray(parsed.errorHistory)
        ? parsed.errorHistory.slice(-JARVIS_SCHEDULE_HISTORY_CAP)
        : [],
    };
  } catch {
    return null;
  }
}

export function isJarvisScheduleEvent(event: EventRow): boolean {
  return (
    event.source === 'ai' &&
    (Boolean(parseJarvisScheduleMetadata(event)) ||
      Boolean(event.source_ref?.context?.id?.startsWith('jarvis_schedule:')))
  );
}

export function recurrenceToRule(recurrence: JarvisScheduleRecurrence): string | undefined {
  if (recurrence === 'once') return undefined;
  if (recurrence === 'custom_interval') return 'custom_interval';
  if (recurrence === 'custom_days') return 'custom_days';
  return recurrence;
}

export function buildJarvisScheduleEventInput(input: {
  workspaceId: WorkspaceId;
  createdBy: string;
  title: string;
  prompt: string;
  startAt: number;
  durationMs?: number;
  recurrence: JarvisScheduleRecurrence;
  /** Required when recurrence is `custom_interval`. */
  intervalMs?: number;
  timezone: string;
  modelSelection: ChatModelSelection;
  agentId: AgentId | string;
  projectId?: string;
}): EventCreateInput {
  const cleanTitle = input.title.trim() || 'Jarvis task';
  const intervalMs =
    input.recurrence === 'custom_interval'
      ? normalizeJarvisIntervalMs(input.intervalMs)
      : undefined;
  const metadata: JarvisScheduleMetadata = {
    kind: 'jarvis_schedule',
    prompt: input.prompt.trim(),
    recurrence: input.recurrence,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    modelSelection: input.modelSelection,
    agentId: input.agentId,
    createdBy:
      input.createdBy.startsWith('agt_') || input.createdBy.includes('jarvis') ? 'jarvis' : 'user',
    nextRunAt: input.startAt,
    runHistory: [],
    errorHistory: [],
  };
  return {
    workspace_id: input.workspaceId,
    ...(input.projectId ? { project_id: input.projectId as never } : {}),
    title: `Jarvis Scheduled — ${cleanTitle}`,
    description: input.prompt.trim(),
    start_at: input.startAt,
    end_at: input.startAt + (input.durationMs ?? 30 * 60 * 1000),
    all_day: false,
    timezone: input.timezone,
    source: 'ai',
    source_ref: {
      context: {
        kind: 'memory',
        id: serializeJarvisScheduleMetadata(metadata),
        excerpt: input.prompt.trim(),
      },
    },
    recurrence_rule: recurrenceToRule(input.recurrence),
    reminders: [],
    status: 'scheduled',
    color_hue: 265,
    created_by: input.createdBy,
  };
}

export function findScheduleConflicts(
  events: EventRow[],
  startAt: number,
  endAt: number,
): EventRow[] {
  return events.filter(
    (event) => event.status !== 'cancelled' && event.start_at < endAt && event.end_at > startAt,
  );
}

export function scheduleActionSummary(
  action: 'created' | 'paused' | 'resumed' | 'deleted',
  event: Pick<EventRow, 'title'>,
): string {
  const verb =
    action === 'created'
      ? 'Created'
      : action === 'paused'
        ? 'Paused'
        : action === 'resumed'
          ? 'Resumed'
          : 'Deleted';
  return `${verb} ${event.title}.`;
}

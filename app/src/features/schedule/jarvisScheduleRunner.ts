/**
 * Polls persisted schedules and hands each concrete occurrence to the closed
 * scheduled-kernel dispatcher. The runner owns polling and schedule metadata;
 * the runtime owns canonical run/model/identity/profile selection and effects.
 */
import { chatRepo as realChatRepo, eventRepo as realEventRepo } from '@/lib/db/repositories';
import { dispatchScheduledJarvisOccurrenceWithKernel } from '@/lib/ai/runtime';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import type { JarvisRunStatus } from '@/lib/jarvis/contracts/execution';
import { newChatId } from '@/lib/ids';
import { useAuthStore } from '@/stores/auth';
import type { EventRow } from '@/types/event';
import type { ChatId, WorkspaceId } from '@/types/common';
import type { ScheduledJarvisAttemptResult } from './jarvisScheduleDispatch';
import { expandRecurrence } from './recurrence';
import {
  isJarvisScheduleEvent,
  parseJarvisScheduleMetadata,
  withJarvisScheduleMetadata,
  type JarvisScheduleMetadata,
  type JarvisScheduleRunHistoryEntryV1,
  type JarvisScheduleRunHistoryStatus,
} from './jarvisSchedules';
import { formatUserDateTime } from '@/lib/timeFormat';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Missed occurrences older than this are logged and skipped, not replayed. */
export const JARVIS_SCHEDULE_CATCH_UP_MS = 6 * 60 * 60 * 1000;

/** How often the runner re-checks for due actions while the app is open. */
export const JARVIS_SCHEDULE_POLL_MS = 30_000;

export interface JarvisScheduleRunnerDeps {
  listEvents: (workspaceId: WorkspaceId) => Promise<EventRow[]>;
  updateEvent: (id: EventRow['id'], patch: Partial<EventRow>) => Promise<unknown>;
  createChat: (input: {
    id: ChatId;
    workspace_id: WorkspaceId;
    project_id?: EventRow['project_id'];
    title: string;
    mode: 'chat';
    active_agent_ids: never[];
  }) => Promise<unknown>;
  dispatchScheduledOccurrence: (input: {
    accountId: string;
    eventId: string;
    dueAt: number;
  }) => Promise<ScheduledJarvisAttemptResult>;
  now: () => number;
}

function defaultDeps(): JarvisScheduleRunnerDeps {
  return {
    listEvents: (workspaceId) => realEventRepo.list({ workspace_id: workspaceId }),
    updateEvent: (id, patch) => realEventRepo.update(id, patch),
    createChat: (input) => realChatRepo.create(input),
    dispatchScheduledOccurrence: dispatchScheduledJarvisOccurrenceWithKernel,
    now: () => Date.now(),
  };
}

/**
 * Next occurrence strictly after `afterMs`, using the same expansion engine
 * as the timeline so the runner and UI agree. Custom intervals use metadata.
 */
export function computeNextJarvisRunAt(event: EventRow, afterMs: number): number | null {
  const metadata = parseJarvisScheduleMetadata(event);
  if (metadata?.recurrence === 'once') return null;

  if (
    metadata?.recurrence === 'custom_interval' &&
    typeof metadata.intervalMs === 'number' &&
    metadata.intervalMs > 0
  ) {
    const interval = metadata.intervalMs;
    let next = event.start_at;
    // Advance from the original anchor so drift does not accumulate.
    let guard = 0;
    while (next <= afterMs && guard < 100_000) {
      next += interval;
      guard += 1;
    }
    return next > afterMs ? next : null;
  }

  const horizon = afterMs + 62 * DAY_MS;
  const instances = expandRecurrence(event, afterMs + 1, horizon);
  const next = instances.find((instance) => instance.instanceStartMs > afterMs);
  return next ? next.instanceStartMs : null;
}

export interface JarvisScheduleRunResult {
  ran: string[];
  missed: string[];
  checked: number;
}

export type JarvisScheduleRunnerStage =
  | 'claimed'
  | 'output_chat'
  | 'kernel_dispatch'
  | 'settling'
  | 'completed'
  | 'failed';

export interface JarvisScheduleRunnerOptions {
  onStage?: (stage: JarvisScheduleRunnerStage) => void;
}

/** In-memory claim of account-scoped concrete occurrences. */
const claimedRuns = new Set<string>();

function claimRun(key: string): boolean {
  if (claimedRuns.has(key)) return false;
  claimedRuns.add(key);
  return true;
}

function releaseRun(key: string): void {
  claimedRuns.delete(key);
}

function pruneSettledClaims(accountId: string, events: readonly EventRow[], now: number): void {
  const stillDue = new Set<string>();
  const accountPrefix = `${accountId}:`;
  for (const event of events) {
    if (event.status !== 'scheduled' || !isJarvisScheduleEvent(event)) continue;
    const metadata = parseJarvisScheduleMetadata(event);
    if (!metadata?.prompt.trim()) continue;
    const dueAt = metadata.nextRunAt ?? event.start_at;
    if (dueAt <= now) stillDue.add(`${accountId}:${event.id}:${dueAt}`);
  }
  for (const key of claimedRuns) {
    if (key.startsWith(accountPrefix) && !stillDue.has(key)) claimedRuns.delete(key);
  }
}

function outputChatTitle(event: EventRow): string {
  const title = event.title.replace(/^Jarvis Scheduled\s+—\s+/, '').trim() || 'Jarvis task';
  return `Jarvis Action — ${title}`.slice(0, 96);
}

async function ensureOutputChat(
  event: EventRow,
  metadata: JarvisScheduleMetadata,
  deps: JarvisScheduleRunnerDeps,
): Promise<JarvisScheduleMetadata> {
  if (metadata.outputChatId) return metadata;
  const chatId = newChatId();
  await deps.createChat({
    id: chatId,
    workspace_id: event.workspace_id,
    project_id: event.project_id,
    title: outputChatTitle(event),
    mode: 'chat',
    active_agent_ids: [],
  });
  const withOutputChat: JarvisScheduleMetadata = {
    ...metadata,
    outputChatId: String(chatId),
  };
  // Persist only output routing. The concrete due occurrence remains unchanged
  // until the canonical dispatcher has claimed the exact dueAt.
  await deps.updateEvent(event.id, withJarvisScheduleMetadata(event, withOutputChat));
  return withOutputChat;
}

function requiredCanonicalId(value: string, label: 'runId' | 'requestId'): string {
  if (!value.trim()) throw new Error(`Scheduled dispatch returned an empty ${label}.`);
  return value;
}

function historyStatusFromRunStatus(status: JarvisRunStatus): JarvisScheduleRunHistoryStatus {
  switch (status) {
    case 'queued':
    case 'compiling':
    case 'running':
    case 'awaiting_approval':
      return 'dispatched';
    case 'partial':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'timed_out':
      return status;
  }
}

function latestRequestId(
  result: Extract<ScheduledJarvisAttemptResult, { kind: 'terminal_transport_failure' }>,
): string {
  const latest = result.run.transportAttempts?.reduce((current, attempt) =>
    !current || attempt.attemptNumber > current.attemptNumber ? attempt : current,
  );
  if (!latest) throw new Error('Terminal scheduled transport failure has no canonical attempt.');
  return requiredCanonicalId(latest.requestId, 'requestId');
}

function terminalHistoryStatus(status: JarvisRunStatus): JarvisScheduleRunHistoryStatus {
  switch (status) {
    case 'partial':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'timed_out':
      return status;
    case 'queued':
    case 'compiling':
    case 'running':
    case 'awaiting_approval':
      throw new Error(
        `Terminal scheduled transport failure returned nonterminal status ${status}.`,
      );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduled dispatch outcome: ${String(value)}`);
}

function historyEntryForOutcome(
  outcome: Exclude<ScheduledJarvisAttemptResult, { kind: 'account_authority_revoked' }>,
  at: number,
): JarvisScheduleRunHistoryEntryV1 {
  switch (outcome.kind) {
    case 'committed': {
      const response = outcome.result.response;
      return {
        schemaVersion: 1,
        at,
        runId: requiredCanonicalId(response.runId, 'runId'),
        requestId: requiredCanonicalId(response.requestId, 'requestId'),
        status: historyStatusFromRunStatus(response.executionState?.status ?? 'completed'),
      };
    }
    case 'transport_retry_available':
      return {
        schemaVersion: 1,
        at,
        runId: requiredCanonicalId(outcome.run.id, 'runId'),
        requestId: requiredCanonicalId(outcome.attempt.requestId, 'requestId'),
        status: 'dispatched',
        summary: 'Transport retry available.',
      };
    case 'terminal_transport_failure':
      return {
        schemaVersion: 1,
        at,
        runId: requiredCanonicalId(outcome.run.id, 'runId'),
        requestId: latestRequestId(outcome),
        status: terminalHistoryStatus(outcome.run.status),
        summary: 'Terminal transport failure.',
      };
    default:
      return assertNever(outcome);
  }
}

async function recordRetryableRunnerFailure(
  event: EventRow,
  metadata: JarvisScheduleMetadata,
  dueAt: number,
  now: number,
  error: string,
  deps: JarvisScheduleRunnerDeps,
): Promise<void> {
  const failedMetadata: JarvisScheduleMetadata = {
    ...metadata,
    nextRunAt: dueAt,
    errorHistory: [...metadata.errorHistory, { at: now, error }],
  };
  try {
    await deps.updateEvent(event.id, {
      ...withJarvisScheduleMetadata(event, failedMetadata),
      status: 'scheduled',
    });
  } catch {
    // A failed event store cannot safely persist more runner state.
  }
}

/**
 * Check every schedule in the workspace and dispatch due concrete occurrences.
 * The account identity is start-bound by the caller; no active UI route,
 * selected model, or mutable message event participates in dispatch.
 */
export async function runDueJarvisSchedules(
  accountId: string,
  workspaceId: WorkspaceId,
  deps: JarvisScheduleRunnerDeps = defaultDeps(),
  options: JarvisScheduleRunnerOptions = {},
): Promise<JarvisScheduleRunResult> {
  const result: JarvisScheduleRunResult = { ran: [], missed: [], checked: 0 };
  const now = deps.now();
  let events: EventRow[];
  try {
    events = await deps.listEvents(workspaceId);
  } catch {
    return result;
  }
  pruneSettledClaims(accountId, events, now);

  for (const event of events) {
    if (event.status !== 'scheduled' || !isJarvisScheduleEvent(event)) continue;
    const parsedMetadata = parseJarvisScheduleMetadata(event);
    if (!parsedMetadata?.prompt.trim()) continue;
    result.checked += 1;

    const dueAt = parsedMetadata.nextRunAt ?? event.start_at;
    if (dueAt > now) continue;
    const claimKey = `${accountId}:${event.id}:${dueAt}`;
    if (!claimRun(claimKey)) continue;
    options.onStage?.('claimed');

    const nextRunAt = computeNextJarvisRunAt(event, Math.max(dueAt, now));
    if (now - dueAt > JARVIS_SCHEDULE_CATCH_UP_MS) {
      const missedMetadata: JarvisScheduleMetadata = {
        ...parsedMetadata,
        nextRunAt: nextRunAt ?? undefined,
        errorHistory: [
          ...parsedMetadata.errorHistory,
          {
            at: now,
            error: `Missed scheduled run at ${formatUserDateTime(dueAt)} (app was closed).`,
          },
        ],
      };
      try {
        await deps.updateEvent(event.id, {
          ...withJarvisScheduleMetadata(event, missedMetadata),
          ...(nextRunAt === null ? { status: 'done' as const } : {}),
        });
      } catch {
        // Keep the claim: a failed persistence must not create a retry storm.
      }
      result.missed.push(String(event.id));
      continue;
    }

    let dispatchMetadata = parsedMetadata;
    try {
      options.onStage?.('output_chat');
      dispatchMetadata = await ensureOutputChat(event, parsedMetadata, deps);
      options.onStage?.('kernel_dispatch');
      const outcome = await deps.dispatchScheduledOccurrence({
        accountId,
        eventId: String(event.id),
        dueAt,
      });
      if (outcome.kind === 'account_authority_revoked') {
        await recordRetryableRunnerFailure(
          event,
          dispatchMetadata,
          dueAt,
          now,
          'Scheduled dispatch account authority was revoked.',
          deps,
        );
        releaseRun(claimKey);
        continue;
      }

      const runHistoryEntry = historyEntryForOutcome(outcome, now);
      options.onStage?.('settling');
      const ranMetadata: JarvisScheduleMetadata = {
        ...dispatchMetadata,
        lastRunAt: now,
        nextRunAt: nextRunAt ?? undefined,
        runHistory: [...dispatchMetadata.runHistory, runHistoryEntry],
      };
      // The dispatcher has now claimed the exact dueAt, so this occurrence can
      // advance. Retryable transport failures require the explicit retry port;
      // an ordinary poll must never redispatch them.
      await deps.updateEvent(event.id, {
        ...withJarvisScheduleMetadata(event, ranMetadata),
        ...(nextRunAt === null ? { status: 'done' as const } : {}),
      });
      result.ran.push(String(event.id));
      options.onStage?.('completed');
    } catch (error) {
      options.onStage?.('failed');
      await recordRetryableRunnerFailure(
        event,
        dispatchMetadata,
        dueAt,
        now,
        error instanceof Error ? error.message : 'Jarvis Action failed to start.',
        deps,
      );
      releaseRun(claimKey);
    }
  }

  return result;
}

/**
 * Start the polling loop. Also re-checks on focus so sleep-time occurrences
 * are handled promptly. Account and workspace must both be boot-ready.
 */
export function startJarvisScheduleRunner(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const workspaceId = useAuthStore.getState().workspaceId;
      const account = getActiveAccountIdentity();
      if (workspaceId && account) {
        await runDueJarvisSchedules(account.accountId, workspaceId as WorkspaceId);
      }
    } catch (error) {
      console.warn('[jarvis schedule] due-check failed', error);
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), JARVIS_SCHEDULE_POLL_MS);
  const onFocus = () => void tick();
  window.addEventListener('focus', onFocus);
  void tick();
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onFocus);
  };
}

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { JarvisRun, JarvisTransportAttemptV1 } from '@/lib/jarvis/contracts/execution';
import type { JarvisKernelTurnResult } from '@/lib/jarvis/kernel';
import type { EventRow } from '@/types/event';
import type { WorkspaceId } from '@/types/common';
import type { ScheduledJarvisAttemptResult } from './jarvisScheduleDispatch';
import type { ChatSupervisionOccurrenceReceipt } from './jarvisScheduleDispatch';
import type { ChatSupervisionBindingV1 } from './chatSupervision';
import {
  buildJarvisScheduleEventInput,
  parseJarvisScheduleMetadata,
  withJarvisScheduleMetadata,
  JARVIS_SCHEDULE_HISTORY_CAP,
  type JarvisScheduleMetadata,
  type JarvisScheduleRunHistoryStatus,
} from './jarvisSchedules';
import {
  computeNextJarvisRunAt,
  runDueJarvisSchedules,
  JARVIS_SCHEDULE_CATCH_UP_MS,
  type JarvisScheduleRunnerDeps,
} from './jarvisScheduleRunner';

const ACCOUNT = 'acct_schedule_runner';
const WORKSPACE = 'wks_test' as WorkspaceId;
const BASE_NOW = new Date(2026, 6, 8, 8, 0, 0, 0).getTime();

const chatSupervision: ChatSupervisionBindingV1 = {
  version: 1,
  sourceChatId: 'chat-source',
  supervisingChatId: 'chat-supervisor',
  originatingMessageId: 'message-origin',
  originatingCardMessageId: 'message-card',
  handoffPolicyVersion: 1,
  instruction: 'Review current progress and identify blockers.',
  allowReplyToSource: false,
};

let eventSeq = 0;

function buildEvent(overrides: {
  startAt: number;
  recurrence?: 'once' | 'daily' | 'weekly' | 'monthly' | 'weekdays';
  prompt?: string;
  status?: EventRow['status'];
  projectId?: string;
  metadataPatch?: Partial<JarvisScheduleMetadata>;
}): EventRow {
  const input = buildJarvisScheduleEventInput({
    workspaceId: WORKSPACE,
    ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
    createdBy: 'usr_local',
    title: 'Football news',
    prompt: overrides.prompt ?? 'Give me the top football headlines.',
    startAt: overrides.startAt,
    recurrence: overrides.recurrence ?? 'once',
    timezone: 'UTC',
    modelSelection: { mode: 'single', provider: 'google', modelId: 'gemini-2.0-flash' } as never,
    agentId: 'agent_jarvis',
  });
  const event: EventRow = {
    id: `evt_${overrides.startAt}_${eventSeq++}` as EventRow['id'],
    attendees: [],
    created_at: overrides.startAt - 1000,
    updated_at: overrides.startAt - 1000,
    ...input,
    status: overrides.status ?? 'scheduled',
  } as EventRow;
  if (overrides.metadataPatch) {
    const metadata = parseJarvisScheduleMetadata(event)!;
    Object.assign(
      event,
      withJarvisScheduleMetadata(event, { ...metadata, ...overrides.metadataPatch }),
    );
  }
  return event;
}

function committed(
  runId: string,
  requestId: string,
  status: 'awaiting_approval' | 'partial' | 'completed' | 'failed' | 'cancelled' | 'timed_out',
): ScheduledJarvisAttemptResult {
  return {
    kind: 'committed',
    result: {
      response: {
        runId,
        requestId,
        executionState: { status },
        completedAt: BASE_NOW,
      },
    } as JarvisKernelTurnResult,
  };
}

function buildRun(id: string, status: JarvisRun['status'], requestId: string): JarvisRun {
  return {
    id,
    accountId: ACCOUNT,
    source: 'schedule',
    status,
    agentId: 'agent_jarvis',
    identityVersion: 1,
    profileRevisionId: 'jprf_schedule',
    model: {} as JarvisRun['model'],
    createdAt: BASE_NOW - 1000,
    updatedAt: BASE_NOW,
    transportAttempts: [
      {
        schemaVersion: 1,
        attemptNumber: 1,
        kind: 'initial',
        requestId,
        state: status === 'running' ? 'retryable_failed' : 'effect_uncertain',
        startedEventSeq: 1,
        effectBarrier: { state: 'open', version: 0, updatedAt: BASE_NOW },
        createdAt: BASE_NOW - 1000,
        updatedAt: BASE_NOW,
      },
    ],
  };
}

function buildDeps(
  events: EventRow[],
  outcomes: ScheduledJarvisAttemptResult[] = [
    committed('jrun_default', 'jreq_default', 'completed'),
  ],
) {
  const updates: Array<{ id: string; patch: Partial<EventRow> }> = [];
  const chats: Array<{ id: string; title: string }> = [];
  const dispatches: Array<{ accountId: string; eventId: string; dueAt: number }> = [];
  const supervisionRuns: Array<{
    scheduleId: string;
    occurrenceId: string;
    binding: ChatSupervisionBindingV1;
    previousReceipt?: JarvisScheduleMetadata['runHistory'][number];
  }> = [];
  let outcomeIndex = 0;
  const deps: JarvisScheduleRunnerDeps = {
    listEvents: async () => events,
    updateEvent: async (id, patch) => {
      updates.push({ id: String(id), patch });
      const target = events.find((event) => event.id === id);
      if (target) Object.assign(target, patch);
    },
    createChat: async (input) => {
      chats.push({ id: String(input.id), title: input.title });
    },
    dispatchScheduledOccurrence: async (input) => {
      dispatches.push(input);
      return outcomes[Math.min(outcomeIndex++, outcomes.length - 1)]!;
    },
    runChatSupervisionOccurrence: vi.fn(async (input) => {
      supervisionRuns.push(input);
      return {
        scheduleId: input.scheduleId,
        occurrenceId: input.occurrenceId,
        dispatchKey: `${input.scheduleId}:${input.occurrenceId}`,
        status: 'dispatched',
        targetChatId: input.binding.supervisingChatId,
        messageId: `message-${input.occurrenceId}`,
        replyToSourceAllowed: input.binding.allowReplyToSource,
        startedAt: BASE_NOW - 10,
        completedAt: BASE_NOW,
      } satisfies ChatSupervisionOccurrenceReceipt;
    }),
    recoverCaoScheduledLearning: vi.fn(async () => null),
    runCaoScheduledLearning: vi.fn(async () => ({ status: 'completed' as const })),
    now: () => BASE_NOW,
  };
  return { deps, updates, chats, dispatches, supervisionRuns };
}

describe('computeNextJarvisRunAt', () => {
  it('returns null for one-shot actions', () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'once' });
    expect(computeNextJarvisRunAt(event, BASE_NOW)).toBeNull();
  });

  it('returns the next daily occurrence after the given time', () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'daily' });
    expect(computeNextJarvisRunAt(event, BASE_NOW)).toBe(event.start_at + 24 * 60 * 60 * 1000);
  });

  it('skips weekends for weekday recurrence', () => {
    const friday = new Date(2026, 6, 10, 9, 0, 0, 0).getTime();
    const event = buildEvent({ startAt: friday, recurrence: 'weekdays' });
    const next = computeNextJarvisRunAt(event, friday);
    expect(new Date(next!).getDay()).toBe(1);
    expect(next).toBe(friday + 3 * 24 * 60 * 60 * 1000);
  });

  it('returns the next weekly and monthly occurrences', () => {
    const weekly = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'weekly' });
    expect(computeNextJarvisRunAt(weekly, BASE_NOW)).toBe(
      weekly.start_at + 7 * 24 * 60 * 60 * 1000,
    );

    const monthly = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'monthly' });
    const next = computeNextJarvisRunAt(monthly, BASE_NOW);
    expect(new Date(next!).getMonth()).toBe((new Date(monthly.start_at).getMonth() + 1) % 12);
  });
});

describe('runDueJarvisSchedules', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches a due occurrence through only the canonical account/event/due-time port', async () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'once' });
    const { deps, updates, chats, dispatches } = buildDeps(
      [event],
      [committed('jrun_exact', 'jreq_exact', 'completed')],
    );
    const uiDispatch = vi.spyOn(window, 'dispatchEvent');

    const result = await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(result.ran).toEqual([String(event.id)]);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.title).toContain('Jarvis Action');
    expect(dispatches).toEqual([
      { accountId: ACCOUNT, eventId: String(event.id), dueAt: event.start_at },
    ]);
    expect(uiDispatch).not.toHaveBeenCalled();
    expect(updates.some((update) => update.patch.status === 'done')).toBe(true);

    const metadata = parseJarvisScheduleMetadata(event)!;
    expect(metadata.lastRunAt).toBe(BASE_NOW);
    expect(metadata.outputChatId).toBe(chats[0]!.id);
    expect(metadata.runHistory).toEqual([
      {
        schemaVersion: 1,
        at: BASE_NOW,
        runId: 'jrun_exact',
        requestId: 'jreq_exact',
        status: 'completed',
      },
    ]);
  });

  it('does not expose mutable UI message or event authorities in runner dependencies', () => {
    expectTypeOf<keyof JarvisScheduleRunnerDeps>().toEqualTypeOf<
      | 'listEvents'
      | 'updateEvent'
      | 'createChat'
      | 'dispatchScheduledOccurrence'
      | 'runChatSupervisionOccurrence'
      | 'recoverCaoScheduledLearning'
      | 'runCaoScheduledLearning'
      | 'now'
    >();
    expectTypeOf<JarvisScheduleRunnerDeps['dispatchScheduledOccurrence']>()
      .parameter(0)
      .toEqualTypeOf<{
        accountId: string;
        eventId: string;
        dueAt: number;
      }>();
  });

  it('runs a due chat supervision occurrence without creating an output chat or using kernel dispatch', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - 60_000,
      recurrence: 'daily',
      metadataPatch: { chatSupervision },
    });
    const { deps, chats, dispatches, supervisionRuns } = buildDeps([event]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(chats).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(supervisionRuns).toEqual([
      {
        scheduleId: String(event.id),
        occurrenceId: String(event.start_at),
        binding: chatSupervision,
        previousReceipt: undefined,
      },
    ]);
    const metadata = parseJarvisScheduleMetadata(event)!;
    expect(metadata.lastRunAt).toBe(BASE_NOW);
    expect(metadata.nextRunAt).toBe(event.start_at + 24 * 60 * 60 * 1000);
    expect(metadata.runHistory).toEqual([
      {
        schemaVersion: 1,
        at: BASE_NOW,
        runId: `chat-supervision:${event.id}:${event.start_at}`,
        requestId: `message-${event.start_at}`,
        status: 'dispatched',
        summary: 'Chat supervision dispatched to chat-supervisor.',
      },
    ]);
  });

  it('passes the previous durable supervision receipt into the next occurrence', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - 60_000,
      metadataPatch: { chatSupervision },
    });
    const prior = {
      schemaVersion: 1 as const,
      at: BASE_NOW - 60_000,
      runId: `chat-supervision:${event.id}:prior`,
      requestId: 'message-prior',
      status: 'completed' as const,
      summary: 'Prior supervision completed.',
    };
    const unrelated = {
      schemaVersion: 1 as const,
      at: BASE_NOW - 30_000,
      runId: 'jrun-unrelated',
      requestId: 'jreq-unrelated',
      status: 'completed' as const,
    };
    Object.assign(
      event,
      withJarvisScheduleMetadata(event, {
        ...parseJarvisScheduleMetadata(event)!,
        runHistory: [prior, unrelated],
      }),
    );
    const { deps, supervisionRuns } = buildDeps([event]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(supervisionRuns[0]?.previousReceipt).toEqual(prior);
  });

  it('records a truthful failed receipt and advances without targeting another chat', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - 60_000,
      recurrence: 'daily',
      metadataPatch: { chatSupervision },
    });
    const { deps, dispatches } = buildDeps([event]);
    deps.runChatSupervisionOccurrence = vi.fn(async () => ({
      scheduleId: String(event.id),
      occurrenceId: String(event.start_at),
      dispatchKey: `${event.id}:${event.start_at}`,
      status: 'rejected' as const,
      targetChatId: chatSupervision.supervisingChatId,
      reason: 'chat_unavailable',
      replyToSourceAllowed: false,
      startedAt: BASE_NOW - 10,
      completedAt: BASE_NOW,
    }));

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(dispatches).toEqual([]);
    expect(parseJarvisScheduleMetadata(event)?.runHistory.at(-1)).toEqual({
      schemaVersion: 1,
      at: BASE_NOW,
      runId: `chat-supervision:${event.id}:${event.start_at}`,
      requestId: `${event.id}:${event.start_at}`,
      status: 'failed',
      summary: 'Chat supervision failed: chat_unavailable.',
    });
  });

  it('cancels a supervision schedule at its end condition without dispatch', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - 60_000,
      recurrence: 'daily',
      metadataPatch: { chatSupervision: { ...chatSupervision, endsAt: BASE_NOW } },
    });
    const { deps, chats, dispatches, supervisionRuns } = buildDeps([event]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(event.status).toBe('cancelled');
    expect(chats).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(supervisionRuns).toEqual([]);
  });

  it('runs and recovers learning only for an explicit dedicated CAO supervision schedule', async () => {
    const ordinary = buildEvent({ startAt: BASE_NOW - 60_000 });
    const cao = buildEvent({
      startAt: BASE_NOW - 30_000,
      projectId: 'project-a',
      metadataPatch: {
        caoSupervision: {
          schemaVersion: 1,
          mode: 'cao_supervision',
          scheduleId: 'cao-schedule-1',
          policyId: 'quarter-hour-v1',
          targetId: 'learning-md',
          projectId: 'project-a',
        },
      },
    });
    const { deps } = buildDeps([ordinary, cao]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(deps.recoverCaoScheduledLearning).toHaveBeenCalledTimes(1);
    expect(deps.runCaoScheduledLearning).toHaveBeenCalledTimes(1);
    expect(deps.runCaoScheduledLearning).toHaveBeenCalledWith({
      scope: {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        projectId: 'project-a',
        scheduleId: 'cao-schedule-1',
        targetId: 'learning-md',
        scheduleAnchorAt: cao.start_at,
      },
      trigger: 'scheduled',
      requestId: expect.stringContaining(String(cao.start_at)),
      scheduledDueAt: cao.start_at,
    });
  });

  it('persists a truthful CAO failure without changing ordinary schedule behavior', async () => {
    const cao = buildEvent({
      startAt: BASE_NOW - 30_000,
      projectId: 'project-a',
      metadataPatch: {
        caoSupervision: {
          schemaVersion: 1,
          mode: 'cao_supervision',
          scheduleId: 'cao-schedule-fail',
          policyId: 'quarter-hour-v1',
          targetId: 'learning-md',
          projectId: 'project-a',
        },
      },
    });
    const { deps } = buildDeps([cao]);
    deps.runCaoScheduledLearning = vi.fn(async () => ({ status: 'failed' as const }));

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(parseJarvisScheduleMetadata(cao)?.errorHistory.at(-1)?.error).toBe(
      'CAO scheduled learning failed.',
    );
  });

  it('durably records restart-recovery failure even when the next occurrence is not due', async () => {
    const cao = buildEvent({
      startAt: BASE_NOW + 60_000,
      projectId: 'project-a',
      metadataPatch: {
        caoSupervision: {
          schemaVersion: 1,
          mode: 'cao_supervision',
          scheduleId: 'cao-schedule-recovery',
          policyId: 'quarter-hour-v1',
          targetId: 'learning-md',
          projectId: 'project-a',
        },
      },
    });
    const { deps, dispatches } = buildDeps([cao]);
    deps.recoverCaoScheduledLearning = vi.fn(async () => ({ status: 'failed' as const }));

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(dispatches).toHaveLength(0);
    expect(parseJarvisScheduleMetadata(cao)?.errorHistory.at(-1)?.error).toBe(
      'CAO scheduled learning failed.',
    );
  });

  it.each([
    ['workspace', { workspace_id: 'workspace-foreign' }, false],
    ['project', { project_id: 'project-foreign' }, true],
  ])(
    'fails closed when dedicated CAO %s authority drifts from its persisted row',
    async (_case, drift, recordsLocalError) => {
      const cao = buildEvent({
        startAt: BASE_NOW - 30_000,
        projectId: 'project-a',
        metadataPatch: {
          caoSupervision: {
            schemaVersion: 1,
            mode: 'cao_supervision',
            scheduleId: 'cao-schedule-drift',
            policyId: 'quarter-hour-v1',
            targetId: 'learning-md',
            projectId: 'project-a',
          },
        },
      });
      Object.assign(cao, drift);
      const { deps, dispatches, updates } = buildDeps([cao]);

      await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

      expect(dispatches).toEqual([]);
      expect(deps.recoverCaoScheduledLearning).not.toHaveBeenCalled();
      expect(deps.runCaoScheduledLearning).not.toHaveBeenCalled();
      if (recordsLocalError) {
        expect(parseJarvisScheduleMetadata(cao)?.errorHistory.at(-1)?.error).toBe(
          'CAO scheduled learning scope is invalid.',
        );
      } else {
        expect(updates).toEqual([]);
      }
    },
  );

  it.each<
    [
      Exclude<JarvisScheduleRunHistoryStatus, 'dispatched'>,
      Exclude<JarvisScheduleRunHistoryStatus, 'dispatched'>,
    ]
  >([
    ['completed', 'completed'],
    ['partial', 'partial'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['timed_out', 'timed_out'],
  ])('records committed %s with exact canonical identity', async (kernelStatus, historyStatus) => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'daily' });
    const { deps } = buildDeps(
      [event],
      [committed(`jrun_${kernelStatus}`, `jreq_${kernelStatus}`, kernelStatus)],
    );

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(parseJarvisScheduleMetadata(event)!.runHistory.at(-1)).toEqual({
      schemaVersion: 1,
      at: BASE_NOW,
      runId: `jrun_${kernelStatus}`,
      requestId: `jreq_${kernelStatus}`,
      status: historyStatus,
    });
  });

  it('maps a committed awaiting-approval run to dispatched without auto-approval', async () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000 });
    const { deps } = buildDeps(
      [event],
      [committed('jrun_approval', 'jreq_approval', 'awaiting_approval')],
    );

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(parseJarvisScheduleMetadata(event)!.runHistory.at(-1)).toMatchObject({
      schemaVersion: 1,
      runId: 'jrun_approval',
      requestId: 'jreq_approval',
      status: 'dispatched',
    });
  });

  it('records retry availability as a nonterminal dispatched run and advances the occurrence', async () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'daily' });
    const run = buildRun('jrun_retryable', 'running', 'jreq_retryable');
    const attempt = run.transportAttempts![0] as JarvisTransportAttemptV1;
    const { deps, dispatches } = buildDeps(
      [event],
      [{ kind: 'transport_retry_available', run, attempt }],
    );

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);
    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    const metadata = parseJarvisScheduleMetadata(event)!;
    expect(dispatches).toHaveLength(1);
    expect(metadata.nextRunAt).toBe(event.start_at + 24 * 60 * 60 * 1000);
    expect(metadata.runHistory.at(-1)).toEqual({
      schemaVersion: 1,
      at: BASE_NOW,
      runId: 'jrun_retryable',
      requestId: 'jreq_retryable',
      status: 'dispatched',
      summary: 'Transport retry available.',
    });
  });

  it('records terminal transport failure from the exact latest canonical attempt', async () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000 });
    const run = buildRun('jrun_terminal_failure', 'failed', 'jreq_terminal_failure');
    const { deps } = buildDeps([event], [{ kind: 'terminal_transport_failure', run }]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(parseJarvisScheduleMetadata(event)!.runHistory.at(-1)).toEqual({
      schemaVersion: 1,
      at: BASE_NOW,
      runId: 'jrun_terminal_failure',
      requestId: 'jreq_terminal_failure',
      status: 'failed',
      summary: 'Terminal transport failure.',
    });
    expect(event.status).toBe('done');
  });

  it('keeps a revoked occurrence due and retries it on a later poll without fabricating history', async () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000 });
    const { deps, dispatches } = buildDeps(
      [event],
      [
        { kind: 'account_authority_revoked' },
        committed('jrun_after_reauth', 'jreq_after_reauth', 'completed'),
      ],
    );

    const first = await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);
    expect(first.ran).toEqual([]);
    expect(event.status).toBe('scheduled');
    expect(parseJarvisScheduleMetadata(event)!.nextRunAt).toBe(event.start_at);
    expect(parseJarvisScheduleMetadata(event)!.runHistory).toEqual([]);

    const second = await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);
    expect(second.ran).toEqual([String(event.id)]);
    expect(dispatches).toHaveLength(2);
  });

  it('preserves legacy schema-zero history and appends only canonical schema-one history', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - 60_000,
      metadataPatch: {
        runHistory: [
          { schemaVersion: 0, at: BASE_NOW - 10_000, status: 'success', summary: 'Legacy run.' },
        ],
      },
    });
    const { deps } = buildDeps([event], [committed('jrun_new', 'jreq_new', 'completed')]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(parseJarvisScheduleMetadata(event)!.runHistory).toEqual([
      { schemaVersion: 0, at: BASE_NOW - 10_000, status: 'success', summary: 'Legacy run.' },
      {
        schemaVersion: 1,
        at: BASE_NOW,
        runId: 'jrun_new',
        requestId: 'jreq_new',
        status: 'completed',
      },
    ]);
  });

  it('does not run actions that are not due or are cancelled or corrupt', async () => {
    const future = buildEvent({ startAt: BASE_NOW + 60 * 60 * 1000 });
    const cancelled = buildEvent({ startAt: BASE_NOW - 60_000, status: 'cancelled' });
    const corrupted = buildEvent({ startAt: BASE_NOW - 60_000 });
    corrupted.source_ref = { context: { kind: 'memory', id: 'jarvis_schedule:{not json' } };
    const { deps, dispatches, updates } = buildDeps([future, cancelled, corrupted]);

    const result = await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(result.ran).toEqual([]);
    expect(dispatches).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('records old missed runs honestly and advances without canonical dispatch', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - JARVIS_SCHEDULE_CATCH_UP_MS - 60_000,
      recurrence: 'daily',
    });
    const { deps, dispatches } = buildDeps([event]);

    const result = await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(result.missed).toEqual([String(event.id)]);
    expect(dispatches).toHaveLength(0);
    const metadata = parseJarvisScheduleMetadata(event)!;
    expect(metadata.errorHistory.at(-1)?.error).toContain('Missed scheduled run');
    expect(metadata.nextRunAt).toBeGreaterThan(BASE_NOW);
  });

  it('skips an already allocated occurrence once and resumes the next recurring run', async () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000, recurrence: 'daily' });
    const { deps, dispatches } = buildDeps([event]);
    const originalDispatch = deps.dispatchScheduledOccurrence;
    let currentTime = BASE_NOW;
    deps.now = () => currentTime;
    deps.dispatchScheduledOccurrence = vi.fn(async (input) => {
      if (input.dueAt === event.start_at) throw new Error('kernel_schedule_allocation_conflict');
      return originalDispatch(input);
    });

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);
    const afterConflict = parseJarvisScheduleMetadata(event)!;
    expect(afterConflict.nextRunAt).toBe(event.start_at + 24 * 60 * 60 * 1000);
    expect(afterConflict.errorHistory.at(-1)?.error).toContain('already allocated');
    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);
    expect(dispatches).toHaveLength(0);

    currentTime = afterConflict.nextRunAt!;
    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.dueAt).toBe(currentTime);
  });

  it('reuses the stored output chat instead of creating duplicates', async () => {
    const event = buildEvent({
      startAt: BASE_NOW - 60_000,
      metadataPatch: { outputChatId: 'cht_existing' },
    });
    const { deps, chats } = buildDeps([event]);

    await runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps);

    expect(chats).toHaveLength(0);
    expect(parseJarvisScheduleMetadata(event)!.outputChatId).toBe('cht_existing');
  });

  it('survives a failing event store without dispatching', async () => {
    const { deps, dispatches } = buildDeps([]);
    deps.listEvents = async () => {
      throw new Error('db closed');
    };

    await expect(runDueJarvisSchedules(ACCOUNT, WORKSPACE, deps)).resolves.toEqual({
      ran: [],
      missed: [],
      checked: 0,
    });
    expect(dispatches).toHaveLength(0);
  });
});

describe('withJarvisScheduleMetadata', () => {
  it('caps mixed versioned run and error history growth', () => {
    const event = buildEvent({ startAt: BASE_NOW - 60_000 });
    const metadata = parseJarvisScheduleMetadata(event)!;
    const bloated: JarvisScheduleMetadata = {
      ...metadata,
      runHistory: Array.from({ length: 60 }, (_, i) =>
        i % 2 === 0
          ? { schemaVersion: 0 as const, at: i, status: 'success' as const }
          : {
              schemaVersion: 1 as const,
              at: i,
              runId: `jrun_${i}`,
              requestId: `jreq_${i}`,
              status: 'completed' as const,
            },
      ),
      errorHistory: Array.from({ length: 60 }, (_, i) => ({ at: i, error: `e${i}` })),
    };

    Object.assign(event, withJarvisScheduleMetadata(event, bloated));
    const parsed = parseJarvisScheduleMetadata(event)!;

    expect(parsed.runHistory).toHaveLength(JARVIS_SCHEDULE_HISTORY_CAP);
    expect(parsed.errorHistory).toHaveLength(JARVIS_SCHEDULE_HISTORY_CAP);
    expect(parsed.runHistory.at(-1)?.at).toBe(59);
  });
});

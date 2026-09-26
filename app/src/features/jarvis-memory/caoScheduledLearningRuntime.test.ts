import 'fake-indexeddb/auto';

import { describe, expect, it, vi } from 'vitest';
import { createJarvisDb } from '@/lib/db';
import { buildJarvisScheduleEventInput } from '@/features/schedule/jarvisSchedules';
import type { EventRow } from '@/types/event';
import type { WorkspaceId } from '@/types/common';

import type {
  CaoScheduledLearningPersistence,
  CaoScheduledLearningScope,
} from './caoScheduledLearning';
import {
  createCaoScheduledLearningDexiePersistence,
  createCaoScheduledLearningRuntime,
  runManualCaoLearningChecks,
} from './caoScheduledLearningRuntime';

const SCOPE: CaoScheduledLearningScope = {
  accountId: 'acct-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  scheduleId: 'schedule-a',
  targetId: 'learning-md',
  scheduleAnchorAt: 1_000,
};

function memoryPersistence(): CaoScheduledLearningPersistence {
  let value: unknown;
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async ({ expectedRevision, snapshot }) => {
      const revision = (value as { revision?: number } | undefined)?.revision ?? 0;
      if (revision !== expectedRevision) throw new Error('conflict');
      value = structuredClone(snapshot);
    }),
  };
}

function supervisionEvent(input: {
  id: string;
  status?: EventRow['status'];
  projectId?: string;
  metadataProjectId?: string;
}): EventRow {
  const projectId = input.projectId ?? SCOPE.projectId;
  const metadataProjectId = input.metadataProjectId ?? projectId;
  const created = buildJarvisScheduleEventInput({
    workspaceId: SCOPE.workspaceId as WorkspaceId,
    projectId,
    createdBy: 'agent_jarvis',
    title: 'CAO supervision',
    prompt: 'Review the bounded learning journal.',
    startAt: SCOPE.scheduleAnchorAt,
    recurrence: 'custom_interval',
    intervalMs: 15 * 60 * 1_000,
    timezone: 'UTC',
    modelSelection: { mode: 'single', providerId: 'openai', modelId: 'gpt-test' },
    agentId: 'agent_jarvis',
    caoSupervision: {
      schemaVersion: 1,
      mode: 'cao_supervision',
      scheduleId: SCOPE.scheduleId,
      policyId: 'quarter-hour-v1',
      targetId: SCOPE.targetId,
      projectId: metadataProjectId,
    },
  });
  return {
    ...created,
    id: input.id,
    status: input.status ?? 'scheduled',
  } as EventRow;
}

describe('CAO scheduled learning production runtime', () => {
  it('durably stores an exact scoped snapshot with CAS and an opaque settings key', async () => {
    const database = createJarvisDb(`cao-learning-${crypto.randomUUID()}`);
    await database.open();
    try {
      const persistence = createCaoScheduledLearningDexiePersistence(database);
      const snapshot = {
        schemaVersion: 1 as const,
        revision: 1,
        ...SCOPE,
        lastLearningSeqConsumed: 7,
        scheduledOccurrenceCount: 1,
        lastScheduledDueAt: 1_500,
        completions: [],
      };
      await persistence.save({ expectedRevision: 0, snapshot });
      expect(await persistence.load(SCOPE)).toEqual(snapshot);
      const [row] = await database.settings.toArray();
      expect(row?.key).toMatch(/^cao-scheduled-learning-v1:[a-f0-9]{64}$/);
      expect(row?.key).not.toContain('acct-a');

      await expect(
        persistence.save({ expectedRevision: 0, snapshot: { ...snapshot, revision: 2 } }),
      ).rejects.toThrow('cao_learning_revision_conflict');
      expect(await persistence.load(SCOPE)).toEqual(snapshot);
    } finally {
      database.close();
      await database.delete();
    }
  });

  it('serializes duplicate scheduled triggers, consumes the durable journal high-water, and publishes success', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const, receiptId: 'receipt-a' }));
    const persistence = memoryPersistence();
    const status: string[] = [];
    const runtime = createCaoScheduledLearningRuntime({
      persistence,
      journalHighWater: vi.fn(async () => 14),
      execute,
      now: () => 2_000,
      newPassId: () => 'pass-a',
      newRequestId: () => 'request-a',
    });
    runtime.subscribe((snapshot) => status.push(snapshot.state));

    const input = { scope: SCOPE, trigger: 'scheduled' as const, scheduledDueAt: 1_500 };
    const [first, duplicate] = await Promise.all([runtime.run(input), runtime.run(input)]);

    expect(first).toMatchObject({ status: 'completed', consumed: { throughSeqInclusive: 14 } });
    expect(duplicate).toMatchObject({ status: 'completed' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        scheduleId: 'schedule-a',
        targetId: 'learning-md',
        fromSeqExclusive: 0,
        throughSeqInclusive: 14,
      }),
      expect.any(AbortSignal),
    );
    expect(status).toEqual(['running', 'completed']);
  });

  it('recovers a durable pending pass after runtime recreation with the same pass identity', async () => {
    const persistence = memoryPersistence();
    const firstExecute = vi.fn(async () => {
      throw new Error('process interrupted');
    });
    const first = createCaoScheduledLearningRuntime({
      persistence,
      journalHighWater: async () => 7,
      execute: firstExecute,
      now: () => 2_000,
      newPassId: () => 'pass-recover',
      newRequestId: () => 'request-recover',
    });
    await expect(
      first.run({ scope: SCOPE, trigger: 'scheduled', scheduledDueAt: 1_500 }),
    ).resolves.toMatchObject({ status: 'failed' });

    // Seed the interrupted boundary directly: pending durability/reuse is the
    // controller contract; this runtime assertion proves production recovery wiring.
    const pendingPersistence = memoryPersistence();
    await pendingPersistence.save({
      expectedRevision: 0,
      snapshot: {
        schemaVersion: 1,
        revision: 1,
        ...SCOPE,
        lastLearningSeqConsumed: 0,
        scheduledOccurrenceCount: 0,
        pending: {
          passId: 'pass-recover',
          requestId: 'request-recover',
          trigger: 'scheduled',
          fromSeqExclusive: 0,
          throughSeqInclusive: 7,
          requestedAt: 2_000,
          scheduledDueAt: 1_500,
        },
        completions: [],
      },
    });
    const recoveredExecute = vi.fn(async () => ({
      status: 'completed' as const,
      receiptId: 'receipt-r',
    }));
    const restarted = createCaoScheduledLearningRuntime({
      persistence: pendingPersistence,
      journalHighWater: async () => 99,
      execute: recoveredExecute,
      now: () => 3_000,
      newPassId: () => 'must-not-replace',
      newRequestId: () => 'unused',
    });

    await expect(restarted.recover(SCOPE)).resolves.toMatchObject({
      status: 'completed',
      passId: 'pass-recover',
      consumed: { fromSeqExclusive: 0, throughSeqInclusive: 7 },
    });
    expect(recoveredExecute).toHaveBeenCalledWith(
      expect.objectContaining({ passId: 'pass-recover', throughSeqInclusive: 7 }),
      expect.any(AbortSignal),
    );
  });

  it('reports truthful failure and cancellation without advancing manual-force schedule counts', async () => {
    const persistence = memoryPersistence();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runtime = createCaoScheduledLearningRuntime({
      persistence,
      journalHighWater: async () => 4,
      execute: async (_input, signal) => {
        await gate;
        return signal.aborted ? { status: 'cancelled' } : { status: 'failed' };
      },
      now: () => 2_000,
      newPassId: () => 'pass-cancel',
      newRequestId: () => 'request-manual',
    });

    const pending = runtime.run({ scope: SCOPE, trigger: 'manual_force' });
    expect(runtime.getStatus().state).toBe('running');
    runtime.cancel(SCOPE);
    release();

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled',
      scheduledOccurrenceCount: 0,
    });
    expect(runtime.getStatus()).toMatchObject({ state: 'cancelled', trigger: 'manual_force' });
  });

  it('cancels the executing pass and drops older queued same-scope work without completion', async () => {
    const persistence = memoryPersistence();
    let started!: () => void;
    const executing = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async (_input, signal: AbortSignal) => {
      started();
      await gate;
      return signal.aborted
        ? ({ status: 'cancelled' } as const)
        : ({ status: 'completed', receiptId: 'must-not-complete' } as const);
    });
    const runtime = createCaoScheduledLearningRuntime({
      persistence,
      journalHighWater: async () => 9,
      execute,
      now: () => 2_000,
      newPassId: () => 'pass-active',
      newRequestId: () => 'unused',
    });

    const active = runtime.run({
      scope: SCOPE,
      trigger: 'scheduled',
      requestId: 'request-active',
      scheduledDueAt: 1_500,
    });
    await executing;
    const queued = runtime.run({
      scope: SCOPE,
      trigger: 'manual_force',
      requestId: 'request-queued',
    });
    runtime.cancel(SCOPE);
    release();

    await expect(active).resolves.toMatchObject({ status: 'cancelled' });
    await expect(queued).resolves.toMatchObject({ status: 'cancelled', passId: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await persistence.load(SCOPE)).toMatchObject({
      lastLearningSeqConsumed: 0,
      scheduledOccurrenceCount: 0,
      completions: [],
    });
  });

  it('restores the pending manual-force trigger in canonical status after runtime restart', async () => {
    const persistence = memoryPersistence();
    await persistence.save({
      expectedRevision: 0,
      snapshot: {
        schemaVersion: 1,
        revision: 1,
        ...SCOPE,
        lastLearningSeqConsumed: 0,
        scheduledOccurrenceCount: 0,
        pending: {
          passId: 'pass-manual-restart',
          requestId: 'request-manual-restart',
          trigger: 'manual_force',
          fromSeqExclusive: 0,
          throughSeqInclusive: 8,
          requestedAt: 2_000,
        },
        completions: [],
      },
    });
    const runtime = createCaoScheduledLearningRuntime({
      persistence,
      journalHighWater: async () => 99,
      execute: async () => ({ status: 'completed', receiptId: 'receipt-manual-restart' }),
      now: () => 3_000,
      newPassId: () => 'must-not-replace',
      newRequestId: () => 'unused',
    });

    await expect(runtime.recover(SCOPE)).resolves.toMatchObject({
      status: 'completed',
      passId: 'pass-manual-restart',
    });
    expect(runtime.getStatus()).toMatchObject({ state: 'completed', trigger: 'manual_force' });
  });

  it('recovers once before a manual force and ignores paused, duplicate, and project-drifted rows', async () => {
    const active = supervisionEvent({ id: 'event-active' });
    const duplicate = supervisionEvent({ id: 'event-duplicate' });
    const paused = supervisionEvent({ id: 'event-paused', status: 'cancelled' });
    const drifted = supervisionEvent({
      id: 'event-drifted',
      projectId: 'project-b',
      metadataProjectId: SCOPE.projectId,
    });
    const recover = vi.fn(async () => null);
    const run = vi.fn(async () => ({ status: 'completed' as const }));

    await expect(
      runManualCaoLearningChecks({
        getAccountIdentity: () => ({ accountId: SCOPE.accountId }),
        getWorkspaceId: () => SCOPE.workspaceId,
        listEvents: async () => [active, duplicate, paused, drifted],
        recover,
        run,
      }),
    ).resolves.toEqual({ status: 'completed' });
    expect(recover).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({ scope: SCOPE, trigger: 'manual_force' });
  });

  it.each(['failed', 'cancelled'] as const)(
    'stops a manual force when durable pending recovery is %s',
    async (status) => {
      const run = vi.fn(async () => ({ status: 'completed' as const }));

      await expect(
        runManualCaoLearningChecks({
          getAccountIdentity: () => ({ accountId: SCOPE.accountId }),
          getWorkspaceId: () => SCOPE.workspaceId,
          listEvents: async () => [supervisionEvent({ id: 'event-active' })],
          recover: async () => ({ status }),
          run,
        }),
      ).resolves.toEqual({ status });
      expect(run).not.toHaveBeenCalled();
    },
  );
});

it('runs a manual review for the current project when no schedules exist', async () => {
 const run=vi.fn(async()=>({status:'completed' as const}));
 const result=await runManualCaoLearningChecks({getAccountIdentity:()=>({accountId:'account'}),getWorkspaceId:()=> 'workspace',getProjectId:()=> 'project',listEvents:async()=>[],recover:async()=>null,run});
 expect(result.status).toBe('completed');
 expect(run).toHaveBeenCalledWith({scope:{accountId:'account',workspaceId:'workspace',projectId:'project',scheduleId:'cao-manual-project',targetId:'jarvis-cao',scheduleAnchorAt:0},trigger:'manual_force'});
});

it('includes the current project in a manual review when scheduled scopes belong elsewhere', async () => {
  const otherProjectEvent = supervisionEvent({ id: 'event-other-project', projectId: 'project-b' });
  const run = vi.fn(async () => ({ status: 'completed' as const }));
  const result = await runManualCaoLearningChecks({
    getAccountIdentity: () => ({ accountId: SCOPE.accountId }),
    getWorkspaceId: () => SCOPE.workspaceId,
    getProjectId: () => SCOPE.projectId,
    listEvents: async () => [otherProjectEvent],
    recover: async () => null,
    run,
  });

  expect(result).toEqual({ status: 'completed' });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenNthCalledWith(1, {
    scope: { ...SCOPE, projectId: 'project-b' },
    trigger: 'manual_force',
  });
  expect(run).toHaveBeenNthCalledWith(2, {
    scope: {
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      projectId: SCOPE.projectId,
      scheduleId: 'cao-manual-project',
      targetId: 'jarvis-cao',
      scheduleAnchorAt: 0,
    },
    trigger: 'manual_force',
  });
});

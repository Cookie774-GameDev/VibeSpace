import { describe, expect, it, vi } from 'vitest';

import type { CaoTargetLeaseV1 } from '@/lib/jarvis/contracts/execution';

import {
  createCaoScheduledLearningController,
  parseCaoScheduledLearningSnapshot,
  type CaoLearningExecutionInput,
  type CaoScheduledLearningPersistence,
  type CaoScheduledLearningSnapshot,
} from './caoScheduledLearning';
import { createCaoScheduledTargetExecution } from './caoScheduledTargetAuthority';

const scope = {
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  scheduleId: 'schedule-1',
  targetId: 'chat-1',
  scheduleAnchorAt: 1_000,
} as const;

const binding = {
  runId: 'run-1',
  leaseId: 'lease-1',
  targetKind: 'chat' as const,
  targetRevision: 7,
};

function lease(): CaoTargetLeaseV1 {
  return {
    schemaVersion: 1,
    kind: 'cao_target_lease',
    leaseId: binding.leaseId,
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    runId: binding.runId,
    selectionMode: 'explicit_single',
    targets: [{ kind: binding.targetKind, targetId: scope.targetId, revision: 7 }],
    acquiredAt: 900,
    expiresAt: 10_000,
  };
}

function durableMemory(options: { failSaveCall?: number } = {}) {
  let stored: unknown = null;
  let saveCalls = 0;
  const writes: CaoScheduledLearningSnapshot[] = [];
  const persistence: CaoScheduledLearningPersistence = {
    load: vi.fn(async () => structuredClone(stored)),
    save: vi.fn(async ({ expectedRevision, snapshot }) => {
      saveCalls += 1;
      const current = parseCaoScheduledLearningSnapshot(stored);
      expect(current?.revision ?? 0).toBe(expectedRevision);
      if (saveCalls === options.failSaveCall) throw new Error('durable store unavailable');
      stored = structuredClone(snapshot);
      writes.push(structuredClone(snapshot));
    }),
  };
  return {
    persistence,
    writes,
    read: () => parseCaoScheduledLearningSnapshot(stored),
    allowSaves: () => {
      options.failSaveCall = undefined;
    },
  };
}

function authorizedExecution(
  verify: Parameters<typeof createCaoScheduledTargetExecution>[0]['authority']['verify'],
  execute: (input: CaoLearningExecutionInput) => Promise<{
    status: 'completed' | 'failed' | 'cancelled';
    receiptId?: string;
  }>,
) {
  const scoped = createCaoScheduledTargetExecution({
    authority: { verify },
    execute: async (input) => {
      const result = await execute(input);
      return result.status === 'completed'
        ? { status: 'completed', receiptId: result.receiptId ?? 'receipt-1' }
        : { status: result.status };
    },
  });
  return (execution: CaoLearningExecutionInput) => scoped.execute({ execution, ...binding });
}

describe('authorized CAO scheduled-learning recovery acceptance', () => {
  it('durably records pending work before target verification and advances the cursor only after success', async () => {
    const durable = durableMemory();
    const verify = vi.fn(async () => {
      expect(durable.read()?.pending).toMatchObject({
        passId: 'pass-1',
        fromSeqExclusive: 0,
        throughSeqInclusive: 8,
      });
      return lease();
    });
    const execute = vi.fn(async () => ({ status: 'completed' as const, receiptId: 'receipt-1' }));
    const controller = createCaoScheduledLearningController({
      persistence: durable.persistence,
      execute: authorizedExecution(verify, execute),
      newPassId: () => 'pass-1',
      now: () => 2_000,
    });

    await expect(
      controller.run({
        ...scope,
        trigger: 'scheduled',
        requestId: 'occurrence-1',
        scheduledDueAt: 1_000,
        journalHighWaterSeq: 8,
      }),
    ).resolves.toMatchObject({ status: 'completed', scheduledOccurrenceCount: 1 });

    expect(durable.writes).toHaveLength(2);
    expect(durable.read()).toMatchObject({
      lastLearningSeqConsumed: 8,
      scheduledOccurrenceCount: 1,
    });
    expect(durable.read()).not.toHaveProperty('pending');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deduplicates manual-force across controller reload without revalidating or recounting', async () => {
    const durable = durableMemory();
    const verify = vi.fn().mockResolvedValue(lease());
    const execute = vi.fn(async () => ({ status: 'completed' as const, receiptId: 'manual-1' }));
    const deps = {
      persistence: durable.persistence,
      execute: authorizedExecution(verify, execute),
      newPassId: () => 'pass-manual',
      now: () => 2_000,
    };
    const request = {
      ...scope,
      trigger: 'manual_force' as const,
      requestId: 'manual-request-1',
      journalHighWaterSeq: 5,
    };

    await createCaoScheduledLearningController(deps).run(request);
    const duplicate = await createCaoScheduledLearningController(deps).run(request);

    expect(duplicate).toMatchObject({
      status: 'completed',
      deduplicated: true,
      scheduledOccurrenceCount: 0,
    });
    expect(durable.read()).toMatchObject({
      lastLearningSeqConsumed: 5,
      scheduledOccurrenceCount: 0,
      scheduleAnchorAt: 1_000,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('revalidates the same pending pass after restart before advancing exactly once', async () => {
    const durable = durableMemory({ failSaveCall: 2 });
    const verify = vi.fn().mockResolvedValue(lease());
    const execute = vi.fn(async (input: CaoLearningExecutionInput) => ({
      status: 'completed' as const,
      receiptId: `receipt-${input.passId}`,
    }));
    const deps = {
      persistence: durable.persistence,
      execute: authorizedExecution(verify, execute),
      newPassId: () => 'pass-restart',
      now: () => 2_000,
    };

    await expect(
      createCaoScheduledLearningController(deps).run({
        ...scope,
        trigger: 'scheduled',
        requestId: 'occurrence-restart',
        scheduledDueAt: 1_000,
        journalHighWaterSeq: 6,
      }),
    ).rejects.toThrow('cao_learning_persistence_failed');
    expect(durable.read()?.pending?.passId).toBe('pass-restart');

    durable.allowSaves();
    const recovered = await createCaoScheduledLearningController(deps).recover(scope);

    expect(recovered).toMatchObject({ status: 'completed', passId: 'pass-restart' });
    expect(durable.read()).toMatchObject({
      lastLearningSeqConsumed: 6,
      scheduledOccurrenceCount: 1,
    });
    expect(durable.read()).not.toHaveProperty('pending');
    expect(verify).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls.map(([input]) => input.passId)).toEqual([
      'pass-restart',
      'pass-restart',
    ]);
  });

  it('keeps the cursor stable on authority failure and succeeds only after a fresh verified request', async () => {
    const durable = durableMemory();
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error('cao_target_lease_stale'))
      .mockResolvedValue(lease());
    const execute = vi.fn(async () => ({ status: 'completed' as const, receiptId: 'retry-1' }));
    let pass = 0;
    const controller = createCaoScheduledLearningController({
      persistence: durable.persistence,
      execute: authorizedExecution(verify, execute),
      newPassId: () => `pass-${++pass}`,
      now: () => 2_000,
    });

    await expect(
      controller.run({
        ...scope,
        trigger: 'manual_force',
        requestId: 'manual-stale',
        journalHighWaterSeq: 9,
      }),
    ).resolves.toMatchObject({ status: 'failed', scheduledOccurrenceCount: 0 });
    expect(durable.read()).toMatchObject({ lastLearningSeqConsumed: 0 });
    expect(durable.read()).not.toHaveProperty('pending');
    expect(execute).not.toHaveBeenCalled();

    await expect(
      controller.run({
        ...scope,
        trigger: 'manual_force',
        requestId: 'manual-retry',
        journalHighWaterSeq: 9,
      }),
    ).resolves.toMatchObject({ status: 'completed', scheduledOccurrenceCount: 0 });
    expect(durable.read()).toMatchObject({ lastLearningSeqConsumed: 9 });
    expect(durable.read()).not.toHaveProperty('pending');
    expect(verify).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

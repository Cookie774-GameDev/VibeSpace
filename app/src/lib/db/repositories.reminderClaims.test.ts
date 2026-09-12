import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { Reminder, Task } from '@/types/task';
import { createJarvisDb, type JarvisDexie } from './index';

const NOW = 1_786_200_100_000;

function dueTask(): Task {
  const reminder: Reminder = {
    id: 'rem_atomic',
    task_id: 'task_atomic',
    fires_at: NOW - 1,
    channels: ['in_app'],
    status: 'scheduled',
    snooze_history: [],
  } as unknown as Reminder;
  return {
    id: 'task_atomic',
    workspace_id: 'workspace_atomic',
    title: 'Atomic reminder',
    status: 'open',
    priority: 'normal',
    effort: 3,
    context_tags: [],
    energy_required: 'medium',
    reminders: [reminder],
    created_by: 'user_text',
    source_refs: [],
    created_at: NOW - 100,
    updated_at: NOW - 100,
  } as unknown as Task;
}

type ReminderClaimRepository = {
  claim(input: ClaimInput): Promise<Task | undefined>;
  finalize(input: MutationInput): Promise<Task | undefined>;
  release(input: MutationInput): Promise<Task | undefined>;
};

type MutationInput = {
  taskId: Task['id'];
  reminderId: Reminder['id'];
  claimId: string;
  expectedWorkspaceId: Task['workspace_id'];
  getActiveWorkspaceId: () => Task['workspace_id'] | null;
  now: number;
};

type ClaimInput = MutationInput & { expiresAt: number };

describe('reminder claim repository', () => {
  let firstDb: JarvisDexie;
  let secondDb: JarvisDexie;

  beforeEach(async () => {
    const name = uniqueTestDbName('reminder-claim-cas');
    firstDb = createJarvisDb(name, TEST_INDEXED_DB);
    secondDb = createJarvisDb(name, TEST_INDEXED_DB);
    await Promise.all([firstDb.open(), secondDb.open()]);
    await firstDb.tasks.put(dueTask());
  });

  afterEach(async () => {
    secondDb.close();
    await firstDb.delete();
  });

  it('atomically admits one of two independent Dexie claimers', async () => {
    const repositories = (await import('./repositories')) as unknown as {
      createReminderClaimRepository?: (database: JarvisDexie) => ReminderClaimRepository;
    };
    expect(repositories.createReminderClaimRepository).toBeTypeOf('function');
    if (!repositories.createReminderClaimRepository) return;

    const first = repositories.createReminderClaimRepository(firstDb);
    const second = repositories.createReminderClaimRepository(secondDb);
    const scope = {
      taskId: 'task_atomic' as Task['id'],
      reminderId: 'rem_atomic' as Reminder['id'],
      expectedWorkspaceId: 'workspace_atomic' as Task['workspace_id'],
      getActiveWorkspaceId: () => 'workspace_atomic' as Task['workspace_id'],
      now: NOW,
      expiresAt: NOW + 120_000,
    };

    const [firstClaim, secondClaim] = await Promise.all([
      first.claim({ ...scope, claimId: 'claim_first' }),
      second.claim({ ...scope, claimId: 'claim_second' }),
    ]);

    expect(Number(Boolean(firstClaim)) + Number(Boolean(secondClaim))).toBe(1);
    const persisted = await firstDb.tasks.get(scope.taskId);
    expect(['claim_first', 'claim_second']).toContain(persisted?.reminders[0]?.delivery_claim?.id);
  });

  it('revalidates the active and persisted workspace before finalize and release mutations', async () => {
    const repositories = (await import('./repositories')) as unknown as {
      createReminderClaimRepository: (database: JarvisDexie) => ReminderClaimRepository;
    };
    const repository = repositories.createReminderClaimRepository(firstDb);
    let activeWorkspace = 'workspace_atomic' as Task['workspace_id'];
    const scope = {
      taskId: 'task_atomic' as Task['id'],
      reminderId: 'rem_atomic' as Reminder['id'],
      expectedWorkspaceId: 'workspace_atomic' as Task['workspace_id'],
      getActiveWorkspaceId: () => activeWorkspace,
      claimId: 'claim_scoped',
      now: NOW,
    };
    await expect(repository.claim({ ...scope, expiresAt: NOW + 120_000 })).resolves.toBeDefined();

    activeWorkspace = 'workspace_other' as Task['workspace_id'];
    await expect(repository.finalize(scope)).resolves.toBeUndefined();
    await expect(repository.release(scope)).resolves.toBeUndefined();

    await expect(firstDb.tasks.get(scope.taskId)).resolves.toMatchObject({
      workspace_id: 'workspace_atomic',
      reminders: [
        {
          status: 'scheduled',
          delivery_claim: { id: 'claim_scoped' },
        },
      ],
    });
  });
});

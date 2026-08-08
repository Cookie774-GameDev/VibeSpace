import { describe, expect, it } from 'vitest';
import {
  createGoalCheckpointRepository,
  type GoalCheckpointStoredRecordV1,
  type GoalCheckpointStoragePort,
} from './goalCheckpointRepository';
import { createGoalManifest } from './goalCheckpoint';

function manifest(accountId = 'account-1', projectId = 'project-1') {
  return createGoalManifest({
    id: 'goal-repository',
    accountId,
    projectId,
    runId: 'run-1',
    repoRoot: 'C:\\workspace',
    branch: 'feature/authority',
    headSha: 'a'.repeat(40),
    objective: 'Persist checkpoints safely.',
    criteria: [{ id: 'tests', description: 'Focused tests pass.', mandatory: true }],
    ownership: { ownedPaths: ['owned.ts'], exclusions: ['excluded.ts'] },
    authorityVersion: 1,
    issuedAt: 1_000,
    expiresAt: 10_000,
  });
}

function memoryStorage(): GoalCheckpointStoragePort & {
  rows: unknown[];
  mutations: number;
} {
  const rows: unknown[] = [];
  const idempotency = new Map<string, GoalCheckpointStoredRecordV1>();
  return {
    rows,
    mutations: 0,
    async loadScope() {
      return structuredClone(rows);
    },
    async appendExpected(input) {
      const duplicate = idempotency.get(input.idempotencyKey);
      if (duplicate) return { kind: 'duplicate', record: structuredClone(duplicate) };
      const records = rows.filter(
        (candidate): candidate is GoalCheckpointStoredRecordV1 =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as GoalCheckpointStoredRecordV1).manifestId === input.record.manifestId,
      );
      const revision = Math.max(0, ...records.map((record) => record.revision));
      if (revision !== input.expectedRevision)
        return { kind: 'conflict', currentRevision: revision };
      const record = structuredClone(input.record);
      rows.push(record);
      idempotency.set(input.idempotencyKey, record);
      this.mutations += 1;
      return { kind: 'appended', record: structuredClone(record) };
    },
  };
}

describe('goal checkpoint repository', () => {
  it('atomically appends expected revisions and deduplicates idempotent retries', async () => {
    const storage = memoryStorage();
    const repository = createGoalCheckpointRepository(storage);
    const input = {
      manifest: manifest(),
      previous: null,
      expectedRevision: 0,
      idempotencyKey: 'checkpoint:first',
      state: 'running' as const,
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: 1_200,
      createdAt: 1_300,
      cursorIssuedAt: 1_400,
      cursorExpiresAt: 9_000,
    };

    const first = await repository.append(input);
    const retry = await repository.append(input);

    expect(first).toMatchObject({ kind: 'appended', record: { revision: 1 } });
    expect(retry).toMatchObject({ kind: 'duplicate', record: { revision: 1 } });
    expect(storage.mutations).toBe(1);
    await expect(
      repository.append({
        ...input,
        idempotencyKey: 'checkpoint:stale',
        expectedRevision: 0,
      }),
    ).resolves.toEqual({ kind: 'conflict', currentRevision: 1 });
  });

  it('loads valid records after restart and quarantines corrupt or cross-scope rows without raw data', async () => {
    const storage = memoryStorage();
    const firstRepository = createGoalCheckpointRepository(storage);
    await firstRepository.append({
      manifest: manifest(),
      previous: null,
      expectedRevision: 0,
      idempotencyKey: 'checkpoint:first',
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: 1_200,
      createdAt: 1_300,
      cursorIssuedAt: 1_400,
      cursorExpiresAt: 9_000,
    });
    storage.rows.push({ secret: 'must-not-escape', revision: 2 });
    storage.rows.push({
      ...(storage.rows[0] as GoalCheckpointStoredRecordV1),
      accountId: 'account-other',
      revision: 2,
    });

    const restarted = createGoalCheckpointRepository(storage);
    const loaded = await restarted.loadScope('account-1', 'project-1');

    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({ revision: 1, manifestId: 'goal-repository' });
    expect(loaded.quarantined).toEqual([
      {
        rowIndex: 1,
        reason: 'invalid_record',
        quarantineRef: 'goal-quarantine:account-1:project-1:1',
      },
      {
        rowIndex: 2,
        reason: 'scope_mismatch',
        quarantineRef: 'goal-quarantine:account-1:project-1:2',
      },
    ]);
    expect(JSON.stringify(loaded.quarantined)).not.toContain('must-not-escape');
  });

  it('validates restart resume against the latest durable revision and current authority', async () => {
    const storage = memoryStorage();
    const repository = createGoalCheckpointRepository(storage);
    const appended = await repository.append({
      manifest: manifest(),
      previous: null,
      expectedRevision: 0,
      idempotencyKey: 'checkpoint:first',
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: 1_200,
      createdAt: 1_300,
      cursorIssuedAt: 1_400,
      cursorExpiresAt: 9_000,
    });
    if (appended.kind === 'conflict') throw new Error('unexpected conflict');

    expect(
      repository.validateResume(appended.record, {
        accountId: 'account-1',
        projectId: 'project-1',
        repoRoot: 'C:\\workspace',
        branch: 'feature/authority',
        headSha: 'a'.repeat(40),
        authorityVersion: 1,
        latestCheckpointSequence: 1,
        now: 2_000,
      }),
    ).toMatchObject({ ok: true });
    expect(
      repository.validateResume(appended.record, {
        accountId: 'account-1',
        projectId: 'project-1',
        repoRoot: 'C:\\workspace',
        branch: 'feature/authority',
        headSha: 'b'.repeat(40),
        authorityVersion: 1,
        latestCheckpointSequence: 1,
        now: 2_000,
      }),
    ).toEqual({ ok: false, reason: 'scope_mismatch' });
  });
});

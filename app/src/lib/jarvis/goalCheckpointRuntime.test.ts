import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { db, openDb } from '@/lib/db';
import { createGoalManifest } from './goalCheckpoint';
import { createGoalCheckpointRepository } from './goalCheckpointRepository';
import { createDexieGoalCheckpointStorage } from './goalCheckpointRuntime';

const now = 1_700_000_000_000;

function manifest(accountId = 'account-a', projectId = 'project-a') {
  return createGoalManifest({
    id: 'goal-a',
    accountId,
    projectId,
    runId: 'run-a',
    repoRoot: 'C:\\fixture',
    branch: 'main',
    headSha: 'a'.repeat(40),
    objective: 'Apply one verified fixture change.',
    criteria: [
      { id: 'criterion-a', description: 'The fixture is verified.', mandatory: true },
    ],
    ownership: { ownedPaths: ['src/a.ts'], exclusions: ['all other paths'] },
    authorityVersion: 1,
    issuedAt: now,
    expiresAt: now + 60_000,
  });
}

describe('live goal checkpoint storage', () => {
  afterEach(async () => {
    await db.delete();
  });

  it('persists exact scoped checkpoints and recovers them after repository recreation', async () => {
    await openDb();
    const first = createGoalCheckpointRepository(createDexieGoalCheckpointStorage());
    const created = await first.append({
      manifest: manifest(),
      previous: null,
      expectedRevision: 0,
      idempotencyKey: 'create-a',
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: now,
      createdAt: now,
      cursorIssuedAt: now,
      cursorExpiresAt: now + 60_000,
    });
    expect(created.kind).toBe('appended');

    const restarted = createGoalCheckpointRepository(createDexieGoalCheckpointStorage());
    const loaded = await restarted.loadScope('account-a', 'project-a');
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({
      accountId: 'account-a',
      projectId: 'project-a',
      manifestId: 'goal-a',
      revision: 1,
      idempotencyKey: 'create-a',
    });
  });

  it('keeps scopes isolated and treats duplicate append authority idempotently', async () => {
    await openDb();
    const repository = createGoalCheckpointRepository(createDexieGoalCheckpointStorage());
    const input = {
      manifest: manifest(),
      previous: null,
      expectedRevision: 0,
      idempotencyKey: 'create-a',
      state: 'running' as const,
      completedCriteriaIds: [] as const,
      evidenceRefs: [] as const,
      finalMutationAt: now,
      createdAt: now,
      cursorIssuedAt: now,
      cursorExpiresAt: now + 60_000,
    };
    await expect(repository.append(input)).resolves.toMatchObject({ kind: 'appended' });
    await expect(repository.append(input)).resolves.toMatchObject({ kind: 'duplicate' });
    await expect(repository.loadScope('account-b', 'project-a')).resolves.toMatchObject({
      records: [],
      quarantined: [],
    });
  });

  it('returns conflicting revision evidence instead of overwriting a newer checkpoint', async () => {
    await openDb();
    const repository = createGoalCheckpointRepository(createDexieGoalCheckpointStorage());
    const created = await repository.append({
      manifest: manifest(),
      previous: null,
      expectedRevision: 0,
      idempotencyKey: 'create-a',
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: now,
      createdAt: now,
      cursorIssuedAt: now,
      cursorExpiresAt: now + 60_000,
    });
    if (created.kind === 'conflict') throw new Error('fixture conflict');
    await expect(
      repository.append({
        manifest: created.record.manifest,
        previous: created.record,
        expectedRevision: 0,
        idempotencyKey: 'stale-a',
        state: 'running',
        completedCriteriaIds: [],
        evidenceRefs: [],
        finalMutationAt: now,
        createdAt: now + 1,
        cursorIssuedAt: now + 1,
        cursorExpiresAt: now + 60_000,
      }),
    ).rejects.toThrow(/previous checkpoint revision/i);
  });

  it('fails closed without replacing malformed scoped storage', async () => {
    await openDb();
    if (!db.isOpen()) await db.open();
    const key = 'jarvis-goal-checkpoints-v1:account-a:project-a';
    const malformed = { schemaVersion: 99, records: ['untrusted'] };
    await db.settings.put({ key, value: malformed, updated_at: now });
    const repository = createGoalCheckpointRepository(createDexieGoalCheckpointStorage());

    await expect(
      repository.append({
        manifest: manifest(),
        previous: null,
        expectedRevision: 0,
        idempotencyKey: 'create-a',
        state: 'running',
        completedCriteriaIds: [],
        evidenceRefs: [],
        finalMutationAt: now,
        createdAt: now,
        cursorIssuedAt: now,
        cursorExpiresAt: now + 60_000,
      }),
    ).resolves.toEqual({ kind: 'conflict', currentRevision: 0 });
    await expect(db.settings.get(key)).resolves.toMatchObject({ value: malformed });
  });
});

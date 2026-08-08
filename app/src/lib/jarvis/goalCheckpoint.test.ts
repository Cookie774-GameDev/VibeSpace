import { describe, expect, it } from 'vitest';
import {
  createGoalCheckpoint,
  createGoalManifest,
  createGoalResumeCursor,
  validateGoalResume,
  type GoalCheckpointV1,
} from './goalCheckpoint';

function manifest() {
  return createGoalManifest({
    id: 'goal-1',
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    repoRoot: 'C:\\workspace',
    branch: 'feature/authority',
    headSha: 'a'.repeat(40),
    objective: 'Build a durable authority foundation.',
    criteria: [
      { id: 'criterion-tests', description: 'Focused tests pass.', mandatory: true },
      { id: 'criterion-docs', description: 'Document the contract.', mandatory: false },
    ],
    ownership: {
      ownedPaths: ['app/src/lib/jarvis/goalCheckpoint.ts'],
      exclusions: ['app/src/lib/db/**'],
    },
    authorityVersion: 3,
    issuedAt: 1_000,
    expiresAt: 10_000,
  });
}

describe('durable goal checkpoints', () => {
  it('creates immutable versioned manifests that bind objective, repository, criteria, and scope', () => {
    const value = manifest();

    expect(value).toMatchObject({
      schemaVersion: 1,
      id: 'goal-1',
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      repoRoot: 'C:\\workspace',
      branch: 'feature/authority',
      headSha: 'a'.repeat(40),
      objective: 'Build a durable authority foundation.',
      authorityVersion: 3,
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.criteria)).toBe(true);
    expect(Object.isFrozen(value.criteria[0])).toBe(true);
    expect(Object.isFrozen(value.ownership.ownedPaths)).toBe(true);
    expect(value.criteria.map(({ id }) => id)).toEqual(['criterion-tests', 'criterion-docs']);
  });

  it('requires at least one mandatory acceptance criterion', () => {
    expect(() =>
      createGoalManifest({
        id: 'goal-optional-only',
        accountId: 'account-1',
        projectId: 'project-1',
        runId: 'run-1',
        repoRoot: 'C:\\workspace',
        branch: 'feature/authority',
        headSha: 'a'.repeat(40),
        objective: 'Do not complete vacuously.',
        criteria: [{ id: 'optional', description: 'Optional note.', mandatory: false }],
        ownership: { ownedPaths: ['owned.ts'], exclusions: ['excluded.ts'] },
        authorityVersion: 1,
        issuedAt: 1_000,
        expiresAt: 10_000,
      }),
    ).toThrow();
  });

  it('requires a strictly monotonic checkpoint chain and binds a resume cursor to its sequence', () => {
    const goal = manifest();
    const first = createGoalCheckpoint({
      manifest: goal,
      previous: null,
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: 1_200,
      createdAt: 1_300,
    });
    const second = createGoalCheckpoint({
      manifest: goal,
      previous: first,
      state: 'ready_for_completion',
      completedCriteriaIds: ['criterion-tests'],
      evidenceRefs: ['jresult_tests_1'],
      finalMutationAt: 1_400,
      createdAt: 1_500,
    });
    const cursor = createGoalResumeCursor({
      manifest: goal,
      checkpoint: second,
      issuedAt: 1_600,
      expiresAt: 9_000,
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(cursor).toMatchObject({
      schemaVersion: 1,
      manifestId: 'goal-1',
      checkpointSequence: 2,
      headSha: 'a'.repeat(40),
      authorityVersion: 3,
    });
    expect(() =>
      createGoalCheckpoint({
        manifest: goal,
        previous: { ...second, sequence: 0 } as GoalCheckpointV1,
        state: 'running',
        completedCriteriaIds: [],
        evidenceRefs: [],
        finalMutationAt: 1_600,
        createdAt: 1_700,
      }),
    ).toThrow(/checkpoint/i);
  });

  it.each([
    ['accountId', 'account-other'],
    ['projectId', 'project-other'],
    ['repoRoot', 'C:\\other'],
    ['branch', 'feature/other'],
    ['headSha', 'b'.repeat(40)],
  ] as const)('rejects resume when current %s differs from the durable authority', (key, value) => {
    const goal = manifest();
    const checkpoint = createGoalCheckpoint({
      manifest: goal,
      previous: null,
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: 1_200,
      createdAt: 1_300,
    });
    const cursor = createGoalResumeCursor({
      manifest: goal,
      checkpoint,
      issuedAt: 1_400,
      expiresAt: 9_000,
    });
    const current = {
      accountId: goal.accountId,
      projectId: goal.projectId,
      repoRoot: goal.repoRoot,
      branch: goal.branch,
      headSha: goal.headSha,
      authorityVersion: goal.authorityVersion,
      latestCheckpointSequence: checkpoint.sequence,
      now: 2_000,
      [key]: value,
    };

    expect(validateGoalResume({ manifest: goal, checkpoint, cursor, current })).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('rejects expired, stale-authority, and non-latest checkpoint resumes', () => {
    const goal = manifest();
    const checkpoint = createGoalCheckpoint({
      manifest: goal,
      previous: null,
      state: 'running',
      completedCriteriaIds: [],
      evidenceRefs: [],
      finalMutationAt: 1_200,
      createdAt: 1_300,
    });
    const cursor = createGoalResumeCursor({
      manifest: goal,
      checkpoint,
      issuedAt: 1_400,
      expiresAt: 1_900,
    });
    const base = {
      accountId: goal.accountId,
      projectId: goal.projectId,
      repoRoot: goal.repoRoot,
      branch: goal.branch,
      headSha: goal.headSha,
      authorityVersion: goal.authorityVersion,
      latestCheckpointSequence: checkpoint.sequence,
      now: 1_800,
    };

    expect(
      validateGoalResume({
        manifest: goal,
        checkpoint,
        cursor,
        current: { ...base, now: 2_000 },
      }),
    ).toEqual({ ok: false, reason: 'authority_expired' });
    expect(
      validateGoalResume({
        manifest: goal,
        checkpoint,
        cursor,
        current: { ...base, authorityVersion: 4 },
      }),
    ).toEqual({ ok: false, reason: 'authority_stale' });
    expect(
      validateGoalResume({
        manifest: goal,
        checkpoint,
        cursor,
        current: { ...base, latestCheckpointSequence: 2 },
      }),
    ).toEqual({ ok: false, reason: 'checkpoint_stale' });

    const forgedCheckpoint = {
      ...checkpoint,
      sequence: 2,
      previousSequence: null,
    };
    const forgedCursor = {
      ...cursor,
      checkpointSequence: 2,
    };
    expect(
      validateGoalResume({
        manifest: goal,
        checkpoint: forgedCheckpoint,
        cursor: forgedCursor,
        current: { ...base, latestCheckpointSequence: 2 },
      }),
    ).toEqual({ ok: false, reason: 'checkpoint_stale' });
  });
});

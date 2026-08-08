import { describe, expect, it } from 'vitest';
import { createGoalCheckpoint, createGoalManifest } from './goalCheckpoint';
import { verifyTruthfulCompletion, type CanonicalCriterionEvidenceV1 } from './truthfulCompletion';

function fixture() {
  const manifest = createGoalManifest({
    id: 'goal-completion',
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    repoRoot: 'C:\\workspace',
    branch: 'feature/authority',
    headSha: 'a'.repeat(40),
    objective: 'Verify completion truthfully.',
    criteria: [
      { id: 'tests', description: 'Focused tests pass.', mandatory: true },
      { id: 'types', description: 'TypeScript passes.', mandatory: true },
      { id: 'optional-docs', description: 'Optional notes exist.', mandatory: false },
    ],
    ownership: { ownedPaths: ['owned.ts'], exclusions: ['excluded.ts'] },
    authorityVersion: 1,
    issuedAt: 1_000,
    expiresAt: 10_000,
  });
  const checkpoint = createGoalCheckpoint({
    manifest,
    previous: null,
    state: 'ready_for_completion',
    completedCriteriaIds: ['tests', 'types'],
    evidenceRefs: ['jresult_tests', 'jlive_types'],
    finalMutationAt: 2_000,
    createdAt: 2_100,
  });
  const evidence: CanonicalCriterionEvidenceV1[] = [
    {
      schemaVersion: 1,
      criterionId: 'tests',
      status: 'satisfied',
      source: 'canonical',
      evidenceRef: 'jresult_tests',
      observedAt: 2_010,
    },
    {
      schemaVersion: 1,
      criterionId: 'types',
      status: 'satisfied',
      source: 'canonical',
      evidenceRef: 'jlive_types',
      observedAt: 2_020,
    },
  ];
  return { manifest, checkpoint, evidence };
}

describe('truthful goal completion', () => {
  it('verifies every mandatory criterion only from canonical post-mutation evidence', () => {
    const input = fixture();

    expect(verifyTruthfulCompletion(input)).toEqual({
      ok: true,
      manifestId: 'goal-completion',
      checkpointSequence: 1,
      evidenceRefs: ['jresult_tests', 'jlive_types'],
      verifiedAt: 2_020,
    });
  });

  it.each([
    [
      'missing',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        evidence: input.evidence.filter(({ criterionId }) => criterionId !== 'types'),
      }),
      'missing_evidence',
    ],
    [
      'failed',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        evidence: input.evidence.map((value) =>
          value.criterionId === 'types' ? { ...value, status: 'failed' as const } : value,
        ),
      }),
      'failed_evidence',
    ],
    [
      'stale',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        evidence: input.evidence.map((value) =>
          value.criterionId === 'types' ? { ...value, observedAt: 2_000 } : value,
        ),
      }),
      'stale_evidence',
    ],
    [
      'self-attested',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        evidence: input.evidence.map((value) =>
          value.criterionId === 'types' ? { ...value, source: 'self_attested' as const } : value,
        ),
      }),
      'untrusted_evidence',
    ],
  ] as const)('rejects %s mandatory evidence', (_label, mutate, reason) => {
    expect(verifyTruthfulCompletion(mutate(fixture()))).toEqual({ ok: false, reason });
  });

  it('rejects criteria absent from the checkpoint and noncanonical evidence references', () => {
    const input = fixture();
    expect(
      verifyTruthfulCompletion({
        ...input,
        checkpoint: {
          ...input.checkpoint,
          completedCriteriaIds: ['tests'],
        },
      }),
    ).toEqual({ ok: false, reason: 'criterion_not_checkpointed' });
    expect(
      verifyTruthfulCompletion({
        ...input,
        evidence: input.evidence.map((value) =>
          value.criterionId === 'types'
            ? { ...value, evidenceRef: 'summary:self-attested' }
            : value,
        ),
      }),
    ).toEqual({ ok: false, reason: 'untrusted_evidence' });
  });

  it('rejects non-finite mutation and evidence timestamps instead of bypassing freshness', () => {
    const input = fixture();
    expect(
      verifyTruthfulCompletion({
        ...input,
        checkpoint: { ...input.checkpoint, finalMutationAt: Number.NaN },
      }),
    ).toEqual({ ok: false, reason: 'checkpoint_not_ready' });
    expect(
      verifyTruthfulCompletion({
        ...input,
        evidence: input.evidence.map((value) =>
          value.criterionId === 'types' ? { ...value, observedAt: Number.NaN } : value,
        ),
      }),
    ).toEqual({ ok: false, reason: 'untrusted_evidence' });
  });
});

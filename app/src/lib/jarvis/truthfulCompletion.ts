import type { GoalCheckpointV1, GoalManifestV1 } from './goalCheckpoint';

export type CanonicalCriterionEvidenceV1 = Readonly<{
  schemaVersion: 1;
  criterionId: string;
  status: 'satisfied' | 'failed';
  source: 'canonical' | 'self_attested';
  evidenceRef: string;
  observedAt: number;
}>;

export type TruthfulCompletionResult =
  | Readonly<{
      ok: true;
      manifestId: string;
      checkpointSequence: number;
      evidenceRefs: readonly string[];
      verifiedAt: number;
    }>
  | Readonly<{
      ok: false;
      reason:
        | 'checkpoint_not_ready'
        | 'criterion_not_checkpointed'
        | 'missing_evidence'
        | 'failed_evidence'
        | 'stale_evidence'
        | 'untrusted_evidence';
    }>;

const CANONICAL_EVIDENCE = /^j(?:result|live)_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

function invalidCheckpoint(manifest: GoalManifestV1, checkpoint: GoalCheckpointV1): boolean {
  return (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.manifestId !== manifest.id ||
    checkpoint.accountId !== manifest.accountId ||
    checkpoint.projectId !== manifest.projectId ||
    checkpoint.runId !== manifest.runId ||
    checkpoint.repoRoot !== manifest.repoRoot ||
    checkpoint.branch !== manifest.branch ||
    checkpoint.headSha !== manifest.headSha ||
    checkpoint.authorityVersion !== manifest.authorityVersion ||
    !Number.isFinite(checkpoint.finalMutationAt) ||
    checkpoint.finalMutationAt < 0 ||
    checkpoint.state !== 'ready_for_completion'
  );
}

function failure(reason: Extract<TruthfulCompletionResult, { ok: false }>['reason']) {
  return Object.freeze({ ok: false as const, reason });
}

export function verifyTruthfulCompletion(input: {
  manifest: GoalManifestV1;
  checkpoint: GoalCheckpointV1;
  evidence: readonly CanonicalCriterionEvidenceV1[];
}): TruthfulCompletionResult {
  if (invalidCheckpoint(input.manifest, input.checkpoint)) {
    return failure('checkpoint_not_ready');
  }
  const mandatory = input.manifest.criteria.filter(({ mandatory }) => mandatory);
  const checkpointed = new Set(input.checkpoint.completedCriteriaIds);
  if (mandatory.some(({ id }) => !checkpointed.has(id))) {
    return failure('criterion_not_checkpointed');
  }
  const evidenceByCriterion = new Map<string, CanonicalCriterionEvidenceV1>();
  for (const evidence of input.evidence) {
    if (
      evidence.schemaVersion !== 1 ||
      evidence.source !== 'canonical' ||
      !Number.isFinite(evidence.observedAt) ||
      evidence.observedAt < 0 ||
      !CANONICAL_EVIDENCE.test(evidence.evidenceRef)
    ) {
      return failure('untrusted_evidence');
    }
    if (evidenceByCriterion.has(evidence.criterionId)) {
      return failure('untrusted_evidence');
    }
    evidenceByCriterion.set(evidence.criterionId, evidence);
  }

  const accepted: CanonicalCriterionEvidenceV1[] = [];
  for (const criterion of mandatory) {
    const evidence = evidenceByCriterion.get(criterion.id);
    if (!evidence) return failure('missing_evidence');
    if (evidence.status !== 'satisfied') return failure('failed_evidence');
    if (evidence.observedAt <= input.checkpoint.finalMutationAt) {
      return failure('stale_evidence');
    }
    if (!input.checkpoint.evidenceRefs.includes(evidence.evidenceRef)) {
      return failure('untrusted_evidence');
    }
    accepted.push(evidence);
  }
  const evidenceRefs = Object.freeze(accepted.map(({ evidenceRef }) => evidenceRef));
  return Object.freeze({
    ok: true,
    manifestId: input.manifest.id,
    checkpointSequence: input.checkpoint.sequence,
    evidenceRefs,
    verifiedAt: Math.max(...accepted.map(({ observedAt }) => observedAt)),
  });
}

export type GoalCriterionV1 = Readonly<{
  id: string;
  description: string;
  mandatory: boolean;
}>;

export type GoalOwnershipV1 = Readonly<{
  ownedPaths: readonly string[];
  exclusions: readonly string[];
}>;

export type GoalManifestV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  accountId: string;
  projectId: string;
  runId: string;
  repoRoot: string;
  branch: string;
  headSha: string;
  objective: string;
  criteria: readonly GoalCriterionV1[];
  ownership: GoalOwnershipV1;
  authorityVersion: number;
  issuedAt: number;
  expiresAt: number;
}>;

export type GoalCheckpointState = 'running' | 'blocked' | 'ready_for_completion';

export type GoalCheckpointV1 = Readonly<{
  schemaVersion: 1;
  manifestId: string;
  accountId: string;
  projectId: string;
  runId: string;
  repoRoot: string;
  branch: string;
  headSha: string;
  authorityVersion: number;
  sequence: number;
  previousSequence: number | null;
  state: GoalCheckpointState;
  completedCriteriaIds: readonly string[];
  evidenceRefs: readonly string[];
  finalMutationAt: number;
  createdAt: number;
}>;

export type GoalResumeCursorV1 = Readonly<{
  schemaVersion: 1;
  manifestId: string;
  checkpointSequence: number;
  accountId: string;
  projectId: string;
  runId: string;
  repoRoot: string;
  branch: string;
  headSha: string;
  authorityVersion: number;
  issuedAt: number;
  expiresAt: number;
}>;

export type GoalResumeCurrentAuthority = Readonly<{
  accountId: string;
  projectId: string;
  repoRoot: string;
  branch: string;
  headSha: string;
  authorityVersion: number;
  latestCheckpointSequence: number;
  now: number;
}>;

export type GoalResumeValidation =
  | Readonly<{ ok: true; manifest: GoalManifestV1; checkpoint: GoalCheckpointV1 }>
  | Readonly<{
      ok: false;
      reason: 'scope_mismatch' | 'authority_expired' | 'authority_stale' | 'checkpoint_stale';
    }>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const EVIDENCE_REF = /^j(?:result|live)_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const STATES = new Set<GoalCheckpointState>(['running', 'blocked', 'ready_for_completion']);

function stableText(value: unknown, maximum = 2_000): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function uniqueStable(values: readonly string[], maximumItems = 500): readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length > maximumItems ||
    values.some((value) => !stableText(value))
  ) {
    throw new Error('Invalid goal checkpoint collection.');
  }
  const copied = [...values];
  if (new Set(copied).size !== copied.length) {
    throw new Error('Invalid duplicate goal checkpoint value.');
  }
  return Object.freeze(copied);
}

function assertManifestIdentity(manifest: GoalManifestV1): void {
  if (
    manifest.schemaVersion !== 1 ||
    !IDENTIFIER.test(manifest.id) ||
    !IDENTIFIER.test(manifest.accountId) ||
    !IDENTIFIER.test(manifest.projectId) ||
    !IDENTIFIER.test(manifest.runId) ||
    !stableText(manifest.repoRoot) ||
    !stableText(manifest.branch) ||
    !GIT_HEAD.test(manifest.headSha) ||
    !positiveInteger(manifest.authorityVersion) ||
    !timestamp(manifest.issuedAt) ||
    !timestamp(manifest.expiresAt) ||
    manifest.expiresAt <= manifest.issuedAt
  ) {
    throw new Error('Invalid goal manifest authority.');
  }
}

function checkpointMatchesManifest(
  checkpoint: GoalCheckpointV1,
  manifest: GoalManifestV1,
): boolean {
  return (
    checkpoint.schemaVersion === 1 &&
    checkpoint.manifestId === manifest.id &&
    checkpoint.accountId === manifest.accountId &&
    checkpoint.projectId === manifest.projectId &&
    checkpoint.runId === manifest.runId &&
    checkpoint.repoRoot === manifest.repoRoot &&
    checkpoint.branch === manifest.branch &&
    checkpoint.headSha === manifest.headSha &&
    checkpoint.authorityVersion === manifest.authorityVersion
  );
}

export function createGoalManifest(input: Omit<GoalManifestV1, 'schemaVersion'>): GoalManifestV1 {
  const criteria = input.criteria.map((criterion) => {
    if (
      !IDENTIFIER.test(criterion.id) ||
      !stableText(criterion.description) ||
      typeof criterion.mandatory !== 'boolean'
    ) {
      throw new Error('Invalid goal criterion.');
    }
    return Object.freeze({ ...criterion });
  });
  if (
    !stableText(input.objective) ||
    criteria.length === 0 ||
    !criteria.some(({ mandatory }) => mandatory) ||
    new Set(criteria.map(({ id }) => id)).size !== criteria.length
  ) {
    throw new Error('Invalid goal manifest objective or criteria.');
  }
  const manifest = {
    ...input,
    schemaVersion: 1 as const,
    criteria: Object.freeze(criteria),
    ownership: Object.freeze({
      ownedPaths: uniqueStable(input.ownership.ownedPaths),
      exclusions: uniqueStable(input.ownership.exclusions),
    }),
  };
  assertManifestIdentity(manifest);
  return Object.freeze(manifest);
}

export function createGoalCheckpoint(input: {
  manifest: GoalManifestV1;
  previous: GoalCheckpointV1 | null;
  state: GoalCheckpointState;
  completedCriteriaIds: readonly string[];
  evidenceRefs: readonly string[];
  finalMutationAt: number;
  createdAt: number;
}): GoalCheckpointV1 {
  assertManifestIdentity(input.manifest);
  if (
    !STATES.has(input.state) ||
    !timestamp(input.finalMutationAt) ||
    !timestamp(input.createdAt) ||
    input.createdAt < input.finalMutationAt
  ) {
    throw new Error('Invalid goal checkpoint state or timestamp.');
  }
  if (
    input.previous &&
    (!checkpointMatchesManifest(input.previous, input.manifest) ||
      !positiveInteger(input.previous.sequence) ||
      input.previous.createdAt > input.createdAt)
  ) {
    throw new Error('Invalid previous goal checkpoint.');
  }
  const completedCriteriaIds = uniqueStable(input.completedCriteriaIds);
  const criterionIds = new Set(input.manifest.criteria.map(({ id }) => id));
  if (completedCriteriaIds.some((id) => !criterionIds.has(id))) {
    throw new Error('Unknown completed goal criterion.');
  }
  const evidenceRefs = uniqueStable(input.evidenceRefs);
  if (evidenceRefs.some((reference) => !EVIDENCE_REF.test(reference))) {
    throw new Error('Invalid goal checkpoint evidence reference.');
  }
  const previousSequence = input.previous?.sequence ?? null;
  return Object.freeze({
    schemaVersion: 1,
    manifestId: input.manifest.id,
    accountId: input.manifest.accountId,
    projectId: input.manifest.projectId,
    runId: input.manifest.runId,
    repoRoot: input.manifest.repoRoot,
    branch: input.manifest.branch,
    headSha: input.manifest.headSha,
    authorityVersion: input.manifest.authorityVersion,
    sequence: previousSequence === null ? 1 : previousSequence + 1,
    previousSequence,
    state: input.state,
    completedCriteriaIds,
    evidenceRefs,
    finalMutationAt: input.finalMutationAt,
    createdAt: input.createdAt,
  });
}

export function createGoalResumeCursor(input: {
  manifest: GoalManifestV1;
  checkpoint: GoalCheckpointV1;
  issuedAt: number;
  expiresAt: number;
}): GoalResumeCursorV1 {
  assertManifestIdentity(input.manifest);
  if (
    !checkpointMatchesManifest(input.checkpoint, input.manifest) ||
    !positiveInteger(input.checkpoint.sequence) ||
    !timestamp(input.issuedAt) ||
    !timestamp(input.expiresAt) ||
    input.issuedAt < input.checkpoint.createdAt ||
    input.expiresAt <= input.issuedAt ||
    input.expiresAt > input.manifest.expiresAt
  ) {
    throw new Error('Invalid goal resume cursor.');
  }
  return Object.freeze({
    schemaVersion: 1,
    manifestId: input.manifest.id,
    checkpointSequence: input.checkpoint.sequence,
    accountId: input.manifest.accountId,
    projectId: input.manifest.projectId,
    runId: input.manifest.runId,
    repoRoot: input.manifest.repoRoot,
    branch: input.manifest.branch,
    headSha: input.manifest.headSha,
    authorityVersion: input.manifest.authorityVersion,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
}

export function validateGoalResume(input: {
  manifest: GoalManifestV1;
  checkpoint: GoalCheckpointV1;
  cursor: GoalResumeCursorV1;
  current: GoalResumeCurrentAuthority;
}): GoalResumeValidation {
  const { manifest, checkpoint, cursor, current } = input;
  const scopeMatches =
    checkpointMatchesManifest(checkpoint, manifest) &&
    cursor.schemaVersion === 1 &&
    cursor.manifestId === manifest.id &&
    cursor.accountId === manifest.accountId &&
    cursor.projectId === manifest.projectId &&
    cursor.runId === manifest.runId &&
    cursor.repoRoot === manifest.repoRoot &&
    cursor.branch === manifest.branch &&
    cursor.headSha === manifest.headSha &&
    current.accountId === manifest.accountId &&
    current.projectId === manifest.projectId &&
    current.repoRoot === manifest.repoRoot &&
    current.branch === manifest.branch &&
    current.headSha === manifest.headSha;
  if (!scopeMatches) return Object.freeze({ ok: false, reason: 'scope_mismatch' });
  if (current.now >= manifest.expiresAt || current.now >= cursor.expiresAt) {
    return Object.freeze({ ok: false, reason: 'authority_expired' });
  }
  if (
    current.authorityVersion !== manifest.authorityVersion ||
    cursor.authorityVersion !== manifest.authorityVersion
  ) {
    return Object.freeze({ ok: false, reason: 'authority_stale' });
  }
  if (
    !positiveInteger(checkpoint.sequence) ||
    (checkpoint.sequence === 1
      ? checkpoint.previousSequence !== null
      : checkpoint.previousSequence !== checkpoint.sequence - 1) ||
    cursor.checkpointSequence !== checkpoint.sequence ||
    current.latestCheckpointSequence !== checkpoint.sequence
  ) {
    return Object.freeze({ ok: false, reason: 'checkpoint_stale' });
  }
  return Object.freeze({ ok: true, manifest, checkpoint });
}

export type CodingRunSourceKind =
  | 'repository_file'
  | 'repository_symbol'
  | 'context_map'
  | 'memory'
  | 'user_attachment';

export type CodingRunFileOperation = 'create' | 'modify' | 'delete';

export type CodingRunSourceReceipt = Readonly<{
  id: string;
  kind: CodingRunSourceKind;
  locator: string;
  sha256: string;
  tokenCost: number;
  selectionReason: string;
}>;

export type CodingRunWorkItemReceipt = Readonly<{
  id: string;
  ownerId: string;
  objective: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  dependencyIds: readonly string[];
}>;

export type CodingRunFileClaim = Readonly<{
  path: string;
  ownerId: string;
  access: 'read' | 'write';
}>;

export type CodingRunPatchArtifact = Readonly<{
  id: string;
  path: string;
  operation: CodingRunFileOperation;
  baseSha256: string | null;
  resultSha256: string | null;
  artifactRef: string;
  appliedAt: number | null;
}>;

export type CodingRunCommandReceipt = Readonly<{
  id: string;
  executable: string;
  argumentsHash: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number;
  resultRef: string;
}>;

export type CodingRunTestReceipt = Readonly<{
  id: string;
  commandReceiptId: string;
  status: 'passed' | 'failed' | 'skipped';
  resultRef: string;
}>;

export type CodingRunApprovalReceipt = Readonly<{
  id: string;
  capabilityId: string;
  state: 'approved' | 'denied' | 'expired' | 'revoked';
  evidenceRef: string;
}>;

export type CodingRunRollbackReceipt = Readonly<{
  patchArtifactId: string;
  state: 'available' | 'applied' | 'expired';
  artifactRef: string;
  verifiedSha256: string | null;
}>;

export type CodingRunManifestV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  accountId: string;
  projectId: string;
  repositoryRoot: string;
  repositoryBranch: string;
  repositoryCommit: string;
  contextMapRevision: number;
  selectedSources: readonly CodingRunSourceReceipt[];
  workItems: readonly CodingRunWorkItemReceipt[];
  fileClaims: readonly CodingRunFileClaim[];
  patches: readonly CodingRunPatchArtifact[];
  commands: readonly CodingRunCommandReceipt[];
  tests: readonly CodingRunTestReceipt[];
  approvals: readonly CodingRunApprovalReceipt[];
  outputArtifacts: readonly string[];
  checkpointId: string | null;
  rollback: readonly CodingRunRollbackReceipt[];
  createdAt: number;
  updatedAt: number;
}>;

export type CodingRunCompletionAudit = Readonly<
  | { ready: true; evidenceRefs: readonly string[] }
  | {
      ready: false;
      reasons: readonly (
        | 'work_incomplete'
        | 'patch_unapplied'
        | 'patch_unverified'
        | 'test_failed'
        | 'approval_unresolved'
        | 'checkpoint_missing'
        | 'rollback_missing'
      )[];
    }
>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/iu;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const EVIDENCE_REF = /^j(?:result|live|artifact|checkpoint)_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/u;
const RELATIVE_PATH =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*:).{1,1024}$/u;
const SOURCE_KINDS = new Set<CodingRunSourceKind>([
  'repository_file',
  'repository_symbol',
  'context_map',
  'memory',
  'user_attachment',
]);
const WORK_STATES = new Set<CodingRunWorkItemReceipt['status']>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
const PATCH_OPERATIONS = new Set<CodingRunFileOperation>(['create', 'modify', 'delete']);
const TEST_STATES = new Set<CodingRunTestReceipt['status']>(['passed', 'failed', 'skipped']);
const APPROVAL_STATES = new Set<CodingRunApprovalReceipt['state']>([
  'approved',
  'denied',
  'expired',
  'revoked',
]);
const ROLLBACK_STATES = new Set<CodingRunRollbackReceipt['state']>([
  'available',
  'applied',
  'expired',
]);

function stableText(value: unknown, maximum = 2_000): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL_BYTES.test(value)
  );
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function evidenceRef(value: unknown): value is string {
  return typeof value === 'string' && EVIDENCE_REF.test(value);
}

function canonicalClaimPath(path: string, windows: boolean): string {
  const portable = path.replace(/\\/gu, '/');
  if (!stableText(path, 1_024) || !RELATIVE_PATH.test(portable)) {
    throw new Error('Invalid coding-run file claim.');
  }
  const segments = portable.normalize('NFKC').split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' '),
    )
  ) {
    throw new Error('Invalid coding-run file claim.');
  }
  const normalized = segments.join('/');
  return windows ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function unique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  if (new Set(values.map(key)).size !== values.length) {
    throw new Error(`Duplicate coding-run ${label}.`);
  }
}

function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze({ ...value });
}

function freezeManifest(input: CodingRunManifestV1): CodingRunManifestV1 {
  return Object.freeze({
    ...input,
    selectedSources: Object.freeze(input.selectedSources.map(immutable)),
    workItems: Object.freeze(
      input.workItems.map((item) =>
        Object.freeze({ ...item, dependencyIds: Object.freeze([...item.dependencyIds]) }),
      ),
    ),
    fileClaims: Object.freeze(input.fileClaims.map(immutable)),
    patches: Object.freeze(input.patches.map(immutable)),
    commands: Object.freeze(input.commands.map(immutable)),
    tests: Object.freeze(input.tests.map(immutable)),
    approvals: Object.freeze(input.approvals.map(immutable)),
    outputArtifacts: Object.freeze([...input.outputArtifacts]),
    rollback: Object.freeze(input.rollback.map(immutable)),
  });
}

export function createCodingRunManifest(
  input: Omit<CodingRunManifestV1, 'schemaVersion'>,
): CodingRunManifestV1 {
  if (
    !IDENTIFIER.test(input.runId) ||
    !IDENTIFIER.test(input.accountId) ||
    !IDENTIFIER.test(input.projectId) ||
    !stableText(input.repositoryRoot) ||
    !stableText(input.repositoryBranch) ||
    !GIT_COMMIT.test(input.repositoryCommit) ||
    !Number.isSafeInteger(input.contextMapRevision) ||
    input.contextMapRevision < 0 ||
    !timestamp(input.createdAt) ||
    !timestamp(input.updatedAt) ||
    input.updatedAt < input.createdAt
  ) {
    throw new Error('Invalid coding-run identity or authority.');
  }

  unique(input.selectedSources, ({ id }) => id, 'source id');
  unique(input.workItems, ({ id }) => id, 'work item id');
  unique(input.patches, ({ id }) => id, 'patch id');
  unique(input.commands, ({ id }) => id, 'command id');
  unique(input.tests, ({ id }) => id, 'test id');
  unique(input.approvals, ({ id }) => id, 'approval id');
  unique(
    input.fileClaims,
    ({ ownerId, path }) => `${ownerId}\u0000${path}`,
    'file claim',
  );
  unique(input.rollback, ({ patchArtifactId }) => patchArtifactId, 'rollback receipt');
  unique(input.outputArtifacts, (value) => value, 'output artifact');

  const workItemIds = new Set(input.workItems.map(({ id }) => id));
  for (const item of input.workItems) {
    if (
      !IDENTIFIER.test(item.id) ||
      !IDENTIFIER.test(item.ownerId) ||
      !stableText(item.objective) ||
      !WORK_STATES.has(item.status) ||
      item.dependencyIds.some(
        (dependencyId) => dependencyId === item.id || !workItemIds.has(dependencyId),
      ) ||
      new Set(item.dependencyIds).size !== item.dependencyIds.length
    ) {
      throw new Error('Invalid coding-run work item.');
    }
  }

  for (const source of input.selectedSources) {
    if (
      !IDENTIFIER.test(source.id) ||
      !SOURCE_KINDS.has(source.kind) ||
      !stableText(source.locator) ||
      !sha256(source.sha256) ||
      !Number.isSafeInteger(source.tokenCost) ||
      source.tokenCost < 0 ||
      !stableText(source.selectionReason)
    ) {
      throw new Error('Invalid coding-run source receipt.');
    }
  }

  const claimsByPath = new Map<string, CodingRunFileClaim[]>();
  const windowsRoot = /^[A-Za-z]:\\/u.test(input.repositoryRoot) || input.repositoryRoot.startsWith('\\\\');
  for (const claim of input.fileClaims) {
    if (
      !IDENTIFIER.test(claim.ownerId) ||
      (claim.access !== 'read' && claim.access !== 'write')
    ) {
      throw new Error('Invalid coding-run file claim.');
    }
    const canonicalPath = canonicalClaimPath(claim.path, windowsRoot);
    const claims = claimsByPath.get(canonicalPath) ?? [];
    claims.push(claim);
    claimsByPath.set(canonicalPath, claims);
  }
  for (const claims of claimsByPath.values()) {
    const writers = claims.filter(({ access }) => access === 'write');
    if (writers.length > 1 || (writers.length === 1 && claims.length > 1)) {
      throw new Error('Conflicting coding-run file claims.');
    }
  }

  const writablePaths = new Set(
    input.fileClaims
      .filter(({ access }) => access === 'write')
      .map(({ path }) => canonicalClaimPath(path, windowsRoot)),
  );
  for (const patch of input.patches) {
    const baseValid = patch.baseSha256 === null || sha256(patch.baseSha256);
    const resultValid = patch.resultSha256 === null || sha256(patch.resultSha256);
    if (
      !IDENTIFIER.test(patch.id) ||
      !PATCH_OPERATIONS.has(patch.operation) ||
      !writablePaths.has(canonicalClaimPath(patch.path, windowsRoot)) ||
      !baseValid ||
      !resultValid ||
      !evidenceRef(patch.artifactRef) ||
      (patch.appliedAt !== null && !timestamp(patch.appliedAt)) ||
      (patch.operation === 'create' && patch.baseSha256 !== null) ||
      (patch.operation === 'delete' && patch.resultSha256 !== null) ||
      (patch.operation === 'modify' &&
        (patch.baseSha256 === null ||
          patch.resultSha256 === null ||
          patch.baseSha256.toLowerCase() === patch.resultSha256.toLowerCase()))
    ) {
      throw new Error('Invalid coding-run patch artifact.');
    }
  }

  const commandIds = new Set(input.commands.map(({ id }) => id));
  for (const command of input.commands) {
    if (
      !IDENTIFIER.test(command.id) ||
      !stableText(command.executable) ||
      !sha256(command.argumentsHash) ||
      !stableText(command.cwd) ||
      !timestamp(command.startedAt) ||
      !timestamp(command.finishedAt) ||
      command.finishedAt < command.startedAt ||
      !Number.isSafeInteger(command.exitCode) ||
      !evidenceRef(command.resultRef)
    ) {
      throw new Error('Invalid coding-run command receipt.');
    }
  }
  for (const test of input.tests) {
    if (
      !IDENTIFIER.test(test.id) ||
      !commandIds.has(test.commandReceiptId) ||
      !TEST_STATES.has(test.status) ||
      !evidenceRef(test.resultRef)
    ) {
      throw new Error('Invalid coding-run test receipt.');
    }
  }
  for (const approval of input.approvals) {
    if (
      !IDENTIFIER.test(approval.id) ||
      !IDENTIFIER.test(approval.capabilityId) ||
      !APPROVAL_STATES.has(approval.state) ||
      !evidenceRef(approval.evidenceRef)
    ) {
      throw new Error('Invalid coding-run approval receipt.');
    }
  }
  for (const rollback of input.rollback) {
    const patch = input.patches.find(({ id }) => id === rollback.patchArtifactId);
    if (
      !patch ||
      !ROLLBACK_STATES.has(rollback.state) ||
      !evidenceRef(rollback.artifactRef) ||
      (rollback.verifiedSha256 !== null && !sha256(rollback.verifiedSha256)) ||
      (patch.operation === 'create'
        ? rollback.verifiedSha256 !== null
        : rollback.verifiedSha256 !== patch.baseSha256)
    ) {
      throw new Error('Invalid coding-run rollback receipt.');
    }
  }
  if (
    input.outputArtifacts.some((ref) => !evidenceRef(ref)) ||
    (input.checkpointId !== null && !evidenceRef(input.checkpointId))
  ) {
    throw new Error('Invalid coding-run evidence reference.');
  }

  return freezeManifest({ ...input, schemaVersion: 1 });
}

export function auditCodingRunCompletion(
  manifest: CodingRunManifestV1,
): CodingRunCompletionAudit {
  const manifestInput: Omit<CodingRunManifestV1, 'schemaVersion'> = manifest;
  const validated = createCodingRunManifest(manifestInput);
  const reasons = new Set<
    Exclude<CodingRunCompletionAudit, { ready: true }>['reasons'][number]
  >();
  if (validated.workItems.some(({ status }) => status !== 'completed')) {
    reasons.add('work_incomplete');
  }
  if (validated.patches.some(({ appliedAt }) => appliedAt === null)) {
    reasons.add('patch_unapplied');
  }
  if (
    validated.patches.some(
      ({ operation, baseSha256, resultSha256 }) =>
        (operation !== 'create' && baseSha256 === null) ||
        (operation !== 'delete' && resultSha256 === null),
    )
  ) {
    reasons.add('patch_unverified');
  }
  if (validated.rollback.some(({ state }) => state !== 'available')) {
    reasons.add('patch_unverified');
  }
  if (
    (validated.patches.length > 0 && validated.tests.length === 0) ||
    validated.tests.some(({ status }) => status !== 'passed')
  ) {
    reasons.add('test_failed');
  }
  if (
    (validated.patches.length > 0 && validated.approvals.length === 0) ||
    validated.approvals.some(({ state }) => state !== 'approved')
  ) {
    reasons.add('approval_unresolved');
  }
  if (validated.checkpointId === null) reasons.add('checkpoint_missing');
  const rollbackIds = new Set(validated.rollback.map(({ patchArtifactId }) => patchArtifactId));
  if (validated.patches.some(({ id }) => !rollbackIds.has(id))) {
    reasons.add('rollback_missing');
  }
  if (reasons.size > 0) {
    return Object.freeze({ ready: false as const, reasons: Object.freeze([...reasons].sort()) });
  }
  return Object.freeze({
    ready: true as const,
    evidenceRefs: Object.freeze([
      ...validated.patches.map(({ artifactRef }) => artifactRef),
      ...validated.commands.map(({ resultRef }) => resultRef),
      ...validated.tests.map(({ resultRef }) => resultRef),
      ...validated.approvals.map(({ evidenceRef }) => evidenceRef),
      ...validated.outputArtifacts,
      validated.checkpointId!,
      ...validated.rollback.map(({ artifactRef }) => artifactRef),
    ]),
  });
}

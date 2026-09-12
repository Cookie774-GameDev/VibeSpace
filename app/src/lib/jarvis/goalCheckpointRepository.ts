import {
  createGoalCheckpoint,
  createGoalManifest,
  createGoalResumeCursor,
  validateGoalResume,
  type GoalCheckpointState,
  type GoalCheckpointV1,
  type GoalManifestV1,
  type GoalResumeCurrentAuthority,
  type GoalResumeCursorV1,
  type GoalResumeValidation,
} from './goalCheckpoint';

export type GoalCheckpointStoredRecordV1 = Readonly<{
  schemaVersion: 1;
  accountId: string;
  projectId: string;
  manifestId: string;
  revision: number;
  idempotencyKey: string;
  manifest: GoalManifestV1;
  checkpoint: GoalCheckpointV1;
  cursor: GoalResumeCursorV1;
  createdAt: number;
}>;

export type GoalCheckpointStorageAppendResult =
  | Readonly<{ kind: 'appended' | 'duplicate'; record: GoalCheckpointStoredRecordV1 }>
  | Readonly<{ kind: 'conflict'; currentRevision: number }>;

export interface GoalCheckpointStoragePort {
  loadScope(accountId: string, projectId: string): Promise<readonly unknown[]>;
  appendExpected(input: {
    accountId: string;
    projectId: string;
    manifestId: string;
    expectedRevision: number;
    idempotencyKey: string;
    record: GoalCheckpointStoredRecordV1;
  }): Promise<GoalCheckpointStorageAppendResult>;
}

export type GoalCheckpointQuarantineReceipt = Readonly<{
  rowIndex: number;
  reason: 'invalid_record' | 'scope_mismatch';
  quarantineRef: string;
}>;

export type GoalCheckpointLoadResult = Readonly<{
  records: readonly GoalCheckpointStoredRecordV1[];
  quarantined: readonly GoalCheckpointQuarantineReceipt[];
}>;

export interface GoalCheckpointRepository {
  append(input: {
    manifest: GoalManifestV1;
    previous: GoalCheckpointStoredRecordV1 | null;
    expectedRevision: number;
    idempotencyKey: string;
    state: GoalCheckpointState;
    completedCriteriaIds: readonly string[];
    evidenceRefs: readonly string[];
    finalMutationAt: number;
    createdAt: number;
    cursorIssuedAt: number;
    cursorExpiresAt: number;
  }): Promise<GoalCheckpointStorageAppendResult>;
  loadScope(accountId: string, projectId: string): Promise<GoalCheckpointLoadResult>;
  validateResume(
    record: GoalCheckpointStoredRecordV1,
    current: GoalResumeCurrentAuthority,
  ): GoalResumeValidation;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2_000 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function rehydrateManifest(value: unknown): GoalManifestV1 {
  const row = recordOf(value);
  if (!row) throw new Error('invalid manifest');
  return createGoalManifest({
    id: row.id as string,
    accountId: row.accountId as string,
    projectId: row.projectId as string,
    runId: row.runId as string,
    repoRoot: row.repoRoot as string,
    branch: row.branch as string,
    headSha: row.headSha as string,
    objective: row.objective as string,
    criteria: row.criteria as GoalManifestV1['criteria'],
    ownership: row.ownership as GoalManifestV1['ownership'],
    authorityVersion: row.authorityVersion as number,
    issuedAt: row.issuedAt as number,
    expiresAt: row.expiresAt as number,
  });
}

function rehydrateCheckpoint(value: unknown): GoalCheckpointV1 {
  const row = recordOf(value);
  if (
    !row ||
    row.schemaVersion !== 1 ||
    !stableText(row.manifestId) ||
    !stableText(row.accountId) ||
    !stableText(row.projectId) ||
    !stableText(row.runId) ||
    !stableText(row.repoRoot) ||
    !stableText(row.branch) ||
    !stableText(row.headSha) ||
    !positiveInteger(row.authorityVersion) ||
    !positiveInteger(row.sequence) ||
    (row.previousSequence !== null && !positiveInteger(row.previousSequence)) ||
    !['running', 'blocked', 'ready_for_completion'].includes(row.state as string) ||
    !Array.isArray(row.completedCriteriaIds) ||
    !Array.isArray(row.evidenceRefs) ||
    !Number.isFinite(row.finalMutationAt) ||
    !Number.isFinite(row.createdAt)
  ) {
    throw new Error('invalid checkpoint');
  }
  const copy = structuredClone(row) as unknown as GoalCheckpointV1;
  Object.freeze(copy.completedCriteriaIds);
  Object.freeze(copy.evidenceRefs);
  return Object.freeze(copy);
}

function rehydrateCursor(value: unknown): GoalResumeCursorV1 {
  const row = recordOf(value);
  if (
    !row ||
    row.schemaVersion !== 1 ||
    !stableText(row.manifestId) ||
    !positiveInteger(row.checkpointSequence) ||
    !stableText(row.accountId) ||
    !stableText(row.projectId) ||
    !stableText(row.runId) ||
    !stableText(row.repoRoot) ||
    !stableText(row.branch) ||
    !stableText(row.headSha) ||
    !positiveInteger(row.authorityVersion) ||
    !Number.isFinite(row.issuedAt) ||
    !Number.isFinite(row.expiresAt)
  ) {
    throw new Error('invalid cursor');
  }
  return Object.freeze(structuredClone(row) as unknown as GoalResumeCursorV1);
}

function rehydrateRecord(value: unknown): GoalCheckpointStoredRecordV1 {
  const row = recordOf(value);
  if (
    !row ||
    row.schemaVersion !== 1 ||
    !stableText(row.accountId) ||
    !stableText(row.projectId) ||
    !stableText(row.manifestId) ||
    !positiveInteger(row.revision) ||
    !stableText(row.idempotencyKey) ||
    !Number.isFinite(row.createdAt)
  ) {
    throw new Error('invalid record');
  }
  const manifest = rehydrateManifest(row.manifest);
  const checkpoint = rehydrateCheckpoint(row.checkpoint);
  const cursor = rehydrateCursor(row.cursor);
  if (
    row.accountId !== manifest.accountId ||
    row.projectId !== manifest.projectId ||
    row.manifestId !== manifest.id ||
    row.revision !== checkpoint.sequence ||
    row.createdAt !== checkpoint.createdAt
  ) {
    throw new Error('invalid record binding');
  }
  const validation = validateGoalResume({
    manifest,
    checkpoint,
    cursor,
    current: {
      accountId: manifest.accountId,
      projectId: manifest.projectId,
      repoRoot: manifest.repoRoot,
      branch: manifest.branch,
      headSha: manifest.headSha,
      authorityVersion: manifest.authorityVersion,
      latestCheckpointSequence: checkpoint.sequence,
      now: cursor.issuedAt,
    },
  });
  if (!validation.ok) throw new Error('invalid resume binding');
  return Object.freeze({
    schemaVersion: 1,
    accountId: manifest.accountId,
    projectId: manifest.projectId,
    manifestId: manifest.id,
    revision: row.revision,
    idempotencyKey: row.idempotencyKey,
    manifest,
    checkpoint,
    cursor,
    createdAt: row.createdAt,
  });
}

function quarantine(
  accountId: string,
  projectId: string,
  rowIndex: number,
  reason: GoalCheckpointQuarantineReceipt['reason'],
): GoalCheckpointQuarantineReceipt {
  return Object.freeze({
    rowIndex,
    reason,
    quarantineRef: `goal-quarantine:${accountId}:${projectId}:${rowIndex}`,
  });
}

export function createGoalCheckpointRepository(
  storage: GoalCheckpointStoragePort,
): GoalCheckpointRepository {
  const repository: GoalCheckpointRepository = {
    async append(input) {
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        !stableText(input.idempotencyKey)
      ) {
        throw new Error('Invalid checkpoint append authority.');
      }
      if (
        input.previous &&
        (input.previous.manifestId !== input.manifest.id ||
          input.previous.accountId !== input.manifest.accountId ||
          input.previous.projectId !== input.manifest.projectId ||
          input.previous.revision !== input.expectedRevision)
      ) {
        throw new Error('Invalid previous checkpoint revision.');
      }
      const checkpoint = createGoalCheckpoint({
        manifest: input.manifest,
        previous: input.previous?.checkpoint ?? null,
        state: input.state,
        completedCriteriaIds: input.completedCriteriaIds,
        evidenceRefs: input.evidenceRefs,
        finalMutationAt: input.finalMutationAt,
        createdAt: input.createdAt,
      });
      const cursor = createGoalResumeCursor({
        manifest: input.manifest,
        checkpoint,
        issuedAt: input.cursorIssuedAt,
        expiresAt: input.cursorExpiresAt,
      });
      const record = Object.freeze({
        schemaVersion: 1 as const,
        accountId: input.manifest.accountId,
        projectId: input.manifest.projectId,
        manifestId: input.manifest.id,
        revision: input.expectedRevision + 1,
        idempotencyKey: input.idempotencyKey,
        manifest: input.manifest,
        checkpoint,
        cursor,
        createdAt: input.createdAt,
      });
      const result = await storage.appendExpected({
        accountId: record.accountId,
        projectId: record.projectId,
        manifestId: record.manifestId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        record,
      });
      if (result.kind === 'conflict') return Object.freeze({ ...result });
      const returned = rehydrateRecord(result.record);
      if (
        returned.accountId !== record.accountId ||
        returned.projectId !== record.projectId ||
        returned.manifestId !== record.manifestId ||
        returned.idempotencyKey !== record.idempotencyKey
      ) {
        throw new Error('Storage returned a mismatched checkpoint record.');
      }
      return Object.freeze({ kind: result.kind, record: returned });
    },

    async loadScope(accountId, projectId) {
      if (!stableText(accountId) || !stableText(projectId)) {
        throw new Error('Invalid checkpoint repository scope.');
      }
      const rawRows = await storage.loadScope(accountId, projectId);
      const candidates: Array<{ rowIndex: number; record: GoalCheckpointStoredRecordV1 }> = [];
      const quarantined: GoalCheckpointQuarantineReceipt[] = [];
      rawRows.forEach((raw, rowIndex) => {
        const rawRecord = recordOf(raw);
        if (
          rawRecord &&
          stableText(rawRecord.accountId) &&
          stableText(rawRecord.projectId) &&
          (rawRecord.accountId !== accountId || rawRecord.projectId !== projectId)
        ) {
          quarantined.push(quarantine(accountId, projectId, rowIndex, 'scope_mismatch'));
          return;
        }
        try {
          candidates.push({ rowIndex, record: rehydrateRecord(raw) });
        } catch {
          quarantined.push(quarantine(accountId, projectId, rowIndex, 'invalid_record'));
        }
      });
      candidates.sort(
        (left, right) =>
          left.record.manifestId.localeCompare(right.record.manifestId) ||
          left.record.revision - right.record.revision,
      );
      const records: GoalCheckpointStoredRecordV1[] = [];
      const latestRevision = new Map<string, number>();
      for (const candidate of candidates) {
        const previous = latestRevision.get(candidate.record.manifestId) ?? 0;
        if (candidate.record.revision !== previous + 1) {
          quarantined.push(quarantine(accountId, projectId, candidate.rowIndex, 'invalid_record'));
          continue;
        }
        latestRevision.set(candidate.record.manifestId, candidate.record.revision);
        records.push(candidate.record);
      }
      quarantined.sort((left, right) => left.rowIndex - right.rowIndex);
      return Object.freeze({
        records: Object.freeze(records),
        quarantined: Object.freeze(quarantined),
      });
    },

    validateResume(record, current) {
      return validateGoalResume({
        manifest: record.manifest,
        checkpoint: record.checkpoint,
        cursor: record.cursor,
        current,
      });
    },
  };
  return Object.freeze(repository);
}

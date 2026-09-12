import { db, openDb } from '@/lib/db';
import {
  createGoalCheckpointRepository,
  type GoalCheckpointRepository,
  type GoalCheckpointStorageAppendResult,
  type GoalCheckpointStoragePort,
  type GoalCheckpointStoredRecordV1,
} from './goalCheckpointRepository';

const STORAGE_PREFIX = 'jarvis-goal-checkpoints-v1:';
const MAX_SCOPE_RECORDS = 512;

type StoredCheckpointEnvelopeV1 = Readonly<{
  schemaVersion: 1;
  accountId: string;
  projectId: string;
  records: readonly GoalCheckpointStoredRecordV1[];
}>;

function boundedId(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function storageKey(accountId: string, projectId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(boundedId(accountId, 'account id'))}:${encodeURIComponent(
    boundedId(projectId, 'project id'),
  )}`;
}

function isEnvelope(
  value: unknown,
  accountId: string,
  projectId: string,
): value is StoredCheckpointEnvelopeV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredCheckpointEnvelopeV1>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.accountId === accountId &&
    candidate.projectId === projectId &&
    Array.isArray(candidate.records)
  );
}

function exactRecordIdentity(
  left: GoalCheckpointStoredRecordV1,
  right: GoalCheckpointStoredRecordV1,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.manifestId === right.manifestId &&
    left.revision === right.revision &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left) === JSON.stringify(right)
  );
}

async function ensureCheckpointDbOpen(): Promise<void> {
  await openDb();
  if (!db.isOpen()) {
    await db.open();
  }
  if (!db.isOpen()) {
    throw new Error('Goal checkpoint database is unavailable.');
  }
}

export function createDexieGoalCheckpointStorage(): GoalCheckpointStoragePort {
  const storage: GoalCheckpointStoragePort = {
    async loadScope(accountId, projectId) {
      const key = storageKey(accountId, projectId);
      await ensureCheckpointDbOpen();
      const value = (await db.settings.get(key))?.value;
      if (value === undefined) return Object.freeze([]);
      if (!isEnvelope(value, accountId, projectId)) return Object.freeze([value]);
      return Object.freeze([...value.records]);
    },

    async appendExpected(input): Promise<GoalCheckpointStorageAppendResult> {
      const accountId = boundedId(input.accountId, 'account id');
      const projectId = boundedId(input.projectId, 'project id');
      const key = storageKey(accountId, projectId);
      await ensureCheckpointDbOpen();
      return db.transaction('rw', db.settings, async () => {
        const stored = (await db.settings.get(key))?.value;
        if (stored !== undefined && !isEnvelope(stored, accountId, projectId)) {
          return Object.freeze({ kind: 'conflict' as const, currentRevision: 0 });
        }
        const envelope = isEnvelope(stored, accountId, projectId)
          ? stored
          : ({
              schemaVersion: 1,
              accountId,
              projectId,
              records: Object.freeze([]),
            } as const);
        const duplicate = envelope.records.find(
          (record) =>
            record.manifestId === input.manifestId &&
            record.idempotencyKey === input.idempotencyKey,
        );
        if (duplicate) {
          if (!exactRecordIdentity(duplicate, input.record)) {
            return Object.freeze({
              kind: 'conflict' as const,
              currentRevision: duplicate.revision,
            });
          }
          return Object.freeze({ kind: 'duplicate' as const, record: duplicate });
        }
        const currentRevision = envelope.records
          .filter((record) => record.manifestId === input.manifestId)
          .reduce((highest, record) => Math.max(highest, record.revision), 0);
        if (currentRevision !== input.expectedRevision) {
          return Object.freeze({ kind: 'conflict' as const, currentRevision });
        }
        const records = Object.freeze(
          [...envelope.records, structuredClone(input.record)].slice(-MAX_SCOPE_RECORDS),
        );
        await db.settings.put({
          key,
          value: Object.freeze({
            schemaVersion: 1 as const,
            accountId,
            projectId,
            records,
          }),
          updated_at: Date.now(),
        });
        return Object.freeze({ kind: 'appended' as const, record: input.record });
      });
    },
  };
  return Object.freeze(storage);
}

let liveRepository: GoalCheckpointRepository | undefined;

export function getLiveGoalCheckpointRepository(): GoalCheckpointRepository {
  liveRepository ??= createGoalCheckpointRepository(createDexieGoalCheckpointStorage());
  return liveRepository;
}

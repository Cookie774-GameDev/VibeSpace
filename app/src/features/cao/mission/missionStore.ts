import type { CaoMissionRow } from '@/lib/db/schema';
import type { JarvisDexie } from '@/lib/db/database';
import type {
  CaoMission,
  CaoMissionMilestone,
  CaoMissionStatus,
  CaoMissionStore,
  CaoMissionWorker,
} from './types';

type RowBackend = Readonly<{
  get(id: string): Promise<CaoMissionRow | undefined>;
  /** The production backend performs this check and insert in one transaction. */
  insertIfAbsent(row: CaoMissionRow): Promise<boolean>;
  put(row: CaoMissionRow): Promise<void>;
  /** The production backend implements this compare-and-swap inside one transaction. */
  compareAndPut?: (expected: CaoMissionRow, next: CaoMissionRow) => Promise<boolean>;
  list(accountId: string, workspaceId: string): Promise<readonly CaoMissionRow[]>;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MISSION_STATUSES: readonly CaoMissionStatus[] = [
  'planning',
  'running',
  'verifying',
  'completed',
  'failed',
  'cancelled',
];
const WORKER_STATUSES: readonly CaoMissionWorker['status'][] = [
  'assigned',
  'running',
  'waiting',
  'done',
  'failed',
  'cancelled',
];
const MILESTONE_STATUSES: readonly CaoMissionMilestone['status'][] = [
  'pending',
  'active',
  'completed',
  'failed',
];
const MISSION_KEYS = new Set([
  'id',
  'schemaVersion',
  'accountId',
  'workspaceId',
  'projectId',
  'objective',
  'createdAt',
  'updatedAt',
  'status',
  'contextMapId',
  'workers',
  'milestones',
  'latestPlanRevision',
  'lastCaoWakeAt',
  'failureReason',
]);
const WORKER_KEYS = new Set([
  'targetId',
  'kind',
  'backend',
  'connectionId',
  'modelId',
  'reasoningEffort',
  'assignment',
  'ownedPaths',
  'status',
  'lastObservedRevision',
  'proposalId',
  'approvalClaimId',
  'approvalOutcome',
  'approvalClaimedAt',
]);
const MILESTONE_KEYS = new Set(['id', 'label', 'status', 'evidenceIds']);
const ROW_KEYS = new Set([
  'id',
  'schemaVersion',
  'accountId',
  'workspaceId',
  'projectId',
  'status',
  'serializedMission',
  'createdAt',
  'updatedAt',
]);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeId(value: unknown, allowNull = false): value is string | null {
  return (allowNull && value === null) || (typeof value === 'string' && SAFE_ID.test(value));
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validWorker(value: unknown): value is CaoMissionWorker {
  const worker = recordOf(value);
  if (
    !worker ||
    !exactKeys(worker, WORKER_KEYS) ||
    !safeId(worker.targetId) ||
    (worker.kind !== 'chat' && worker.kind !== 'terminal') ||
    (worker.backend !== undefined && worker.backend !== 'codex' && worker.backend !== 'opencode') ||
    (worker.connectionId !== undefined && !safeText(worker.connectionId, 256)) ||
    (worker.modelId !== undefined && !safeText(worker.modelId, 256)) ||
    (worker.reasoningEffort !== undefined && !safeText(worker.reasoningEffort, 32)) ||
    !safeText(worker.assignment, 4096) ||
    !Array.isArray(worker.ownedPaths) ||
    worker.ownedPaths.length > 256 ||
    worker.ownedPaths.some((path) => !safeText(path, 512)) ||
    !WORKER_STATUSES.includes(worker.status as CaoMissionWorker['status']) ||
    (worker.lastObservedRevision !== null && !safeRevision(worker.lastObservedRevision)) ||
    (worker.proposalId !== undefined && !safeId(worker.proposalId, false)) ||
    (worker.approvalClaimId !== undefined && !safeId(worker.approvalClaimId, false)) ||
    (worker.approvalOutcome !== undefined &&
      !(['pending', 'delivered', 'failed'] as const).includes(
        worker.approvalOutcome as 'pending' | 'delivered' | 'failed',
      )) ||
    (worker.approvalClaimedAt !== undefined && !safeTimestamp(worker.approvalClaimedAt)) ||
    (worker.approvalClaimId !== undefined && worker.status !== 'waiting') ||
    (worker.approvalClaimedAt !== undefined) !== (worker.approvalClaimId !== undefined) ||
    (worker.approvalOutcome === 'pending') !== (worker.approvalClaimId !== undefined) ||
    (worker.approvalOutcome !== undefined && worker.status !== 'waiting') ||
    (worker.status === 'waiting') !== (worker.proposalId !== undefined)
  ) {
    return false;
  }
  return true;
}

function validMilestone(value: unknown): value is CaoMissionMilestone {
  const milestone = recordOf(value);
  return Boolean(
    milestone &&
    exactKeys(milestone, MILESTONE_KEYS) &&
    safeId(milestone.id) &&
    safeText(milestone.label, 512) &&
    MILESTONE_STATUSES.includes(milestone.status as CaoMissionMilestone['status']) &&
    Array.isArray(milestone.evidenceIds) &&
    milestone.evidenceIds.length <= 256 &&
    milestone.evidenceIds.every((id) => safeId(id)),
  );
}

function validMission(value: unknown): value is CaoMission {
  const mission = recordOf(value);
  return Boolean(
    mission &&
    exactKeys(mission, MISSION_KEYS) &&
    mission.schemaVersion === 1 &&
    safeId(mission.id) &&
    safeId(mission.accountId) &&
    safeId(mission.workspaceId) &&
    safeId(mission.projectId, true) &&
    safeText(mission.objective, 16_384) &&
    safeTimestamp(mission.createdAt) &&
    safeTimestamp(mission.updatedAt) &&
    MISSION_STATUSES.includes(mission.status as CaoMissionStatus) &&
    safeId(mission.contextMapId, true) &&
    Array.isArray(mission.workers) &&
    mission.workers.length <= 32 &&
    mission.workers.every(validWorker) &&
    Array.isArray(mission.milestones) &&
    mission.milestones.length <= 256 &&
    mission.milestones.every(validMilestone) &&
    typeof mission.latestPlanRevision === 'number' &&
    Number.isSafeInteger(mission.latestPlanRevision) &&
    mission.latestPlanRevision >= 1 &&
    (mission.lastCaoWakeAt === null || safeTimestamp(mission.lastCaoWakeAt)) &&
    (mission.failureReason === undefined || safeText(mission.failureReason, 512)),
  );
}

function validLookup(input: {
  missionId: string;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
}): void {
  if (
    !safeId(input.missionId) ||
    !safeId(input.accountId) ||
    !safeId(input.workspaceId) ||
    !safeId(input.projectId, true)
  ) {
    throw new Error('cao_mission_scope_invalid');
  }
}

function rowId(mission: Pick<CaoMission, 'id'>): string {
  return mission.id;
}

function toRow(mission: CaoMission): CaoMissionRow {
  if (!validMission(mission)) throw new Error('cao_mission_payload_invalid');
  return {
    id: rowId(mission),
    schemaVersion: 1,
    accountId: mission.accountId,
    workspaceId: mission.workspaceId,
    projectId: mission.projectId,
    status: mission.status,
    serializedMission: JSON.stringify(mission),
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

function validRowEnvelope(value: unknown): value is CaoMissionRow {
  const row = recordOf(value);
  return Boolean(
    row &&
    exactKeys(row, ROW_KEYS) &&
    row.schemaVersion === 1 &&
    safeId(row.id) &&
    safeId(row.accountId) &&
    safeId(row.workspaceId) &&
    safeId(row.projectId, true) &&
    MISSION_STATUSES.includes(row.status as CaoMissionStatus) &&
    typeof row.serializedMission === 'string' &&
    row.serializedMission.length <= 2_000_000 &&
    safeTimestamp(row.createdAt) &&
    safeTimestamp(row.updatedAt),
  );
}

function fromRow(row: CaoMissionRow): CaoMission {
  if (!validRowEnvelope(row)) throw new Error('cao_mission_payload_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.serializedMission);
  } catch {
    throw new Error('cao_mission_payload_invalid');
  }
  if (
    !validMission(parsed) ||
    parsed.id !== row.id ||
    parsed.accountId !== row.accountId ||
    parsed.workspaceId !== row.workspaceId ||
    parsed.projectId !== row.projectId ||
    parsed.status !== row.status ||
    parsed.createdAt !== row.createdAt ||
    parsed.updatedAt !== row.updatedAt
  ) {
    throw new Error('cao_mission_payload_invalid');
  }
  return parsed;
}

function sameScope(
  left: Pick<CaoMission, 'accountId' | 'workspaceId' | 'projectId'>,
  right: Pick<CaoMission, 'accountId' | 'workspaceId' | 'projectId'>,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId
  );
}

function sameRow(left: CaoMissionRow, right: CaoMissionRow): boolean {
  return (
    left.id === right.id &&
    left.schemaVersion === right.schemaVersion &&
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.status === right.status &&
    left.serializedMission === right.serializedMission &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

export function createCaoMissionStore(backend: RowBackend): CaoMissionStore {
  let writeTail = Promise.resolve();
  const serializeWrite = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = writeTail.then(operation, operation);
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return Object.freeze({
    async save(mission) {
      await serializeWrite(async () => {
        const desired = toRow(mission);
        if (await backend.insertIfAbsent(desired)) return;
        const current = await backend.get(desired.id);
        if (!current) throw new Error('cao_mission_conflict');
        const existing = fromRow(current);
        if (sameRow(current, desired)) return;
        if (!sameScope(existing, mission)) throw new Error('cao_mission_scope_mismatch');
        throw new Error('cao_mission_conflict');
      });
    },
    async compareAndSave({ expected, next }) {
      return serializeWrite(async () => {
        const expectedRow = toRow(expected);
        const nextRow = toRow(next);
        if (expected.id !== next.id || !sameScope(expected, next)) {
          throw new Error('cao_mission_scope_mismatch');
        }
        if (backend.compareAndPut) return backend.compareAndPut(expectedRow, nextRow);
        const current = await backend.get(expectedRow.id);
        if (!current || !sameRow(current, expectedRow)) return false;
        await backend.put(nextRow);
        return true;
      });
    },
    async get(input) {
      validLookup(input);
      const row = await backend.get(input.missionId);
      if (!row) return undefined;
      const mission = fromRow(row);
      if (
        mission.accountId !== input.accountId ||
        mission.workspaceId !== input.workspaceId ||
        mission.projectId !== input.projectId
      )
        return undefined;
      return mission;
    },
    async list(input) {
      validLookup({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        missionId: 'mission-list',
      });
      if (input.projectId !== undefined && !safeId(input.projectId, true)) {
        throw new Error('cao_mission_scope_invalid');
      }
      return (await backend.list(input.accountId, input.workspaceId))
        .map(fromRow)
        .filter(
          (mission) => input.projectId === undefined || mission.projectId === input.projectId,
        );
    },
  });
}

export function createCaoMissionStoreFromDatabase(database: JarvisDexie): CaoMissionStore {
  return createCaoMissionStore({
    async get(id) {
      return database.cao_missions.get(id);
    },
    async insertIfAbsent(row) {
      return database.transaction('rw', database.cao_missions, async () => {
        if (await database.cao_missions.get(row.id)) return false;
        await database.cao_missions.add(row);
        return true;
      });
    },
    async put(row) {
      await database.transaction('rw', database.cao_missions, async () => {
        const current = await database.cao_missions.get(row.id);
        if (current) {
          const existing = fromRow(current);
          if (
            existing.accountId !== row.accountId ||
            existing.workspaceId !== row.workspaceId ||
            existing.projectId !== row.projectId
          ) {
            throw new Error('cao_mission_scope_mismatch');
          }
        }
        await database.cao_missions.put(row);
      });
    },
    async compareAndPut(expected, next) {
      return database.transaction('rw', database.cao_missions, async () => {
        const current = await database.cao_missions.get(expected.id);
        if (!current || !sameRow(current, expected)) return false;
        if (
          current.accountId !== next.accountId ||
          current.workspaceId !== next.workspaceId ||
          current.projectId !== next.projectId
        )
          return false;
        await database.cao_missions.put(next);
        return true;
      });
    },
    async list(accountId, workspaceId) {
      return database.cao_missions
        .where('[accountId+workspaceId]')
        .equals([accountId, workspaceId])
        .toArray();
    },
  });
}

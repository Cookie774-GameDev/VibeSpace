import { db as installedDatabase, type JarvisDexie } from '@/lib/db';
import { getActiveAccountIdentity, type AccountIdentity } from '@/lib/accountIdentity';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { WORKSPACE_BACKUP_FORMAT, WORKSPACE_BACKUP_VERSION } from './workspaceBackup';

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_ROWS_PER_COLLECTION = 25_000;
const MAX_TOTAL_ROWS = 100_000;
const HISTORY_PREFIX = 'vibespace.portable-backup-history.v1:';

const COLLECTIONS = [
  'workspaces',
  'projects',
  'chats',
  'messages',
  'canvas_documents',
  'canvas_pages',
  'canvas_objects',
  'canvas_spatial',
  'canvas_cameras',
] as const;

type RestoreCollection = (typeof COLLECTIONS)[number];
type JsonRow = Readonly<Record<string, unknown>>;

export type WorkspaceRestoreErrorCode =
  | 'account_unavailable'
  | 'account_changed'
  | 'artifact_too_large'
  | 'artifact_invalid'
  | 'artifact_version_unsupported'
  | 'artifact_account_mismatch'
  | 'restore_failed';

export class WorkspaceRestoreError extends Error {
  constructor(
    readonly code: WorkspaceRestoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRestoreError';
  }
}

export interface WorkspaceRestoreCounts {
  readonly workspaces: number;
  readonly projects: number;
  readonly chats: number;
  readonly messages: number;
  readonly canvasDocuments: number;
}

export interface WorkspaceRestorePreview {
  readonly accountId: string;
  readonly artifactFingerprint: string;
  readonly createdAt: number;
  readonly restorable: number;
  readonly preservedLocal: number;
  readonly counts: WorkspaceRestoreCounts;
  readonly rows: Readonly<Record<RestoreCollection, readonly JsonRow[]>>;
}

export interface WorkspaceRestoreResult {
  readonly restored: number;
  readonly preservedLocal: number;
}

export interface PortableBackupHistory {
  readonly lastExportAt?: number;
  readonly lastRestoreAt?: number;
  readonly lastErrorAt?: number;
  readonly lastError?: string;
}

export interface WorkspaceRestoreOptions {
  readonly database?: JarvisDexie;
  readonly getAccountIdentity?: () => AccountIdentity | null;
  readonly now?: () => number;
}

/**
 * The minimum persisted scope needed to repair a local install whose durable
 * workspace/project rows disappeared while its auth and chat rows survived.
 * This is intentionally an explicit recovery operation; it is not part of
 * normal first-launch seeding and never overwrites an existing row.
 */
export interface PersistedLocalScope {
  readonly accountId: string;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
}

export type PersistedLocalScopeRecoveryReason =
  | 'invalid_scope'
  | 'account_unavailable'
  | 'cloud_identity'
  | 'account_mismatch'
  | 'scope_conflict'
  | 'missing_chat_evidence';

export interface PersistedLocalScopeRecoveryResult {
  readonly status: 'recovered' | 'already_present' | 'not_recoverable';
  readonly reason?: PersistedLocalScopeRecoveryReason;
  readonly accountId: string;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly createdWorkspace: boolean;
  readonly createdProject: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkspaceRestoreError('artifact_invalid', `Backup field ${field} is invalid.`);
  }
  return value;
}

function rowsFrom(value: unknown, label: string): JsonRow[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS_PER_COLLECTION) {
    throw new WorkspaceRestoreError('artifact_invalid', `Backup collection ${label} is invalid.`);
  }
  return value.map((entry) => {
    const row = asObject(entry);
    if (!row) {
      throw new WorkspaceRestoreError('artifact_invalid', `Backup collection ${label} is invalid.`);
    }
    return Object.freeze({ ...row });
  });
}

function assertUnique(rows: readonly JsonRow[], key: string, label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = requiredString(row as Record<string, unknown>, key);
    if (seen.has(value)) {
      throw new WorkspaceRestoreError(
        'artifact_invalid',
        `Backup collection ${label} has duplicates.`,
      );
    }
    seen.add(value);
  }
}

function assertRelationships(rows: Record<RestoreCollection, readonly JsonRow[]>): void {
  const workspaceIds = new Set(rows.workspaces.map((row) => requiredString(row, 'id')));
  const projectIds = new Set(rows.projects.map((row) => requiredString(row, 'id')));
  const chatIds = new Set(rows.chats.map((row) => requiredString(row, 'id')));
  const documentIds = new Set(rows.canvas_documents.map((row) => requiredString(row, 'id')));

  for (const row of rows.projects) {
    if (!workspaceIds.has(requiredString(row, 'workspace_id'))) {
      throw new WorkspaceRestoreError('artifact_invalid', 'Backup contains an orphaned project.');
    }
  }
  for (const row of rows.chats) {
    if (!workspaceIds.has(requiredString(row, 'workspace_id'))) {
      throw new WorkspaceRestoreError('artifact_invalid', 'Backup contains an orphaned chat.');
    }
    const projectId = row.project_id;
    if (projectId !== null && projectId !== undefined && !projectIds.has(String(projectId))) {
      throw new WorkspaceRestoreError(
        'artifact_invalid',
        'Backup chat references an unknown project.',
      );
    }
  }
  for (const row of rows.messages) {
    if (!chatIds.has(requiredString(row, 'chat_id'))) {
      throw new WorkspaceRestoreError('artifact_invalid', 'Backup contains an orphaned message.');
    }
  }
  for (const collection of [
    rows.canvas_pages,
    rows.canvas_objects,
    rows.canvas_spatial,
    rows.canvas_cameras,
  ]) {
    for (const row of collection) {
      if (!documentIds.has(requiredString(row, 'documentId'))) {
        throw new WorkspaceRestoreError(
          'artifact_invalid',
          'Backup contains orphaned canvas data.',
        );
      }
    }
  }
}

async function fingerprint(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new WorkspaceRestoreError(
      'artifact_too_large',
      'The backup exceeds the safe size limit.',
    );
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameIdentity(expected: AccountIdentity, current: AccountIdentity | null): boolean {
  return Boolean(
    current && current.accountId === expected.accountId && current.source === expected.source,
  );
}

function localScopeResult(
  scope: PersistedLocalScope,
  status: PersistedLocalScopeRecoveryResult['status'],
  options: Pick<PersistedLocalScopeRecoveryResult, 'createdWorkspace' | 'createdProject'>,
  reason?: PersistedLocalScopeRecoveryReason,
): PersistedLocalScopeRecoveryResult {
  return {
    status,
    ...(reason ? { reason } : {}),
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    ...options,
  };
}

/**
 * Reconstitute only a missing local workspace/project scope that is still
 * referenced by surviving chats. The operation is deliberately narrow:
 * cloud identities must use cloud/portable backup recovery, existing rows or
 * partial scopes are never replaced, and no rows are created without chat
 * evidence for the exact persisted IDs.
 */
export async function recoverMissingPersistedLocalScope(
  scope: PersistedLocalScope,
  options: WorkspaceRestoreOptions = {},
): Promise<PersistedLocalScopeRecoveryResult> {
  const database = options.database ?? installedDatabase;
  const getIdentity = options.getAccountIdentity ?? getActiveAccountIdentity;
  const base = { createdWorkspace: false, createdProject: false } as const;

  if (!scope.accountId.trim() || !scope.workspaceId.trim() || !scope.projectId.trim()) {
    return localScopeResult(scope, 'not_recoverable', base, 'invalid_scope');
  }

  const identity = getIdentity();
  if (!identity) return localScopeResult(scope, 'not_recoverable', base, 'account_unavailable');
  if (identity.source !== 'local') {
    return localScopeResult(scope, 'not_recoverable', base, 'cloud_identity');
  }
  if (identity.accountId !== scope.accountId) {
    return localScopeResult(scope, 'not_recoverable', base, 'account_mismatch');
  }

  return database.transaction(
    'rw',
    database.workspaces,
    database.projects,
    database.chats,
    async () => {
      if (!sameIdentity(identity, getIdentity())) {
        throw new WorkspaceRestoreError('account_changed', 'The active account changed.');
      }

      const [workspace, project] = await Promise.all([
        database.workspaces.get(scope.workspaceId),
        database.projects.get(scope.projectId),
      ]);

      if (workspace && workspace.owner_id !== identity.accountId) {
        return localScopeResult(scope, 'not_recoverable', base, 'scope_conflict');
      }
      if (project && project.workspace_id !== scope.workspaceId) {
        return localScopeResult(scope, 'not_recoverable', base, 'scope_conflict');
      }
      if (workspace && project) {
        return localScopeResult(scope, 'already_present', base);
      }
      // An orphaned project or a missing target workspace alongside other
      // workspaces requires an explicit backup/UI recovery decision.
      if (
        project ||
        (!workspace &&
          ((await database.workspaces.count()) > 0 || (await database.projects.count()) > 0))
      ) {
        return localScopeResult(scope, 'not_recoverable', base, 'scope_conflict');
      }

      const chats = await database.chats.where('workspace_id').equals(scope.workspaceId).toArray();
      const evidence = chats.some((chat) => chat.project_id === scope.projectId);
      if (!evidence) {
        return localScopeResult(scope, 'not_recoverable', base, 'missing_chat_evidence');
      }

      const timestamp = (options.now ?? Date.now)();
      let createdWorkspace = false;
      let createdProject = false;
      if (!workspace) {
        await database.workspaces.add({
          id: scope.workspaceId,
          name: 'Recovered workspace',
          owner_id: identity.accountId,
          created_at: timestamp,
          updated_at: timestamp,
        });
        createdWorkspace = true;
      }
      if (!project) {
        await database.projects.add({
          id: scope.projectId,
          workspace_id: scope.workspaceId,
          name: 'Recovered project',
          color_hue: 210,
          created_at: timestamp,
          updated_at: timestamp,
        });
        createdProject = true;
      }
      if (!sameIdentity(identity, getIdentity())) {
        throw new WorkspaceRestoreError('account_changed', 'The active account changed.');
      }
      return localScopeResult(scope, 'recovered', { createdWorkspace, createdProject });
    },
  );
}

function parseArtifact(content: string, identity: AccountIdentity) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new WorkspaceRestoreError('artifact_invalid', 'The selected file is not valid JSON.');
  }
  const root = asObject(parsed);
  const account = asObject(root?.account);
  const data = asObject(root?.data);
  const canvas = asObject(data?.canvas);
  if (!root || !account || !data || !canvas || root.format !== WORKSPACE_BACKUP_FORMAT) {
    throw new WorkspaceRestoreError(
      'artifact_invalid',
      'This is not a VibeSpace workspace backup.',
    );
  }
  if (root.version !== WORKSPACE_BACKUP_VERSION) {
    throw new WorkspaceRestoreError(
      'artifact_version_unsupported',
      'This backup version is not supported by this VibeSpace release.',
    );
  }
  if (account.id !== identity.accountId) {
    throw new WorkspaceRestoreError(
      'artifact_account_mismatch',
      'This backup belongs to a different account.',
    );
  }

  const rows: Record<RestoreCollection, readonly JsonRow[]> = {
    workspaces: rowsFrom(data.workspaces, 'workspaces'),
    projects: rowsFrom(data.projects, 'projects'),
    chats: rowsFrom(data.chats, 'chats'),
    messages: rowsFrom(data.messages, 'messages'),
    canvas_documents: rowsFrom(canvas.documents, 'canvas documents'),
    canvas_pages: rowsFrom(canvas.pages, 'canvas pages'),
    canvas_objects: rowsFrom(canvas.objects, 'canvas objects'),
    canvas_spatial: rowsFrom(canvas.spatial, 'canvas spatial data'),
    canvas_cameras: rowsFrom(canvas.cameras, 'canvas cameras'),
  };
  if (
    Object.values(rows).reduce((total, collection) => total + collection.length, 0) > MAX_TOTAL_ROWS
  ) {
    throw new WorkspaceRestoreError('artifact_invalid', 'The backup contains too many records.');
  }

  for (const collection of COLLECTIONS) {
    assertUnique(
      rows[collection],
      collection === 'canvas_cameras' ? 'documentId' : 'id',
      collection,
    );
  }
  for (const workspace of rows.workspaces) {
    if (requiredString(workspace, 'owner_id') !== identity.accountId) {
      throw new WorkspaceRestoreError('artifact_account_mismatch', 'Backup ownership is invalid.');
    }
  }
  for (const collection of [
    rows.canvas_documents,
    rows.canvas_pages,
    rows.canvas_objects,
    rows.canvas_spatial,
    rows.canvas_cameras,
  ]) {
    for (const row of collection) {
      if (requiredString(row, 'accountId') !== identity.accountId) {
        throw new WorkspaceRestoreError(
          'artifact_account_mismatch',
          'Canvas ownership is invalid.',
        );
      }
    }
  }
  assertRelationships(rows);
  return rows;
}

function primaryKey(collection: RestoreCollection, row: JsonRow): string {
  return requiredString(row, collection === 'canvas_cameras' ? 'documentId' : 'id');
}

export async function previewWorkspaceRestore(
  content: string,
  options: WorkspaceRestoreOptions = {},
): Promise<WorkspaceRestorePreview> {
  const database = options.database ?? installedDatabase;
  const getIdentity = options.getAccountIdentity ?? getActiveAccountIdentity;
  const identity = getIdentity();
  if (!identity) {
    throw new WorkspaceRestoreError('account_unavailable', 'An active account is required.');
  }
  const artifactFingerprint = await fingerprint(content);
  const rows = parseArtifact(content, identity);
  if (!sameIdentity(identity, getIdentity())) {
    throw new WorkspaceRestoreError(
      'account_changed',
      'The active account changed during preview.',
    );
  }

  let restorable = 0;
  let preservedLocal = 0;
  for (const collection of COLLECTIONS) {
    const table = database.table(collection);
    const existing = await table.bulkGet(
      rows[collection].map((row) => primaryKey(collection, row)),
    );
    for (const value of existing) value === undefined ? restorable++ : preservedLocal++;
  }
  if (!sameIdentity(identity, getIdentity())) {
    throw new WorkspaceRestoreError(
      'account_changed',
      'The active account changed during preview.',
    );
  }

  return Object.freeze({
    accountId: identity.accountId,
    artifactFingerprint,
    createdAt: (options.now ?? Date.now)(),
    restorable,
    preservedLocal,
    counts: Object.freeze({
      workspaces: rows.workspaces.length,
      projects: rows.projects.length,
      chats: rows.chats.length,
      messages: rows.messages.length,
      canvasDocuments: rows.canvas_documents.length,
    }),
    rows: Object.freeze(rows),
  });
}

export async function restoreWorkspaceBackup(
  preview: WorkspaceRestorePreview,
  options: WorkspaceRestoreOptions = {},
): Promise<WorkspaceRestoreResult> {
  const database = options.database ?? installedDatabase;
  const getIdentity = options.getAccountIdentity ?? getActiveAccountIdentity;
  const identity = getIdentity();
  if (!identity || identity.accountId !== preview.accountId) {
    throw new WorkspaceRestoreError('account_changed', 'The active account no longer matches.');
  }

  try {
    return await database.transaction(
      'rw',
      COLLECTIONS.map((collection) => database.table(collection)),
      async () => {
        if (!sameIdentity(identity, getIdentity())) {
          throw new WorkspaceRestoreError('account_changed', 'The active account changed.');
        }
        let restored = 0;
        let preservedLocal = 0;
        for (const collection of COLLECTIONS) {
          const table = database.table(collection);
          for (const row of preview.rows[collection]) {
            const key = primaryKey(collection, row);
            if ((await table.get(key)) !== undefined) {
              preservedLocal++;
              continue;
            }
            await table.add({ ...row });
            restored++;
          }
        }
        if (!sameIdentity(identity, getIdentity())) {
          throw new WorkspaceRestoreError('account_changed', 'The active account changed.');
        }
        return { restored, preservedLocal };
      },
    );
  } catch (error) {
    if (error instanceof WorkspaceRestoreError) throw error;
    throw new WorkspaceRestoreError('restore_failed', 'The backup could not be restored safely.');
  }
}

function historyKey(accountId: string): string {
  return `${HISTORY_PREFIX}${accountId}`;
}

export function readPortableBackupHistory(
  accountId: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): PortableBackupHistory {
  try {
    const parsed = JSON.parse(storage.getItem(historyKey(accountId)) ?? '{}') as unknown;
    const value = asObject(parsed);
    if (!value) return {};
    return {
      lastExportAt: typeof value.lastExportAt === 'number' ? value.lastExportAt : undefined,
      lastRestoreAt: typeof value.lastRestoreAt === 'number' ? value.lastRestoreAt : undefined,
      lastErrorAt: typeof value.lastErrorAt === 'number' ? value.lastErrorAt : undefined,
      lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 240) : undefined,
    };
  } catch {
    return {};
  }
}

export function recordPortableBackupHistory(
  accountId: string,
  update: 'export' | 'restore' | { error: string },
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
  now = Date.now(),
): PortableBackupHistory {
  const previous = readPortableBackupHistory(accountId, storage);
  const next: PortableBackupHistory =
    update === 'export'
      ? { ...previous, lastExportAt: now, lastError: undefined, lastErrorAt: undefined }
      : update === 'restore'
        ? { ...previous, lastRestoreAt: now, lastError: undefined, lastErrorAt: undefined }
        : { ...previous, lastErrorAt: now, lastError: update.error.slice(0, 240) };
  storage.setItem(historyKey(accountId), JSON.stringify(next));
  return next;
}

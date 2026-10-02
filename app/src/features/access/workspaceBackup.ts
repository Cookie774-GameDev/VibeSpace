import {
  db as installedDatabase,
  type CanvasCameraRow,
  type CanvasDocumentRow,
  type CanvasObjectRow,
  type CanvasPageRow,
  type CanvasSpatialRow,
  type JarvisDexie,
  type Project,
  type Workspace,
} from '@/lib/db';
import { getActiveAccountIdentity, type AccountIdentity } from '@/lib/accountIdentity';
import {
  flushWorkspacePersistence,
  type WorkspaceFlushResult,
} from '@/lib/persistence/workspaceFlush';
import type { Chat, Message } from '@/types/chat';
import type { Task } from '@/types/task';

export const WORKSPACE_BACKUP_FORMAT = 'vibespace-workspace-backup';
export const WORKSPACE_BACKUP_VERSION = 1;
export const WORKSPACE_BACKUP_FILENAME = 'vibespace-backup-v1.json';

export type WorkspaceBackupErrorCode =
  | 'account_unavailable'
  | 'account_changed'
  | 'flush_failed'
  | 'snapshot_failed'
  | 'row_limit_exceeded'
  | 'serialization_failed'
  | 'size_limit_exceeded'
  | 'artifact_save_failed';

export class WorkspaceBackupError extends Error {
  constructor(
    readonly code: WorkspaceBackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceBackupError';
  }
}

export interface WorkspaceBackupArtifact {
  readonly filename: string;
  readonly mimeType: 'application/json;charset=utf-8';
  readonly content: string;
}

export interface WorkspaceBackupCounts {
  readonly workspaces: number;
  readonly projects: number;
  readonly chats: number;
  readonly messages: number;
  readonly canvasDocuments: number;
  readonly tasks?: number;
}

export interface WorkspaceBackupResult {
  readonly filename: string;
  readonly byteSize: number;
  readonly counts: WorkspaceBackupCounts;
}

export interface WorkspaceBackupLimits {
  readonly maxRowsPerCollection: number;
  readonly maxTotalRows: number;
  readonly maxArtifactBytes: number;
  readonly maxContainerEntries: number;
  readonly maxStringBytes: number;
  readonly maxDepth: number;
}

const DEFAULT_LIMITS: WorkspaceBackupLimits = Object.freeze({
  maxRowsPerCollection: 25_000,
  maxTotalRows: 100_000,
  maxArtifactBytes: 32 * 1024 * 1024,
  maxContainerEntries: 100_000,
  maxStringBytes: 8 * 1024 * 1024,
  maxDepth: 64,
});

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface WorkspaceBackupSnapshot {
  readonly workspaces: Workspace[];
  readonly projects: Project[];
  readonly chats: Chat[];
  readonly messages: Message[];
  readonly tasks: Task[];
  readonly canvasDocuments: CanvasDocumentRow[];
  readonly canvasPages: CanvasPageRow[];
  readonly canvasObjects: CanvasObjectRow[];
  readonly canvasSpatial: CanvasSpatialRow[];
  readonly canvasCameras: CanvasCameraRow[];
}

export interface CreateWorkspaceBackupOptions {
  readonly database?: JarvisDexie;
  readonly getAccountIdentity?: () => AccountIdentity | null;
  readonly flush?: (reason: string) => Promise<WorkspaceFlushResult>;
  readonly saveArtifact?: (artifact: WorkspaceBackupArtifact) => Promise<void>;
  readonly limits?: Partial<WorkspaceBackupLimits>;
}

const SENSITIVE_FIELD_NAMES = new Set([
  'apikey',
  'authorization',
  'auth',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
]);

const URL_FIELD_NAMES = new Set(['url', 'uri', 'href']);
const REDACTED = '[REDACTED]';

function normalizedFieldName(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function sanitizeUrlCredential(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return value;

  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (!SENSITIVE_FIELD_NAMES.has(normalizedFieldName(key))) continue;
    parsed.searchParams.set(key, REDACTED);
    changed = true;
  }
  return changed ? parsed.toString() : value;
}

function serializableValue(
  value: unknown,
  limits: WorkspaceBackupLimits,
  path: string,
  depth = 0,
  fieldName?: string,
): JsonValue {
  if (depth > limits.maxDepth) {
    throw new WorkspaceBackupError(
      'serialization_failed',
      `Backup data exceeds the maximum nesting depth at ${path}.`,
    );
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WorkspaceBackupError(
        'serialization_failed',
        `Backup data contains a non-finite number at ${path}.`,
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > limits.maxStringBytes) {
      throw new WorkspaceBackupError(
        'size_limit_exceeded',
        `Backup data contains an oversized string at ${path}.`,
      );
    }
    return fieldName && URL_FIELD_NAMES.has(normalizedFieldName(fieldName))
      ? sanitizeUrlCredential(value)
      : value;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxContainerEntries) {
      throw new WorkspaceBackupError(
        'size_limit_exceeded',
        `Backup data contains too many entries at ${path}.`,
      );
    }
    return value.map((entry, index) =>
      serializableValue(entry, limits, `${path}[${index}]`, depth + 1),
    );
  }
  if (typeof value !== 'object') {
    throw new WorkspaceBackupError(
      'serialization_failed',
      `Backup data contains an unsupported value at ${path}.`,
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceBackupError(
      'serialization_failed',
      `Backup data contains an unsupported object at ${path}.`,
    );
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length > limits.maxContainerEntries) {
    throw new WorkspaceBackupError(
      'size_limit_exceeded',
      `Backup data contains too many fields at ${path}.`,
    );
  }
  const output: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (SENSITIVE_FIELD_NAMES.has(normalizedFieldName(key))) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = serializableValue(input[key], limits, `${path}.${key}`, depth + 1, key);
  }
  return output;
}

function byId<T extends { id: unknown }>(left: T, right: T): number {
  return String(left.id).localeCompare(String(right.id));
}

function byMessageOrder(left: Message, right: Message): number {
  return (
    String(left.chat_id).localeCompare(String(right.chat_id)) ||
    left.created_at - right.created_at ||
    String(left.id).localeCompare(String(right.id))
  );
}

function byCanvasPageOrder(left: CanvasPageRow, right: CanvasPageRow): number {
  return (
    String(left.documentId).localeCompare(String(right.documentId)) ||
    left.pageIndex - right.pageIndex ||
    left.id.localeCompare(right.id)
  );
}

function byCanvasSpatialOrder(left: CanvasSpatialRow, right: CanvasSpatialRow): number {
  return (
    String(left.documentId).localeCompare(String(right.documentId)) ||
    left.z - right.z ||
    left.id.localeCompare(right.id)
  );
}

function assertCollectionLimits(
  snapshot: WorkspaceBackupSnapshot,
  limits: WorkspaceBackupLimits,
): void {
  const collections = Object.entries(snapshot);
  let total = 0;
  for (const [name, rows] of collections) {
    if (rows.length > limits.maxRowsPerCollection) {
      throw new WorkspaceBackupError(
        'row_limit_exceeded',
        `Backup collection ${name} exceeds its row limit.`,
      );
    }
    total += rows.length;
  }
  if (total > limits.maxTotalRows) {
    throw new WorkspaceBackupError('row_limit_exceeded', 'Backup exceeds the total row limit.');
  }
}

async function readAccountSnapshot(
  database: JarvisDexie,
  accountId: string,
): Promise<WorkspaceBackupSnapshot> {
  return database.transaction(
    'r',
    [
      database.workspaces,
      database.projects,
      database.chats,
      database.messages,
      database.tasks,
      database.canvas_documents,
      database.canvas_pages,
      database.canvas_objects,
      database.canvas_spatial,
      database.canvas_cameras,
    ],
    async () => {
      const workspaces = await database.workspaces.where('owner_id').equals(accountId).toArray();
      const workspaceIds = workspaces.map((workspace) => workspace.id);
      const projects =
        workspaceIds.length === 0
          ? []
          : await database.projects.where('workspace_id').anyOf(workspaceIds).toArray();
      const chats =
        workspaceIds.length === 0
          ? []
          : await database.chats.where('workspace_id').anyOf(workspaceIds).toArray();
      const projectWorkspaces = new Map(projects.map((project) => [project.id, project.workspace_id]));
      const tasks = workspaceIds.length === 0
        ? []
        : await database.tasks.where('workspace_id').anyOf(workspaceIds)
          .filter((task) => !task.project_id || projectWorkspaces.get(task.project_id) === task.workspace_id)
          .toArray();
      const chatIds = chats.map((chat) => chat.id);
      const messages =
        chatIds.length === 0
          ? []
          : await database.messages.where('chat_id').anyOf(chatIds).toArray();
      const canvasDocuments = await database.canvas_documents
        .where('accountId')
        .equals(accountId)
        .toArray();
      const documentIds = new Set(canvasDocuments.map((document) => String(document.id)));
      const belongsToAccountDocument = (row: { documentId: unknown }) =>
        documentIds.has(String(row.documentId));
      const [canvasPages, canvasObjects, canvasSpatial, canvasCameras] = await Promise.all([
        database.canvas_pages
          .where('accountId')
          .equals(accountId)
          .filter(belongsToAccountDocument)
          .toArray(),
        database.canvas_objects
          .where('accountId')
          .equals(accountId)
          .filter(belongsToAccountDocument)
          .toArray(),
        database.canvas_spatial
          .where('accountId')
          .equals(accountId)
          .filter(belongsToAccountDocument)
          .toArray(),
        database.canvas_cameras
          .where('accountId')
          .equals(accountId)
          .filter(belongsToAccountDocument)
          .toArray(),
      ]);

      return {
        workspaces: workspaces.sort(byId),
        projects: projects.sort(byId),
        chats: chats.sort(byId),
        messages: messages.sort(byMessageOrder),
        tasks: tasks.sort(byId),
        canvasDocuments: canvasDocuments.sort(byId),
        canvasPages: canvasPages.sort(byCanvasPageOrder),
        canvasObjects: canvasObjects.sort(byId),
        canvasSpatial: canvasSpatial.sort(byCanvasSpatialOrder),
        canvasCameras: canvasCameras.sort((left, right) =>
          String(left.documentId).localeCompare(String(right.documentId)),
        ),
      };
    },
  );
}

function exportPayload(
  identity: AccountIdentity,
  snapshot: WorkspaceBackupSnapshot,
): Record<string, unknown> {
  return {
    format: WORKSPACE_BACKUP_FORMAT,
    version: WORKSPACE_BACKUP_VERSION,
    account: {
      id: identity.accountId,
      source: identity.source,
    },
    data: {
      workspaces: snapshot.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        owner_id: workspace.owner_id,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
      })),
      projects: snapshot.projects.map((project) => ({
        id: project.id,
        workspace_id: project.workspace_id,
        name: project.name,
        color_hue: project.color_hue ?? null,
        icon: project.icon ?? null,
        system_prompt_context: project.system_prompt_context ?? null,
        no_context_mode: project.no_context_mode ?? false,
        allowed_agent_slugs: project.allowed_agent_slugs ?? null,
        created_at: project.created_at,
        updated_at: project.updated_at,
      })),
      chats: snapshot.chats.map((chat) => ({
        id: chat.id,
        workspace_id: chat.workspace_id,
        project_id: chat.project_id ?? null,
        title: chat.title,
        mode: chat.mode,
        active_agent_ids: chat.active_agent_ids,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        archived: chat.archived ?? false,
        pinned: chat.pinned ?? false,
        pinned_at: chat.pinned_at ?? null,
      })),
      messages: snapshot.messages.map((message) => ({
        id: message.id,
        chat_id: message.chat_id,
        role: message.role,
        agent_id: message.agent_id ?? null,
        parts: message.parts,
        parent_id: message.parent_id ?? null,
        created_at: message.created_at,
        updated_at: message.updated_at,
        usage: message.usage ?? null,
      })),
      tasks: snapshot.tasks,
      canvas: {
        documents: snapshot.canvasDocuments,
        pages: snapshot.canvasPages,
        objects: snapshot.canvasObjects,
        spatial: snapshot.canvasSpatial,
        cameras: snapshot.canvasCameras,
      },
    },
  };
}

function sameIdentity(
  left: AccountIdentity,
  right: AccountIdentity | null,
): right is AccountIdentity {
  return right !== null && left.accountId === right.accountId && left.source === right.source;
}

export async function downloadWorkspaceBackupArtifact(
  artifact: WorkspaceBackupArtifact,
): Promise<void> {
  if (
    typeof document === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function'
  ) {
    throw new Error('File download is unavailable.');
  }

  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = artifact.filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export function createWorkspaceBackup(options: CreateWorkspaceBackupOptions = {}) {
  const database = options.database ?? installedDatabase;
  const getAccountIdentity = options.getAccountIdentity ?? getActiveAccountIdentity;
  const flush = options.flush ?? flushWorkspacePersistence;
  const saveArtifact = options.saveArtifact ?? downloadWorkspaceBackupArtifact;
  const limits: WorkspaceBackupLimits = { ...DEFAULT_LIMITS, ...options.limits };

  return async (): Promise<WorkspaceBackupResult> => {
    const identityBeforeFlush = getAccountIdentity();
    if (!identityBeforeFlush) {
      throw new WorkspaceBackupError(
        'account_unavailable',
        'The active account is unavailable for backup.',
      );
    }

    let flushResult: WorkspaceFlushResult;
    try {
      flushResult = await flush('access-backup');
    } catch {
      throw new WorkspaceBackupError(
        'flush_failed',
        'Pending workspace changes could not be flushed.',
      );
    }
    if (
      flushResult.failed > 0 ||
      flushResult.timedOut ||
      flushResult.canvas.failed > 0 ||
      flushResult.canvas.timedOut
    ) {
      throw new WorkspaceBackupError(
        'flush_failed',
        'Pending workspace changes could not be flushed completely.',
      );
    }

    const identity = getAccountIdentity();
    if (!sameIdentity(identityBeforeFlush, identity)) {
      throw new WorkspaceBackupError(
        'account_changed',
        'The active account changed while preparing the backup.',
      );
    }

    let snapshot: WorkspaceBackupSnapshot;
    try {
      snapshot = await readAccountSnapshot(database, identity.accountId);
      assertCollectionLimits(snapshot, limits);
    } catch (error) {
      if (error instanceof WorkspaceBackupError) throw error;
      throw new WorkspaceBackupError(
        'snapshot_failed',
        'The local workspace snapshot could not be read.',
      );
    }

    if (!sameIdentity(identity, getAccountIdentity())) {
      throw new WorkspaceBackupError(
        'account_changed',
        'The active account changed while preparing the backup.',
      );
    }

    let content: string;
    try {
      const canonical = serializableValue(exportPayload(identity, snapshot), limits, 'backup');
      content = JSON.stringify(canonical, null, 2);
    } catch (error) {
      if (error instanceof WorkspaceBackupError) throw error;
      throw new WorkspaceBackupError(
        'serialization_failed',
        'The local workspace snapshot could not be serialized safely.',
      );
    }
    const byteSize = new TextEncoder().encode(content).byteLength;
    if (byteSize > limits.maxArtifactBytes) {
      throw new WorkspaceBackupError(
        'size_limit_exceeded',
        'The backup exceeds the maximum artifact size.',
      );
    }

    try {
      await saveArtifact({
        filename: WORKSPACE_BACKUP_FILENAME,
        mimeType: 'application/json;charset=utf-8',
        content,
      });
    } catch {
      throw new WorkspaceBackupError(
        'artifact_save_failed',
        'The backup file could not be created.',
      );
    }

    return {
      filename: WORKSPACE_BACKUP_FILENAME,
      byteSize,
      counts: {
        workspaces: snapshot.workspaces.length,
        projects: snapshot.projects.length,
        chats: snapshot.chats.length,
        messages: snapshot.messages.length,
        canvasDocuments: snapshot.canvasDocuments.length,
        ...(snapshot.tasks.length > 0 ? { tasks: snapshot.tasks.length } : {}),
      },
    };
  };
}

export const backupCurrentAccountWorkspace = createWorkspaceBackup();

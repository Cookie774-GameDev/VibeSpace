/**
 * Dexie schema definitions for Jarvis V1.
 *
 * The Dexie database is named `jarvis-v1` and pinned at version 1.
 * No migrations are added beyond v1 in this iteration.
 *
 * All record types come from `@/types/*` where they exist. Workspace, Project,
 * SettingsRow, and SyncQueueRow are db-internal shapes that don't have
 * user-facing types in `src/types/`, so they're defined here.
 */

import type {
  ProjectId,
  WorkspaceId,
} from '@/types/common';

/**
 * A workspace is the top-level container in Jarvis. Multi-workspace support is
 * roadmap; V1 ships with a single "Personal" workspace seeded automatically.
 */
export type Workspace = {
  id: WorkspaceId;
  name: string;
  /** Local user id (`usr_*`) on offline-only installs, or Supabase auth user id when synced. */
  owner_id: string;
  created_at: number;
  updated_at: number;
};

/**
 * A project groups chats, tasks and memory under a workspace. The Inbox project
 * is seeded by default and behaves as the catch-all bucket.
 */
export type Project = {
  id: ProjectId;
  workspace_id: WorkspaceId;
  name: string;
  /** HSL hue 0..359 used by the UI to colour-code the project. */
  color_hue?: number;
  created_at: number;
  updated_at: number;
};

/**
 * One row in the simple key/value settings store.
 * Values are stored as raw JSON-serialisable values; consumers handle typing
 * at the call site via `settingsRepo.get<T>(key)`.
 */
export type SettingsRow = {
  key: string;
  value: unknown;
  updated_at: number;
};

/**
 * Operation kind for an outbound sync mutation.
 */
export type SyncOp = 'insert' | 'update' | 'delete';

/**
 * Lifecycle of a row in the sync queue.
 */
export type SyncStatus = 'pending' | 'in_progress' | 'done' | 'error';

/**
 * One pending mutation that needs to be flushed to Supabase when cloud sync
 * is enabled. Local-only - never sent to the cloud itself.
 */
export type SyncQueueRow = {
  id: string;
  op: SyncOp;
  /** Logical table name in both Dexie and Supabase. */
  table: string;
  /** Primary key of the affected row. */
  row_id: string;
  /** For insert/update: the full row payload. For delete: ignored. */
  payload: unknown;
  /** Last attempt timestamp (unix ms). */
  attempted_at?: number;
  status: SyncStatus;
  /** Last error string if status === 'error'. */
  error?: string;
  created_at: number;
};

export const DB_NAME = 'jarvis-v1';
export const DB_VERSION = 1;

/**
 * Dexie store schema strings.
 *
 * Index syntax:
 *   - first column = primary key
 *   - `&col` = unique secondary index
 *   - `[a+b]` = compound index
 *
 * Only indexed columns are listed; all other fields are stored without an index.
 */
export const STORES = {
  workspaces: 'id, name, owner_id, updated_at',
  projects: 'id, workspace_id, name, updated_at',
  chats:
    'id, workspace_id, project_id, [archived+updated_at], updated_at',
  messages: 'id, chat_id, [chat_id+created_at], parent_id',
  agents: 'id, &slug',
  tasks:
    'id, workspace_id, project_id, status, [status+priority], due_at, scheduled_for, [workspace_id+status]',
  memory_items:
    'id, workspace_id, project_id, agent_id, [workspace_id+source], last_accessed_at',
  settings: 'key',
  sync_queue: 'id, status, created_at',
} as const;

export type StoreName = keyof typeof STORES;

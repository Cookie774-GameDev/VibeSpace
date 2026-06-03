/**
 * Dexie schema definitions for Jarvis.
 *
 * The Dexie database is named `jarvis-v1`. The DB name is historical — it
 * is NOT the schema version. Schema versioning is handled by Dexie's
 * `version().stores()` chain in `lib/db/index.ts`.
 *
 * V1 → V2 migration is purely additive: new tables for events, quick links,
 * terminal subsystem and integrations. No existing tables are altered or
 * dropped.
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
 * A project groups chats, terminals, tasks and memory under a workspace.
 * The Inbox project is seeded by default and behaves as the catch-all
 * bucket.
 *
 * Projects update fields:
 *   - `system_prompt_context` is prepended to every AI request that
 *     fires while this project is active. Holds the project's "house
 *     rules" — paths, conventions, DB schema, anything the user wants
 *     every model to know without re-typing.
 *   - `no_context_mode` short-circuits the prepend so the user can run
 *     a quick clean-room request without the project leaking in.
 *   - `allowed_agent_slugs` narrows the agent picker to a curated list
 *     for this project. `undefined` = "no restriction, all agents
 *     visible". Empty array = "no agents bound" (degenerate, but
 *     allowed). Slugs are matched against `Agent.slug`, not id, so the
 *     binding survives agent re-seeding.
 *   - `pane_tree_key` lets a project carry an opaque key namespace for
 *     its terminal pane tree in localStorage; reserved for migration
 *     work, not consumed today.
 */
export type Project = {
  id: ProjectId;
  workspace_id: WorkspaceId;
  name: string;
  /** HSL hue 0..359 used by the UI to colour-code the project. */
  color_hue?: number;
  /** Optional lucide icon name. */
  icon?: string;
  /** Project-level context blob prepended to AI requests. */
  system_prompt_context?: string;
  /** When true, the context blob is skipped on every request. */
  no_context_mode?: boolean;
  /** Optional curated agent slug allowlist for this project. */
  allowed_agent_slugs?: string[];
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
/** Current schema version — bumped to 2 in V2 (additive new tables). */
export const DB_VERSION = 2;

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

/**
 * V1 schema. Pinned for replay so existing users migrate cleanly.
 * Do not edit retroactively.
 */
export const STORES_V1 = {
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

/**
 * V2 schema = V1 + additive tables for events, quick links, terminals and
 * integrations. Existing V1 tables are unchanged so this requires no data
 * migration — Dexie's auto-migration just creates the new object stores.
 *
 * Index decisions:
 *   events:                workspace+start range queries (DayGrid), status filter
 *   quick_links:           workspace+position for ordered lists, group_id+position
 *                          for grouped views, last_used_at for "stale links"
 *   quick_link_groups:     workspace+position for ordered group rendering
 *   terminal_presets:      compound `&[workspace_id+slug]` per X1 verifier
 *   terminal_sessions:     project+status for "running PTYs in this project",
 *                          last_active_at for recency
 *   terminal_scrollback:   compound pkey [session_id+chunk_seq], session_id
 *                          for cleanup queries
 *   terminal_layouts:      project_id is the pkey (single layout per project)
 *   integrations:          unique kind so at most one per kind per user
 */
export const STORES_V2 = {
  ...STORES_V1,
  events:
    'id, workspace_id, project_id, start_at, [workspace_id+start_at], status',
  quick_links:
    'id, workspace_id, group_id, [workspace_id+position], [workspace_id+group_id+position], last_used_at',
  quick_link_groups: 'id, workspace_id, [workspace_id+position]',
  terminal_presets: 'id, workspace_id, &[workspace_id+slug]',
  terminal_sessions:
    'id, project_id, workspace_id, status, [project_id+status], last_active_at',
  terminal_scrollback:
    '[session_id+chunk_seq], session_id, created_at',
  terminal_layouts: 'project_id, updated_at',
  integrations: 'id, &kind',
} as const;

/** Active store list — points to the latest version. */
export const STORES = STORES_V2;

export type StoreName = keyof typeof STORES;

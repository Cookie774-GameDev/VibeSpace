/**
 * Dexie schema definitions for Jarvis.
 *
 * The Dexie database is named `jarvis-v1`. The DB name is historical — it
 * is NOT the schema version. Schema versioning is handled by Dexie's
 * `version().stores()` chain in `lib/db/index.ts`.
 *
 * Every browser database migration is additive. No prior store declaration is
 * altered or dropped.
 *
 * All record types come from `@/types/*` where they exist. Workspace, Project,
 * SettingsRow, and SyncQueueRow are db-internal shapes that don't have
 * user-facing types in `src/types/`, so they're defined here.
 */

import type { ProjectId, WorkspaceId } from '@/types/common';
import type {
  ContextEdgeV2,
  ContextEntityV2,
  ContextMapRecordV2,
  ContextProvenanceV2,
  ContextSourceV2,
} from '@/features/context/contracts';
import type {
  ContextAssetV2,
  ContextNoteRevisionV2,
  ContextNoteV2,
} from '@/features/context/contentContracts';
import type { ContextEmbeddingRecordV1 } from '@/features/context/semanticSearch';
import type { PromptForgeJob } from '@/features/prompt-forge/contracts';
import type { MemoryEvidenceItem } from '@/features/jarvis-memory/types';
import type {
  JarvisCanonicalResultEvidenceV1,
  JarvisDurableLiveEvidenceV1,
  JarvisExecutionEvidenceV1,
  JarvisProducerSourceEvidenceV1,
  JarvisScheduledRetrySnapshotV1,
  JarvisTransportAttemptV1,
} from '@/lib/jarvis/contracts/execution';
import type {
  CanvasBackground,
  CanvasBlockContent,
  CanvasBlockId,
  CanvasBlockKind,
  CanvasDocumentId,
  CanvasLayoutMode,
  CanvasOwnerId,
  CanvasProjectId,
  CanvasTimestamp,
} from '@/features/canvas/contracts';

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

export type JarvisModelSnapshotRow = {
  connection_id?: string;
  provider_id: string;
  model_id: string;
  connection_mode: 'native-api' | 'external-cli' | 'local';
  capabilities: Record<string, boolean>;
  effective_temperature?: number;
  captured_at: number;
};

export type JarvisSourceRefRow = {
  id: string;
  kind:
    | 'user_message'
    | 'chat'
    | 'project'
    | 'project_file'
    | 'context_node'
    | 'memory'
    | 'terminal'
    | 'tool_result'
    | 'plugin'
    | 'mcp'
    | 'web'
    | 'schedule'
    | 'artifact'
    | 'agent_output';
  label: string;
  uri?: string;
  account_id: string;
  project_id?: string;
  trust: 'user_direct' | 'app_verified' | 'external_untrusted';
  origin?: 'user_authored' | 'app_observed' | 'model_inference' | 'mixed' | 'external_retrieved';
  sensitivity: 'public' | 'private' | 'restricted' | 'secret';
  observed_at?: number;
  content_hash?: string;
};

export type JarvisIdentityRevisionRow = {
  id: string;
  identity_id: 'jarvis';
  version: number;
  core_hash: string;
  response_contract_hash: string;
  created_at: number;
};

export type JarvisProfileRow = {
  id: string;
  account_id: string;
  name: string;
  active: 0 | 1;
  identity_version: number;
  revision_id: string;
  soul_revision_id?: string;
  custom_instructions: string;
  instruction_source: 'none' | 'user' | 'legacy_user_extension';
  memory_scope: 'none' | 'profile' | 'shared_selected';
  voice_enabled: boolean;
  source_prompt_hash?: string;
  created_at: number;
  updated_at: number;
  migration_version: 3;
  migration_source: 'legacy_agent' | 'clean_default';
  migration_source_prompt_hash?: string;
  migration_completed_at: number;
};

export type JarvisRunRow = {
  id: string;
  account_id: string;
  workspace_id?: string;
  project_id?: string;
  chat_id?: string;
  parent_run_id?: string;
  source: 'typed_chat' | 'voice' | 'schedule' | 'hive_final' | 'phone' | 'browser_chat';
  status:
    | 'queued'
    | 'compiling'
    | 'running'
    | 'awaiting_approval'
    | 'partial'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timed_out';
  agent_id: string;
  identity_version: number;
  profile_revision_id: string;
  model: JarvisModelSnapshotRow;
  created_at: number;
  updated_at: number;
  completed_at?: number;
  scheduled_retry_snapshot?: JarvisScheduledRetrySnapshotV1;
  hive_stack_plan?: import('@/lib/jarvis/contracts/execution').JarvisHiveStackPlanV1;
  transport_attempts?: JarvisTransportAttemptV1[];
};

export type JarvisEventRow = {
  run_id: string;
  seq: number;
  idempotency_key: string;
  type:
    | 'run_state'
    | 'model'
    | 'context'
    | 'retrieval'
    | 'tool'
    | 'terminal'
    | 'approval'
    | 'artifact'
    | 'message'
    | 'warning'
    | 'error';
  status?: string;
  title: string;
  safe_summary?: string;
  source_refs: JarvisSourceRefRow[];
  artifact_ids: string[];
  created_at: number;
  execution_evidence?: JarvisExecutionEvidenceV1;
  canonical_result_evidence?: JarvisCanonicalResultEvidenceV1;
  producer_source_evidence?: JarvisProducerSourceEvidenceV1;
  live_evidence?: JarvisDurableLiveEvidenceV1;
};

export type JarvisApprovalRow = {
  schema_version: 1;
  id: string;
  run_id: string;
  request_id: string;
  attempt_number: number;
  action_id: string;
  action_version: number;
  capability_id: string;
  capability_snapshot_hash: string;
  expected_effect: string;
  expires_at: number;
  params: unknown;
  secret_handle_refs?: { field: string; handle_id: string }[];
  params_hash: string;
  target_snapshot?: unknown;
  risk: 'safe' | 'confirm' | 'dangerous';
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  created_at: number;
  decided_at?: number;
  consumed_at?: number;
};

export type JarvisArtifactRow = {
  schema_version: 1;
  id: string;
  run_id: string;
  request_id: string;
  attempt_number: number;
  state: 'ready' | 'partial' | 'quarantined';
  kind:
    | 'file'
    | 'link'
    | 'text'
    | 'image'
    | 'document'
    | 'code'
    | 'terminal_output'
    | 'provider_result';
  title: string;
  uri?: string;
  mime_type?: string;
  safe_summary?: string;
  content_hash?: string;
  size_bytes?: number;
  preview?: {
    kind: 'text' | 'image' | 'none';
    text?: string;
    truncated: boolean;
    size_bytes: number;
  };
  local_reference?: {
    kind: 'path' | 'blob_key' | 'message_part';
    value: string;
  };
  source_refs: JarvisSourceRefRow[];
  created_at: number;
};

export type ContextMapRow = ContextMapRecordV2;
export type ContextSourceRow = ContextSourceV2;
export type ContextEntityRow = ContextEntityV2;
export type ContextEdgeRow = ContextEdgeV2;
export type ContextProvenanceRow = ContextProvenanceV2;
export type ContextNoteRow = ContextNoteV2;
export type ContextNoteRevisionRow = ContextNoteRevisionV2;
export type ContextAssetRow = ContextAssetV2;
export type ContextEmbeddingRow = ContextEmbeddingRecordV1;
export type PromptForgeJobRow = PromptForgeJob;

export type MemoryEvidenceRow = MemoryEvidenceItem & {
  schemaVersion: 1;
  recordKind: 'evidence';
  revision: number;
};

export type MemoryEvidenceHistoryRow = {
  id: string;
  evidenceId: string;
  ownerId: string;
  revision: number;
  action: 'created' | 'updated' | 'deleted';
  snapshot: MemoryEvidenceRow;
  createdAt: number;
};

export type ContextMigrationBackupRow = {
  version: 1;
  id: string;
  accountId: string;
  projectId: string | null;
  status: 'prepared' | 'verified' | 'rolled_back';
  legacyKeys: string[];
  legacyValues: Record<string, string | null>;
  expectedMapCount: number;
  migratedMapCount: number;
  migratedMapIds: string[];
  quarantinedCount?: number;
  idRemaps?: Record<string, string>;
  rollbackAvailable: true;
  createdAt: number;
  verifiedAt?: number;
  rolledBackAt?: number;
};

export type ContextQuarantineRecordKind =
  | 'map'
  | 'source'
  | 'entity'
  | 'edge'
  | 'provenance'
  | 'legacy_collection'
  | 'legacy_selected_tree'
  | 'legacy_selected_file'
  | 'legacy_map_metadata';

export type ContextQuarantineRow = {
  version: 1;
  id: string;
  accountId: string;
  mapId?: string;
  recordKind: ContextQuarantineRecordKind;
  reason: string;
  raw: unknown;
  recoveryOptions: Array<'retry' | 'restore_backup' | 'export_then_discard'>;
  quarantinedAt: number;
};

// ---------------------------------------------------------------------------
// Infinite Idea Canvas (V8) persistence rows
//
// Local-first, additive Dexie records for the Infinite Idea Canvas. These are
// transaction-ready primitives only: they do NOT implement autosave or
// repositories. Field shapes stay consistent with the Canvas domain contracts
// in `@/features/canvas/contracts`. Large binaries live elsewhere (Tauri
// filesystem or optimized browser storage); `canvas_assets` stores
// metadata/reference rows only, never blob bytes.
// ---------------------------------------------------------------------------

/**
 * A canvas document aggregate root. Content objects, spatial placements,
 * camera view state, page order, revisions, tombstones, and recovery journal
 * entries each live in their own tables (kept strictly separate), so this row
 * carries only document-level metadata.
 */
export type CanvasDocumentRow = {
  id: CanvasDocumentId;
  accountId: string;
  ownerId: CanvasOwnerId;
  projectId: CanvasProjectId;
  schemaVersion: number;
  title: string;
  icon: string | null;
  thumbnail: string | null;
  layoutMode: CanvasLayoutMode;
  background: CanvasBackground;
  localRevision: number;
  syncRevision: number;
  createdAt: CanvasTimestamp;
  updatedAt: CanvasTimestamp;
  archivedAt: CanvasTimestamp | null;
  deletedAt: CanvasTimestamp | null;
};

/**
 * One deterministic position in a document's page-mode order. The unique
 * `[documentId+pageIndex]` index enforces exactly one block per page position
 * per document; `presentationIndex` optionally orders presentation frames and
 * `presenterNotes` carries bounded per-frame notes without a second content
 * copy. The optional field keeps pre-existing V8 rows backward compatible.
 */
export type CanvasPageRow = {
  id: string;
  accountId: string;
  documentId: CanvasDocumentId;
  pageIndex: number;
  blockId: CanvasBlockId;
  presentationIndex: number | null;
  presenterNotes?: string | null;
  createdAt: CanvasTimestamp;
  updatedAt: CanvasTimestamp;
};

/**
 * A canvas content object (a Canvas block). Holds canonical content only;
 * edgeless geometry lives separately in `canvas_spatial`.
 */
export type CanvasObjectRow = {
  id: CanvasBlockId;
  accountId: string;
  documentId: CanvasDocumentId;
  kind: CanvasBlockKind;
  content: CanvasBlockContent;
  createdAt: CanvasTimestamp;
  updatedAt: CanvasTimestamp;
};

/**
 * Edgeless spatial metadata, kept strictly separate from content. Mirrors the
 * contract's CanvasSpatialPlacement geometry (a block reference plus geometry,
 * no content payload). The unique `[documentId+blockId]` index enforces one
 * placement per block per document.
 */
export type CanvasSpatialRow = {
  id: string;
  accountId: string;
  documentId: CanvasDocumentId;
  blockId: CanvasBlockId;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  updatedAt: CanvasTimestamp;
};

/**
 * Per-document camera view state (world center plus zoom), stored separately
 * from the document row so view updates are independently transactional. Keyed
 * one camera per document.
 */
export type CanvasCameraRow = {
  documentId: CanvasDocumentId;
  accountId: string;
  x: number;
  y: number;
  zoom: number;
  updatedAt: CanvasTimestamp;
};

/**
 * Metadata/reference row for a large canvas asset. Stores a stable id,
 * checksum, size, and a storage reference (filesystem/browser/inline) but
 * never the blob bytes themselves. `orphanedAt` supports orphan cleanup.
 */
export type CanvasAssetRow = {
  id: string;
  accountId: string;
  ownerId: CanvasOwnerId;
  projectId: CanvasProjectId;
  documentId: CanvasDocumentId | null;
  kind: 'image' | 'file' | 'thumbnail';
  mimeType: string | null;
  checksum: string | null;
  sizeBytes: number | null;
  storageKind: 'filesystem' | 'browser' | 'inline';
  storageRef: string;
  orphanedAt: CanvasTimestamp | null;
  createdAt: CanvasTimestamp;
  updatedAt: CanvasTimestamp;
};

/**
 * A reusable canvas template. `snapshot` is an opaque, JSON-serialisable
 * template payload typed at the call site (db-internal shape).
 */
export type CanvasTemplateRow = {
  id: string;
  accountId: string;
  ownerId: CanvasOwnerId;
  projectId: CanvasProjectId | null;
  name: string;
  layoutMode: CanvasLayoutMode;
  background: CanvasBackground;
  snapshot: unknown;
  createdAt: CanvasTimestamp;
  updatedAt: CanvasTimestamp;
};

/**
 * A deterministic document revision marker. The unique `[documentId+sequence]`
 * index enforces one revision per sequence per document (mirrors Context note
 * revisions). `snapshotAssetId` optionally references a metadata-only asset
 * holding the revision snapshot.
 */
export type CanvasRevisionRow = {
  id: string;
  accountId: string;
  documentId: CanvasDocumentId;
  sequence: number;
  localRevision: number;
  syncRevision: number;
  changeKind: 'created' | 'updated' | 'recovered' | 'checkpoint';
  snapshotAssetId: string | null;
  contentHash: string | null;
  createdAt: CanvasTimestamp;
};

/**
 * A tombstone recording a deleted canvas entity so deletes can be synced and
 * conflicts recovered. `entityId`/`entityKind` identify what was removed.
 */
export type CanvasTombstoneRow = {
  id: string;
  accountId: string;
  documentId: CanvasDocumentId;
  entityId: string;
  entityKind: 'document' | 'object' | 'page' | 'asset' | 'placement';
  deletedAt: CanvasTimestamp;
  syncRevision: number;
  createdAt: CanvasTimestamp;
};

/**
 * A crash/conflict recovery journal entry for canvas, camera, unsaved
 * text/strokes, or conflict state. `payload` is an opaque recoverable delta
 * typed at the call site; `snapshotAssetId` optionally references a
 * metadata-only asset.
 */
export type CanvasRecoveryRow = {
  id: string;
  accountId: string;
  documentId: CanvasDocumentId;
  kind: 'canvas' | 'camera' | 'text' | 'stroke' | 'conflict';
  status: 'pending' | 'recovered' | 'discarded' | 'error';
  snapshotAssetId: string | null;
  payload: unknown;
  contentHash: string | null;
  createdAt: CanvasTimestamp;
  recoveredAt: CanvasTimestamp | null;
};

export type BrowserChatProvider = 'chatgpt' | 'claude' | 'gemini';

export type BrowserChatBindingRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  projectId?: string;
  chatId: string;
  provider: BrowserChatProvider;
  providerProfileKey: string;
  providerConversationKey?: string;
  resumeUrl?: string;
  providerProjectKey?: string;
  bindingState: 'new' | 'bound' | 'unavailable' | 'stale';
  localTitle: string;
  pinned: boolean;
  viewMode: 'provider' | 'vibespace';
  permissionProfileId?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
};

export type ProviderProjectLinkRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  projectId: string;
  provider: BrowserChatProvider;
  providerProjectKey?: string;
  providerProjectUrl?: string;
  state: 'linked' | 'stale' | 'unsupported';
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
};

export type BrowserChatSnapshotMessage = {
  id: string;
  parentId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  createdAt?: number;
  text: string;
};

export type BrowserChatImportRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  provider: 'chatgpt';
  fileName: string;
  fileSize: number;
  fileHash: string;
  status: 'complete';
  conversationCount: number;
  importedAt: number;
};

export type BrowserChatSnapshotRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  provider: 'chatgpt';
  providerConversationKey: string;
  importId: string;
  title: string;
  providerCreatedAt?: number;
  providerUpdatedAt?: number;
  messageCount: number;
  contentHash: string;
  revision: number;
  messages: BrowserChatSnapshotMessage[];
  createdAt: number;
  updatedAt: number;
};

export type BrowserChatPermissionProfileRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  projectId: string;
  plan: 'off' | 'read' | 'project_developer' | 'full_local_developer' | 'custom';
  serializedProfile: string;
  createdAt: number;
  updatedAt: number;
};

export const DB_NAME = 'jarvis-v1';
/** Current schema version — bumped to 12 for durable Browser Chat permission profiles. */
export const DB_VERSION = 12;

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
// prettier-ignore
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
// prettier-ignore
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

/** V3 schema = V2 + immutable Shared Intelligence Kernel stores. */
export const STORES_V3 = {
  ...STORES_V2,
  jarvis_identity_revisions: 'id, identity_id, version, &[identity_id+version], created_at',
  jarvis_profiles: 'id, account_id, [account_id+active], updated_at',
  jarvis_runs:
    'id, account_id, chat_id, parent_run_id, status, [account_id+updated_at], [chat_id+created_at]',
  jarvis_events:
    '[run_id+seq], run_id, idempotency_key, &[run_id+idempotency_key], type, status, created_at',
  jarvis_approvals: 'id, run_id, status, params_hash, created_at',
  jarvis_artifacts: 'id, run_id, kind, created_at',
} as const;

/** V4 schema = V3 + implemented Context Map 2.0 records and recovery infrastructure. */
// prettier-ignore
export const STORES_V4 = {
  ...STORES_V3,
  context_maps:
    'id, accountId, projectId, status, [accountId+updatedAt], [accountId+projectId], [accountId+status]',
  context_sources:
    'id, accountId, mapId, kind, status, [accountId+mapId], [mapId+status], updatedAt',
  context_entities:
    'id, accountId, mapId, sourceId, kind, [accountId+mapId], [mapId+kind], [sourceId+kind], updatedAt',
  context_edges:
    'id, accountId, mapId, sourceEntityId, targetEntityId, kind, [accountId+mapId], [sourceEntityId+kind], [targetEntityId+kind], updatedAt',
  context_provenance:
    'id, accountId, mapId, targetKind, targetId, sourceId, [accountId+mapId], [targetKind+targetId], [sourceId+targetKind], extractedAt',
  context_migration_backups:
    'id, accountId, projectId, status, [accountId+projectId], createdAt',
  context_quarantine:
    'id, accountId, mapId, recordKind, [accountId+mapId], quarantinedAt',
} as const;

/** V5 schema = V4 + Context note, revision, and asset metadata records. */
// prettier-ignore
export const STORES_V5 = {
  ...STORES_V4,
  context_notes:
    'id, accountId, mapId, entityId, sourceId, currentRevisionId, [accountId+mapId], [mapId+status], [accountId+updatedAt]',
  context_note_revisions:
    'id, accountId, mapId, noteId, &[noteId+sequence], [accountId+mapId], [accountId+noteId], createdAt',
  context_assets:
    'id, accountId, mapId, entityId, sourceId, kind, status, [accountId+mapId], [entityId+kind], [sourceId+kind], [mapId+status], [accountId+updatedAt]',
} as const;

/** V6 schema = V5 + local-only Context embedding vectors and version/provenance metadata. */
// prettier-ignore
export const STORES_V6 = {
  ...STORES_V5,
  context_embeddings:
    'id, accountId, mapId, documentId, sourceId, providerKind, providerId, modelId, embeddingVersion, [accountId+mapId], [accountId+mapId+documentId], [accountId+mapId+embeddingVersion], updatedAt',
} as const;

/** V7 schema = V6 + local, account-scoped Prompt Forge recovery records. */
// prettier-ignore
export const STORES_V7 = {
  ...STORES_V6,
  prompt_forge_jobs:
    'id, accountId, chatId, projectId, status, [accountId+updatedAt], [accountId+chatId], [accountId+status]',
} as const;

/** V8 schema = V7 + Infinite Idea Canvas tables (additive). */
// prettier-ignore
export const STORES_V8 = {
  ...STORES_V7,
  canvas_documents:
    'id, accountId, ownerId, projectId, [accountId+projectId], [accountId+ownerId], [accountId+updatedAt]',
  canvas_pages:
    'id, accountId, documentId, &[documentId+pageIndex], &[documentId+blockId], [accountId+documentId]',
  canvas_objects: 'id, accountId, documentId, kind, [accountId+documentId], [documentId+kind]',
  canvas_spatial: 'id, accountId, documentId, &[documentId+blockId], [accountId+documentId]',
  canvas_cameras: 'documentId, accountId, updatedAt',
  canvas_assets:
    'id, accountId, ownerId, projectId, documentId, kind, [accountId+documentId], [accountId+projectId], [documentId+kind], orphanedAt',
  canvas_templates:
    'id, accountId, ownerId, projectId, [accountId+projectId], [accountId+ownerId], [accountId+updatedAt]',
  canvas_revisions:
    'id, accountId, documentId, &[documentId+sequence], [accountId+documentId], [documentId+localRevision], createdAt',
  canvas_tombstones:
    'id, accountId, documentId, entityId, entityKind, [accountId+documentId], [documentId+entityKind], deletedAt',
  canvas_recovery:
    'id, accountId, documentId, kind, status, [accountId+documentId], [documentId+status], [documentId+kind], createdAt',
} as const;

/**
 * V9 keeps the legacy memory indexes so pre-existing readers and rows remain
 * valid, adds account-scoped evidence indexes to that same store, and adds an
 * append-only revision history. Rows without `recordKind: "evidence"` remain
 * byte-for-byte intact and are intentionally invisible to the evidence repo.
 */
// prettier-ignore
export const STORES_V9 = {
  ...STORES_V8,
  memory_items:
    'id, workspace_id, project_id, agent_id, [workspace_id+source], last_accessed_at, recordKind, ownerId, profileId, workspaceId, projectId, status, category, [ownerId+status], [ownerId+workspaceId], [ownerId+workspaceId+projectId], updatedAt',
  memory_evidence_history:
    'id, evidenceId, ownerId, revision, &[evidenceId+revision], [ownerId+evidenceId], createdAt',
} as const;

/** V10 adds local-first, account/workspace-scoped Browser Chat records. */
// prettier-ignore
export const STORES_V10 = {
  ...STORES_V9,
  browser_chat_bindings:
    'id, accountId, workspaceId, projectId, chatId, provider, bindingState, pinned, updatedAt, &[accountId+workspaceId+chatId], &[accountId+workspaceId+provider+providerProfileKey+providerConversationKey], [accountId+workspaceId], [accountId+workspaceId+projectId], [accountId+workspaceId+pinned], [accountId+workspaceId+updatedAt]',
  provider_project_links:
    'id, accountId, workspaceId, projectId, provider, state, updatedAt, &[accountId+workspaceId+projectId+provider], [accountId+workspaceId], [accountId+workspaceId+projectId]',
} as const;

/** V11 adds provider-owned export snapshots without entering native message authority. */
// prettier-ignore
export const STORES_V11 = {
  ...STORES_V10,
  browser_chat_imports:
    'id, accountId, workspaceId, provider, fileHash, status, importedAt, &[accountId+workspaceId+provider+fileHash], [accountId+workspaceId], [accountId+workspaceId+importedAt]',
  browser_chat_snapshots:
    'id, accountId, workspaceId, provider, providerConversationKey, importId, updatedAt, &[accountId+workspaceId+provider+providerConversationKey], [accountId+workspaceId], [accountId+workspaceId+updatedAt], [accountId+workspaceId+importId]',
} as const;

/** V12 adds one durable permission profile per account/workspace/project scope. */
// prettier-ignore
export const STORES_V12 = {
  ...STORES_V11,
  browser_chat_permission_profiles:
    'id, accountId, workspaceId, projectId, plan, updatedAt, &[accountId+workspaceId+projectId], [accountId+workspaceId]',
} as const;

export const STORES = STORES_V12;

export type StoreName = keyof typeof STORES;

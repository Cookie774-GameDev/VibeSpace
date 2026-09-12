import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Dexie, { type EntityTable, type Table } from 'dexie';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { Agent } from '@/types/agent';
import type { Chat, Message } from '@/types/chat';
import type { EventRow } from '@/types/event';
import type { Integration } from '@/types/integration';
import type { MemoryItem } from '@/types/memory';
import type { QuickLink, QuickLinkGroup } from '@/types/quick-link';
import type { Task } from '@/types/task';
import type {
  TerminalLayout,
  TerminalPreset,
  TerminalScrollbackChunk,
  TerminalSession,
} from '@/types/terminal';
import type {
  ContextAssetV2,
  ContextNoteRevisionV2,
  ContextNoteV2,
} from '@/features/context/contentContracts';
import type {
  ContextEdgeV2,
  ContextEntityV2,
  ContextMapRecordV2,
  ContextProvenanceV2,
  ContextSourceV2,
} from '@/features/context/contracts';
import type {
  CanvasBlockId,
  CanvasDocumentId,
  CanvasOwnerId,
  CanvasProjectId,
} from '@/features/canvas/contracts';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createJarvisDb, type JarvisDexie, type JarvisDexieDependencies } from './index';
import {
  DB_VERSION,
  STORES_V1,
  STORES_V2,
  STORES_V3,
  STORES_V4,
  STORES_V5,
  STORES_V6,
  STORES_V7,
  STORES_V8,
  STORES_V9,
  STORES_V10,
  STORES_V11,
  STORES_V12,
  type BrowserChatBindingRow,
  type BrowserChatImportRow,
  type BrowserChatPermissionProfileRow,
  type BrowserChatSnapshotRow,
  type CanvasAssetRow,
  type CanvasCameraRow,
  type CanvasDocumentRow,
  type CanvasObjectRow,
  type CanvasPageRow,
  type CanvasRecoveryRow,
  type CanvasRevisionRow,
  type CanvasSpatialRow,
  type CanvasTemplateRow,
  type CanvasTombstoneRow,
  type ContextAssetRow,
  type ContextEmbeddingRow,
  type ContextMigrationBackupRow,
  type ContextNoteRevisionRow,
  type ContextNoteRow,
  type ContextQuarantineRow,
  type JarvisApprovalRow,
  type JarvisArtifactRow,
  type JarvisEventRow,
  type JarvisIdentityRevisionRow,
  type JarvisProfileRow,
  type JarvisRunRow,
  type MemoryEvidenceHistoryRow,
  type MemoryEvidenceRow,
  type Project,
  type ProviderProjectLinkRow,
  type PromptForgeJobRow,
  type SettingsRow,
  type SyncQueueRow,
  type Workspace,
} from './schema';

const EXPECTED_STORES_V1 = {
  workspaces: 'id, name, owner_id, updated_at',
  projects: 'id, workspace_id, name, updated_at',
  chats: 'id, workspace_id, project_id, [archived+updated_at], updated_at',
  messages: 'id, chat_id, [chat_id+created_at], parent_id',
  agents: 'id, &slug',
  tasks:
    'id, workspace_id, project_id, status, [status+priority], due_at, scheduled_for, [workspace_id+status]',
  memory_items: 'id, workspace_id, project_id, agent_id, [workspace_id+source], last_accessed_at',
  settings: 'key',
  sync_queue: 'id, status, created_at',
} as const;

const EXPECTED_STORES_V2 = {
  ...EXPECTED_STORES_V1,
  events: 'id, workspace_id, project_id, start_at, [workspace_id+start_at], status',
  quick_links:
    'id, workspace_id, group_id, [workspace_id+position], [workspace_id+group_id+position], last_used_at',
  quick_link_groups: 'id, workspace_id, [workspace_id+position]',
  terminal_presets: 'id, workspace_id, &[workspace_id+slug]',
  terminal_sessions: 'id, project_id, workspace_id, status, [project_id+status], last_active_at',
  terminal_scrollback: '[session_id+chunk_seq], session_id, created_at',
  terminal_layouts: 'project_id, updated_at',
  integrations: 'id, &kind',
} as const;

const EXPECTED_STORES_V3 = {
  ...EXPECTED_STORES_V2,
  jarvis_identity_revisions: 'id, identity_id, version, &[identity_id+version], created_at',
  jarvis_profiles: 'id, account_id, [account_id+active], updated_at',
  jarvis_runs:
    'id, account_id, chat_id, parent_run_id, status, [account_id+updated_at], [chat_id+created_at]',
  jarvis_events:
    '[run_id+seq], run_id, idempotency_key, &[run_id+idempotency_key], type, status, created_at',
  jarvis_approvals: 'id, run_id, status, params_hash, created_at',
  jarvis_artifacts: 'id, run_id, kind, created_at',
} as const;

const EXPECTED_STORES_V4 = {
  ...EXPECTED_STORES_V3,
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
  context_migration_backups: 'id, accountId, projectId, status, [accountId+projectId], createdAt',
  context_quarantine: 'id, accountId, mapId, recordKind, [accountId+mapId], quarantinedAt',
} as const;

const EXPECTED_STORES_V5 = {
  ...EXPECTED_STORES_V4,
  context_notes:
    'id, accountId, mapId, entityId, sourceId, currentRevisionId, [accountId+mapId], [mapId+status], [accountId+updatedAt]',
  context_note_revisions:
    'id, accountId, mapId, noteId, &[noteId+sequence], [accountId+mapId], [accountId+noteId], createdAt',
  context_assets:
    'id, accountId, mapId, entityId, sourceId, kind, status, [accountId+mapId], [entityId+kind], [sourceId+kind], [mapId+status], [accountId+updatedAt]',
} as const;

const EXPECTED_STORES_V6 = {
  ...EXPECTED_STORES_V5,
  context_embeddings:
    'id, accountId, mapId, documentId, sourceId, providerKind, providerId, modelId, embeddingVersion, [accountId+mapId], [accountId+mapId+documentId], [accountId+mapId+embeddingVersion], updatedAt',
} as const;

const EXPECTED_STORES_V7 = {
  ...EXPECTED_STORES_V6,
  prompt_forge_jobs:
    'id, accountId, chatId, projectId, status, [accountId+updatedAt], [accountId+chatId], [accountId+status]',
} as const;

const EXPECTED_STORES_V8 = {
  ...EXPECTED_STORES_V7,
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

const EXPECTED_STORES_V9 = {
  ...EXPECTED_STORES_V8,
  memory_items:
    'id, workspace_id, project_id, agent_id, [workspace_id+source], last_accessed_at, recordKind, ownerId, profileId, workspaceId, projectId, status, category, [ownerId+status], [ownerId+workspaceId], [ownerId+workspaceId+projectId], updatedAt',
  memory_evidence_history:
    'id, evidenceId, ownerId, revision, &[evidenceId+revision], [ownerId+evidenceId], createdAt',
} as const;

const EXPECTED_STORES_V10 = {
  ...EXPECTED_STORES_V9,
  browser_chat_bindings:
    'id, accountId, workspaceId, projectId, chatId, provider, bindingState, pinned, updatedAt, &[accountId+workspaceId+chatId], &[accountId+workspaceId+provider+providerProfileKey+providerConversationKey], [accountId+workspaceId], [accountId+workspaceId+projectId], [accountId+workspaceId+pinned], [accountId+workspaceId+updatedAt]',
  provider_project_links:
    'id, accountId, workspaceId, projectId, provider, state, updatedAt, &[accountId+workspaceId+projectId+provider], [accountId+workspaceId], [accountId+workspaceId+projectId]',
} as const;

const EXPECTED_STORES_V11 = {
  ...EXPECTED_STORES_V10,
  browser_chat_imports:
    'id, accountId, workspaceId, provider, fileHash, status, importedAt, &[accountId+workspaceId+provider+fileHash], [accountId+workspaceId], [accountId+workspaceId+importedAt]',
  browser_chat_snapshots:
    'id, accountId, workspaceId, provider, providerConversationKey, importId, updatedAt, &[accountId+workspaceId+provider+providerConversationKey], [accountId+workspaceId], [accountId+workspaceId+updatedAt], [accountId+workspaceId+importId]',
} as const;

const EXPECTED_STORES_V12 = {
  ...EXPECTED_STORES_V11,
  browser_chat_permission_profiles:
    'id, accountId, workspaceId, projectId, plan, updatedAt, &[accountId+workspaceId+projectId], [accountId+workspaceId]',
} as const;

const EXPECTED_STORES_V1_SOURCE = `export const STORES_V1 = {
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
} as const;`;

const EXPECTED_STORES_V2_SOURCE = `export const STORES_V2 = {
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
} as const;`;

const EXPECTED_STORES_V3_SOURCE = `export const STORES_V3 = {
  ...STORES_V2,
  jarvis_identity_revisions: 'id, identity_id, version, &[identity_id+version], created_at',
  jarvis_profiles: 'id, account_id, [account_id+active], updated_at',
  jarvis_runs:
    'id, account_id, chat_id, parent_run_id, status, [account_id+updated_at], [chat_id+created_at]',
  jarvis_events:
    '[run_id+seq], run_id, idempotency_key, &[run_id+idempotency_key], type, status, created_at',
  jarvis_approvals: 'id, run_id, status, params_hash, created_at',
  jarvis_artifacts: 'id, run_id, kind, created_at',
} as const;`;

const EXPECTED_STORES_V4_SOURCE = `export const STORES_V4 = {
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
} as const;`;

const V1_ROWS = {
  workspaces: {
    id: 'workspace-v1',
    name: 'Legacy workspace',
    owner_id: 'account-v1',
    created_at: 1,
    updated_at: 2,
    marker: { nested: ['byte', 'stable'] },
  },
  projects: {
    id: 'project-v1',
    workspace_id: 'workspace-v1',
    name: 'Legacy project',
    created_at: 3,
    updated_at: 4,
    marker: 'project-marker',
  },
  chats: {
    id: 'chat-v1',
    workspace_id: 'workspace-v1',
    project_id: 'project-v1',
    archived: false,
    created_at: 5,
    updated_at: 6,
    marker: 101,
  },
  messages: {
    id: 'message-v1',
    chat_id: 'chat-v1',
    parent_id: null,
    created_at: 7,
    marker: ['message-marker'],
  },
  agents: { id: 'agent-v1', slug: 'legacy-agent', marker: true },
  tasks: {
    id: 'task-v1',
    workspace_id: 'workspace-v1',
    project_id: 'project-v1',
    status: 'todo',
    priority: 1,
    due_at: 8,
    scheduled_for: 9,
    marker: 'task-marker',
  },
  memory_items: {
    id: 'memory-v1',
    workspace_id: 'workspace-v1',
    project_id: 'project-v1',
    agent_id: 'agent-v1',
    source: 'manual',
    last_accessed_at: 10,
    marker: { retained: true },
  },
  settings: { key: 'legacy-setting', value: { enabled: true }, updated_at: 11 },
  sync_queue: {
    id: 'sync-v1',
    status: 'pending',
    created_at: 12,
    marker: 'sync-marker',
  },
} as const;

const V2_ROWS = {
  ...V1_ROWS,
  events: {
    id: 'event-v2',
    workspace_id: 'workspace-v1',
    project_id: 'project-v1',
    start_at: 13,
    status: 'scheduled',
    marker: 'event-marker',
  },
  quick_links: {
    id: 'link-v2',
    workspace_id: 'workspace-v1',
    group_id: 'group-v2',
    position: 1,
    last_used_at: 14,
    marker: 'link-marker',
  },
  quick_link_groups: {
    id: 'group-v2',
    workspace_id: 'workspace-v1',
    position: 1,
    marker: 'group-marker',
  },
  terminal_presets: {
    id: 'preset-v2',
    workspace_id: 'workspace-v1',
    slug: 'legacy-shell',
    marker: 'preset-marker',
  },
  terminal_sessions: {
    id: 'session-v2',
    project_id: 'project-v1',
    workspace_id: 'workspace-v1',
    status: 'stopped',
    last_active_at: 15,
    marker: 'session-marker',
  },
  terminal_scrollback: {
    session_id: 'session-v2',
    chunk_seq: 1,
    created_at: 16,
    marker: 'scrollback-marker',
  },
  terminal_layouts: {
    project_id: 'project-v1',
    updated_at: 17,
    marker: 'layout-marker',
  },
  integrations: { id: 'integration-v2', kind: 'github', marker: 'integration-marker' },
} as const;

const V3_ROWS = {
  ...V2_ROWS,
  jarvis_identity_revisions: {
    id: 'identity-v3',
    identity_id: 'jarvis',
    version: 1,
    created_at: 18,
    marker: 'identity-marker',
  },
  jarvis_profiles: {
    id: 'profile-v3',
    account_id: 'account-v3',
    active: 1,
    updated_at: 19,
    marker: 'profile-marker',
  },
  jarvis_runs: {
    id: 'run-v3',
    account_id: 'account-v3',
    chat_id: 'chat-v1',
    status: 'completed',
    created_at: 20,
    updated_at: 21,
    marker: 'run-marker',
  },
  jarvis_events: {
    run_id: 'run-v3',
    seq: 1,
    idempotency_key: 'event-v3',
    type: 'message',
    created_at: 22,
    marker: 'jarvis-event-marker',
  },
  jarvis_approvals: {
    id: 'approval-v3',
    run_id: 'run-v3',
    status: 'consumed',
    params_hash: 'params-hash',
    created_at: 23,
    marker: 'approval-marker',
  },
  jarvis_artifacts: {
    id: 'artifact-v3',
    run_id: 'run-v3',
    kind: 'text',
    created_at: 24,
    marker: 'artifact-marker',
  },
} as const;

const V4_ROWS = {
  ...V3_ROWS,
  context_maps: {
    id: 'map-v4',
    accountId: 'account-v4',
    projectId: 'project-v1',
    status: 'active',
    updatedAt: 25,
    marker: 'context-map-marker',
  },
  context_sources: {
    id: 'source-v4',
    accountId: 'account-v4',
    mapId: 'map-v4',
    kind: 'manual',
    status: 'ready',
    updatedAt: 26,
    marker: 'context-source-marker',
  },
  context_entities: {
    id: 'entity-v4',
    accountId: 'account-v4',
    mapId: 'map-v4',
    sourceId: 'source-v4',
    kind: 'note',
    updatedAt: 27,
    marker: 'context-entity-marker',
  },
  context_edges: {
    id: 'edge-v4',
    accountId: 'account-v4',
    mapId: 'map-v4',
    sourceEntityId: 'entity-v4',
    targetEntityId: 'entity-v4-target',
    kind: 'references',
    updatedAt: 28,
    marker: 'context-edge-marker',
  },
  context_provenance: {
    id: 'provenance-v4',
    accountId: 'account-v4',
    mapId: 'map-v4',
    targetKind: 'entity',
    targetId: 'entity-v4',
    sourceId: 'source-v4',
    extractedAt: 29,
    marker: 'context-provenance-marker',
  },
  context_migration_backups: {
    id: 'backup-v4',
    accountId: 'account-v4',
    projectId: 'project-v1',
    status: 'verified',
    createdAt: 30,
    marker: 'context-backup-marker',
  },
  context_quarantine: {
    id: 'quarantine-v4',
    accountId: 'account-v4',
    mapId: 'map-v4',
    recordKind: 'entity',
    quarantinedAt: 31,
    marker: 'context-quarantine-marker',
  },
} as const;

const V7_ROWS = {
  ...V4_ROWS,
  context_notes: {
    id: 'note-v7',
    accountId: 'account-v7',
    mapId: 'map-v7',
    entityId: 'entity-v7',
    sourceId: 'source-v7',
    currentRevisionId: 'revision-v7',
    status: 'active',
    updatedAt: 50,
    marker: 'context-note-marker',
  },
  context_embeddings: {
    id: 'embedding-v7',
    accountId: 'account-v7',
    mapId: 'map-v7',
    documentId: 'document-v7',
    sourceId: 'source-v7',
    providerKind: 'openai',
    providerId: 'provider-v7',
    modelId: 'model-v7',
    embeddingVersion: 1,
    updatedAt: 51,
    marker: 'context-embedding-marker',
  },
  prompt_forge_jobs: {
    id: 'forge-v7',
    accountId: 'account-v7',
    chatId: 'chat-v1',
    projectId: 'project-v1',
    status: 'pending',
    updatedAt: 52,
    marker: 'prompt-forge-marker',
  },
} as const;

const createdNames = new Set<string>();
const openedDatabases = new Set<Dexie>();

function testDbName(prefix: string): string {
  const name = uniqueTestDbName(prefix);
  createdNames.add(name);
  return name;
}

async function deleteTestDb(name: string): Promise<void> {
  const cleanup = new Dexie(name, TEST_INDEXED_DB);
  await cleanup.delete();
}

async function createLegacyDb(name: string, version: 1 | 2 | 3 | 4 | 5 | 6 | 7): Promise<Dexie> {
  const database = new Dexie(name, TEST_INDEXED_DB);
  openedDatabases.add(database);
  database.version(1).stores(STORES_V1);
  if (version === 2) database.version(2).stores(STORES_V2);
  if (version === 3) {
    database.version(2).stores(STORES_V2);
    database.version(3).stores(STORES_V3);
  }
  if (version === 4) {
    database.version(2).stores(STORES_V2);
    database.version(3).stores(STORES_V3);
    database.version(4).stores(STORES_V4);
  }
  if (version === 5) {
    database.version(2).stores(STORES_V2);
    database.version(3).stores(STORES_V3);
    database.version(4).stores(STORES_V4);
    database.version(5).stores(STORES_V5);
  }
  if (version === 6) {
    database.version(2).stores(STORES_V2);
    database.version(3).stores(STORES_V3);
    database.version(4).stores(STORES_V4);
    database.version(5).stores(STORES_V5);
    database.version(6).stores(STORES_V6);
  }
  if (version === 7) {
    database.version(2).stores(STORES_V2);
    database.version(3).stores(STORES_V3);
    database.version(4).stores(STORES_V4);
    database.version(5).stores(STORES_V5);
    database.version(6).stores(STORES_V6);
    database.version(7).stores(STORES_V7);
  }
  await database.open();
  return database;
}

function createTestJarvisDb(name: string): JarvisDexie {
  const database = createJarvisDb(name, TEST_INDEXED_DB);
  openedDatabases.add(database);
  return database;
}

async function insertRows(database: Dexie, rows: Record<string, object>): Promise<void> {
  for (const [tableName, row] of Object.entries(rows)) {
    await database.table(tableName).put(structuredClone(row));
  }
}

async function expectRows(database: Dexie, rows: Record<string, object>): Promise<void> {
  for (const [tableName, row] of Object.entries(rows)) {
    await expect(database.table(tableName).toArray()).resolves.toEqual([row]);
  }
}

function frozenStoreBlock(
  source: string,
  name: 'STORES_V1' | 'STORES_V2' | 'STORES_V3' | 'STORES_V4',
): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(`export const ${name} =`);
  const end = normalized.indexOf('\n} as const;', start);
  if (start < 0 || end < 0) throw new Error(`Missing frozen ${name} block.`);
  return normalized.slice(start, end + '\n} as const;'.length);
}

afterEach(async () => {
  for (const database of openedDatabases) database.close();
  for (const name of createdNames) await deleteTestDb(name);
  openedDatabases.clear();
  createdNames.clear();
});

describe('Jarvis Dexie V12 additive migration', () => {
  it('keeps the exact V1 through V4 declarations and advances only the active version', () => {
    const schemaSource = readFileSync(join(__dirname, 'schema.ts'), 'utf8');
    expect(STORES_V1).toEqual(EXPECTED_STORES_V1);
    expect(STORES_V2).toEqual(EXPECTED_STORES_V2);
    expect(STORES_V3).toEqual(EXPECTED_STORES_V3);
    expect(STORES_V4).toEqual(EXPECTED_STORES_V4);
    expect(STORES_V5).toEqual(EXPECTED_STORES_V5);
    expect(STORES_V6).toEqual(EXPECTED_STORES_V6);
    expect(STORES_V7).toEqual(EXPECTED_STORES_V7);
    expect(STORES_V8).toEqual(EXPECTED_STORES_V8);
    expect(STORES_V9).toEqual(EXPECTED_STORES_V9);
    expect(STORES_V10).toEqual(EXPECTED_STORES_V10);
    expect(STORES_V11).toEqual(EXPECTED_STORES_V11);
    expect(STORES_V12).toEqual(EXPECTED_STORES_V12);
    expect(frozenStoreBlock(schemaSource, 'STORES_V1')).toBe(EXPECTED_STORES_V1_SOURCE);
    expect(frozenStoreBlock(schemaSource, 'STORES_V2')).toBe(EXPECTED_STORES_V2_SOURCE);
    expect(frozenStoreBlock(schemaSource, 'STORES_V3')).toBe(EXPECTED_STORES_V3_SOURCE);
    expect(frozenStoreBlock(schemaSource, 'STORES_V4')).toBe(EXPECTED_STORES_V4_SOURCE);
    expect(DB_VERSION).toBe(12);
  });

  it('opens durable Browser Chat workspace, import, and permission stores on a fresh V12 database', async () => {
    const database = createTestJarvisDb(testDbName('jarvis-v12-browser-chat-fresh'));
    await database.open();

    expect(database.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        'browser_chat_bindings',
        'provider_project_links',
        'browser_chat_imports',
        'browser_chat_snapshots',
        'browser_chat_permission_profiles',
      ]),
    );
    expect(database.table('browser_chat_bindings').schema.primKey.name).toBe('id');
    expect(database.table('provider_project_links').schema.primKey.name).toBe('id');
    expect(database.table('browser_chat_imports').schema.primKey.name).toBe('id');
    expect(database.table('browser_chat_snapshots').schema.primKey.name).toBe('id');
    expect(database.table('browser_chat_permission_profiles').schema.primKey.name).toBe('id');
  });

  it('opens every prior store plus Browser Chat permissions on a fresh V12 database', async () => {
    const database = createTestJarvisDb(testDbName('jarvis-v12-fresh'));
    await database.open();

    expect(database.tables.map((table) => table.name).sort()).toEqual(
      Object.keys(STORES_V12).sort(),
    );
    expect(database.agents.name).toBe('agents');
    expect(database.settings.name).toBe('settings');
    expect(database.jarvis_events.name).toBe('jarvis_events');
    expect(database.context_maps.name).toBe('context_maps');
    expect(database.context_quarantine.name).toBe('context_quarantine');
    expect(database.context_notes.name).toBe('context_notes');
    expect(database.context_note_revisions.name).toBe('context_note_revisions');
    expect(database.context_assets.name).toBe('context_assets');
    expect(database.context_embeddings.name).toBe('context_embeddings');
    expect(database.prompt_forge_jobs.name).toBe('prompt_forge_jobs');
    expect(database.canvas_documents.name).toBe('canvas_documents');
    expect(database.canvas_pages.name).toBe('canvas_pages');
    expect(database.canvas_objects.name).toBe('canvas_objects');
    expect(database.canvas_spatial.name).toBe('canvas_spatial');
    expect(database.canvas_cameras.name).toBe('canvas_cameras');
    expect(database.canvas_assets.name).toBe('canvas_assets');
    expect(database.canvas_templates.name).toBe('canvas_templates');
    expect(database.canvas_revisions.name).toBe('canvas_revisions');
    expect(database.canvas_tombstones.name).toBe('canvas_tombstones');
    expect(database.canvas_recovery.name).toBe('canvas_recovery');

    expectTypeOf<JarvisDexie['workspaces']>().toEqualTypeOf<EntityTable<Workspace, 'id'>>();
    expectTypeOf<JarvisDexie['projects']>().toEqualTypeOf<EntityTable<Project, 'id'>>();
    expectTypeOf<JarvisDexie['browser_chat_bindings']>().toEqualTypeOf<
      EntityTable<BrowserChatBindingRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['provider_project_links']>().toEqualTypeOf<
      EntityTable<ProviderProjectLinkRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['browser_chat_imports']>().toEqualTypeOf<
      EntityTable<BrowserChatImportRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['browser_chat_snapshots']>().toEqualTypeOf<
      EntityTable<BrowserChatSnapshotRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['browser_chat_permission_profiles']>().toEqualTypeOf<
      EntityTable<BrowserChatPermissionProfileRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['chats']>().toEqualTypeOf<EntityTable<Chat, 'id'>>();
    expectTypeOf<JarvisDexie['messages']>().toEqualTypeOf<EntityTable<Message, 'id'>>();
    expectTypeOf<JarvisDexie['agents']>().toEqualTypeOf<EntityTable<Agent, 'id'>>();
    expectTypeOf<JarvisDexie['tasks']>().toEqualTypeOf<EntityTable<Task, 'id'>>();
    expectTypeOf<JarvisDexie['memory_items']>().toEqualTypeOf<
      EntityTable<MemoryItem | MemoryEvidenceRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['memory_evidence_history']>().toEqualTypeOf<
      EntityTable<MemoryEvidenceHistoryRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['settings']>().toEqualTypeOf<EntityTable<SettingsRow, 'key'>>();
    expectTypeOf<JarvisDexie['sync_queue']>().toEqualTypeOf<EntityTable<SyncQueueRow, 'id'>>();
    expectTypeOf<JarvisDexie['events']>().toEqualTypeOf<EntityTable<EventRow, 'id'>>();
    expectTypeOf<JarvisDexie['quick_links']>().toEqualTypeOf<EntityTable<QuickLink, 'id'>>();
    expectTypeOf<JarvisDexie['quick_link_groups']>().toEqualTypeOf<
      EntityTable<QuickLinkGroup, 'id'>
    >();
    expectTypeOf<JarvisDexie['terminal_presets']>().toEqualTypeOf<
      EntityTable<TerminalPreset, 'id'>
    >();
    expectTypeOf<JarvisDexie['terminal_sessions']>().toEqualTypeOf<
      EntityTable<TerminalSession, 'id'>
    >();
    expectTypeOf<JarvisDexie['terminal_scrollback']>().toEqualTypeOf<
      EntityTable<TerminalScrollbackChunk, 'session_id'>
    >();
    expectTypeOf<JarvisDexie['terminal_layouts']>().toEqualTypeOf<
      EntityTable<TerminalLayout, 'project_id'>
    >();
    expectTypeOf<JarvisDexie['integrations']>().toEqualTypeOf<EntityTable<Integration, 'id'>>();
    expectTypeOf<JarvisDexie['jarvis_identity_revisions']>().toEqualTypeOf<
      EntityTable<JarvisIdentityRevisionRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['jarvis_profiles']>().toEqualTypeOf<
      EntityTable<JarvisProfileRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['jarvis_runs']>().toEqualTypeOf<EntityTable<JarvisRunRow, 'id'>>();
    expectTypeOf<JarvisDexie['jarvis_events']>().toEqualTypeOf<
      Table<JarvisEventRow, [string, number]>
    >();
    expectTypeOf<JarvisDexie['jarvis_approvals']>().toEqualTypeOf<
      EntityTable<JarvisApprovalRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['jarvis_artifacts']>().toEqualTypeOf<
      EntityTable<JarvisArtifactRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_maps']>().toEqualTypeOf<
      EntityTable<ContextMapRecordV2, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_sources']>().toEqualTypeOf<
      EntityTable<ContextSourceV2, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_entities']>().toEqualTypeOf<
      EntityTable<ContextEntityV2, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_edges']>().toEqualTypeOf<EntityTable<ContextEdgeV2, 'id'>>();
    expectTypeOf<JarvisDexie['context_provenance']>().toEqualTypeOf<
      EntityTable<ContextProvenanceV2, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_migration_backups']>().toEqualTypeOf<
      EntityTable<ContextMigrationBackupRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_quarantine']>().toEqualTypeOf<
      EntityTable<ContextQuarantineRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_notes']>().toEqualTypeOf<EntityTable<ContextNoteV2, 'id'>>();
    expectTypeOf<JarvisDexie['context_note_revisions']>().toEqualTypeOf<
      EntityTable<ContextNoteRevisionV2, 'id'>
    >();
    expectTypeOf<JarvisDexie['context_assets']>().toEqualTypeOf<
      EntityTable<ContextAssetV2, 'id'>
    >();
    expectTypeOf<ContextNoteRow>().toEqualTypeOf<ContextNoteV2>();
    expectTypeOf<ContextNoteRevisionRow>().toEqualTypeOf<ContextNoteRevisionV2>();
    expectTypeOf<ContextAssetRow>().toEqualTypeOf<ContextAssetV2>();
    expectTypeOf<JarvisDexie['context_embeddings']>().toEqualTypeOf<
      EntityTable<ContextEmbeddingRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['prompt_forge_jobs']>().toEqualTypeOf<
      EntityTable<PromptForgeJobRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_documents']>().toEqualTypeOf<
      EntityTable<CanvasDocumentRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_pages']>().toEqualTypeOf<EntityTable<CanvasPageRow, 'id'>>();
    expectTypeOf<JarvisDexie['canvas_objects']>().toEqualTypeOf<
      EntityTable<CanvasObjectRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_spatial']>().toEqualTypeOf<
      EntityTable<CanvasSpatialRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_cameras']>().toEqualTypeOf<
      EntityTable<CanvasCameraRow, 'documentId'>
    >();
    expectTypeOf<JarvisDexie['canvas_assets']>().toEqualTypeOf<EntityTable<CanvasAssetRow, 'id'>>();
    expectTypeOf<JarvisDexie['canvas_templates']>().toEqualTypeOf<
      EntityTable<CanvasTemplateRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_revisions']>().toEqualTypeOf<
      EntityTable<CanvasRevisionRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_tombstones']>().toEqualTypeOf<
      EntityTable<CanvasTombstoneRow, 'id'>
    >();
    expectTypeOf<JarvisDexie['canvas_recovery']>().toEqualTypeOf<
      EntityTable<CanvasRecoveryRow, 'id'>
    >();
    expectTypeOf(createJarvisDb).toEqualTypeOf<
      (name?: string, dependencies?: JarvisDexieDependencies) => JarvisDexie
    >();
    database.close();
  });

  it('preserves V9 rows when V10 adds empty Browser Chat stores', async () => {
    const name = testDbName('jarvis-v9-to-v10-browser-chat');
    const legacy = new Dexie(name, TEST_INDEXED_DB);
    openedDatabases.add(legacy);
    legacy.version(1).stores(STORES_V1);
    legacy.version(2).stores(STORES_V2);
    legacy.version(3).stores(STORES_V3);
    legacy.version(4).stores(STORES_V4);
    legacy.version(5).stores(STORES_V5);
    legacy.version(6).stores(STORES_V6);
    legacy.version(7).stores(STORES_V7);
    legacy.version(8).stores(STORES_V8);
    legacy.version(9).stores(STORES_V9);
    await legacy.open();
    const preserved = {
      id: 'evidence-history-v9',
      evidenceId: 'evidence-v9',
      ownerId: 'owner-v9',
      revision: 1,
      snapshot: { summary: 'preserve me' },
      createdAt: 900,
    };
    await legacy.table('memory_evidence_history').add(preserved);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();

    await expect(upgraded.memory_evidence_history.toArray()).resolves.toEqual([preserved]);
    await expect(upgraded.browser_chat_bindings.toArray()).resolves.toEqual([]);
    await expect(upgraded.provider_project_links.toArray()).resolves.toEqual([]);
  });

  it('preserves V10 Browser Chat rows when V11 adds empty import snapshot stores', async () => {
    const name = testDbName('jarvis-v10-to-v11-browser-chat-imports');
    const legacy = new Dexie(name, TEST_INDEXED_DB);
    openedDatabases.add(legacy);
    legacy.version(10).stores(STORES_V10);
    await legacy.open();
    const preserved = {
      id: 'binding-v10',
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      chatId: 'chat-a',
      provider: 'chatgpt',
      providerProfileKey: 'browser-chat/chatgpt',
      bindingState: 'new',
      localTitle: 'Preserve me',
      pinned: false,
      viewMode: 'provider',
      createdAt: 10,
      updatedAt: 10,
    };
    await legacy.table('browser_chat_bindings').add(preserved);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();

    await expect(upgraded.browser_chat_bindings.toArray()).resolves.toEqual([preserved]);
    await expect(upgraded.browser_chat_imports.toArray()).resolves.toEqual([]);
    await expect(upgraded.browser_chat_snapshots.toArray()).resolves.toEqual([]);
  });

  it('preserves every inserted V1 row byte-for-byte when opening V5', async () => {
    const name = testDbName('jarvis-v1-to-v5');
    const legacy = await createLegacyDb(name, 1);
    await insertRows(legacy, V1_ROWS);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();
    await expectRows(upgraded, V1_ROWS);
    upgraded.close();
  });

  it('preserves every inserted V1 and V2 row byte-for-byte when opening V5', async () => {
    const name = testDbName('jarvis-v2-to-v5');
    const legacy = await createLegacyDb(name, 2);
    await insertRows(legacy, V2_ROWS);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();
    await expectRows(upgraded, V2_ROWS);
    upgraded.close();
  });

  it('preserves every inserted V1 through V3 row byte-for-byte when opening V5', async () => {
    const name = testDbName('jarvis-v3-to-v5');
    const legacy = await createLegacyDb(name, 3);
    await insertRows(legacy, V3_ROWS);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();
    await expectRows(upgraded, V3_ROWS);
    upgraded.close();
  });

  it('preserves every inserted V1 through V4 row byte-for-byte when opening V5', async () => {
    const name = testDbName('jarvis-v4-to-v5');
    const legacy = await createLegacyDb(name, 4);
    await insertRows(legacy, V4_ROWS);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();
    await expectRows(upgraded, V4_ROWS);
    upgraded.close();
  });

  it('reopens V5 idempotently without replacing existing rows', async () => {
    const name = testDbName('jarvis-v5-reopen');
    const first = createTestJarvisDb(name);
    await first.open();
    await first.workspaces.put(structuredClone(V1_ROWS.workspaces) as never);
    await first.context_notes.put({
      version: 2,
      id: 'note-reopen',
      accountId: 'account-v5',
      mapId: 'map-v5',
      entityId: 'entity-v5',
      sourceId: 'source-v5',
      kind: 'standard',
      title: 'Reopen',
      status: 'active',
      storageMode: 'app_managed',
      storageRootId: 'context-root',
      relativePath: 'notes/reopen.md',
      contentAssetId: 'asset-v5',
      contentHash: 'a'.repeat(64),
      currentRevisionId: 'revision-v5',
      aliases: [],
      tags: [],
      blockIds: [],
      createdAt: 32,
      updatedAt: 33,
    });
    first.close();

    const reopened = createTestJarvisDb(name);
    await reopened.open();
    await expect(reopened.workspaces.toArray()).resolves.toEqual([V1_ROWS.workspaces]);
    await expect(reopened.context_notes.get('note-reopen')).resolves.toMatchObject({
      id: 'note-reopen',
      currentRevisionId: 'revision-v5',
    });
    reopened.close();
  });

  it('preserves every inserted V1 through V5 row byte-for-byte when opening V6', async () => {
    const name = testDbName('jarvis-v5-to-v6');
    const legacy = await createLegacyDb(name, 5);
    const preservedNote: ContextNoteV2 = {
      version: 2,
      id: 'note-v5-preserved',
      accountId: 'account-v5',
      mapId: 'map-v5',
      entityId: 'entity-v5',
      sourceId: 'source-v5',
      kind: 'standard',
      title: 'Preserved',
      status: 'active',
      storageMode: 'app_managed',
      storageRootId: 'context-root',
      relativePath: 'notes/preserved.md',
      contentAssetId: 'asset-v5',
      contentHash: 'd'.repeat(64),
      currentRevisionId: 'revision-v5',
      aliases: [],
      tags: [],
      blockIds: [],
      createdAt: 40,
      updatedAt: 41,
    };
    await legacy.table('context_notes').put(preservedNote);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();
    await expect(upgraded.context_notes.get('note-v5-preserved')).resolves.toEqual(preservedNote);
    await expect(upgraded.context_embeddings.count()).resolves.toBe(0);
    upgraded.close();
  });

  it('enforces one note revision per note sequence while allowing the same sequence on another note', async () => {
    const database = createTestJarvisDb(testDbName('jarvis-v5-note-revisions'));
    await database.open();
    const revision = (id: string, noteId: string): ContextNoteRevisionV2 => ({
      version: 2,
      id,
      accountId: 'account-v5',
      mapId: 'map-v5',
      noteId,
      sequence: 1,
      changeKind: 'created',
      authorSource: 'user',
      beforeHash: null,
      afterHash: 'b'.repeat(64),
      diffAssetId: `diff-${id}`,
      recoveryMode: 'snapshot',
      recoveryAssetId: `recovery-${id}`,
      createdAt: 34,
    });

    await expect(
      database.context_note_revisions.add(revision('revision-a', 'note-a')),
    ).resolves.toBe('revision-a');
    await expect(
      database.context_note_revisions.add(revision('revision-b', 'note-a')),
    ).rejects.toBeDefined();
    await expect(
      database.context_note_revisions.add(revision('revision-c', 'note-b')),
    ).resolves.toBe('revision-c');
    database.close();
  });

  it('enforces ordered compound event keys and per-run delivery idempotency', async () => {
    const database = createTestJarvisDb(testDbName('jarvis-v3-events'));
    await database.open();
    const event = (runId: string, seq: number, idempotencyKey: string): JarvisEventRow => ({
      run_id: runId,
      seq,
      idempotency_key: idempotencyKey,
      type: 'message',
      title: `Event ${seq}`,
      source_refs: [],
      artifact_ids: [],
      created_at: seq,
    });

    await database.jarvis_events.bulkAdd([
      event('run-a', 3, 'delivery-3'),
      event('run-a', 1, 'delivery-1'),
      event('run-a', 2, 'delivery-2'),
    ]);
    const ordered = await database.jarvis_events
      .where('[run_id+seq]')
      .between(['run-a', Number.MIN_SAFE_INTEGER], ['run-a', Number.MAX_SAFE_INTEGER])
      .toArray();
    expect(ordered.map((row) => row.seq)).toEqual([1, 2, 3]);

    await expect(
      database.jarvis_events.add(event('run-a', 1, 'delivery-other')),
    ).rejects.toBeDefined();
    await expect(database.jarvis_events.add(event('run-a', 4, 'delivery-1'))).rejects.toBeDefined();
    await expect(database.jarvis_events.add(event('run-b', 1, 'delivery-1'))).resolves.toEqual([
      'run-b',
      1,
    ]);
    database.close();
  });

  it('preserves every inserted V1 through V7 row byte-for-byte when opening V8 and adds empty Canvas stores', async () => {
    const name = testDbName('jarvis-v7-to-v8');
    const legacy = await createLegacyDb(name, 7);
    await insertRows(legacy, V7_ROWS);
    legacy.close();

    const upgraded = createTestJarvisDb(name);
    await upgraded.open();
    await expectRows(upgraded, V7_ROWS);
    await expect(upgraded.canvas_documents.count()).resolves.toBe(0);
    await expect(upgraded.canvas_pages.count()).resolves.toBe(0);
    await expect(upgraded.canvas_objects.count()).resolves.toBe(0);
    await expect(upgraded.canvas_spatial.count()).resolves.toBe(0);
    await expect(upgraded.canvas_cameras.count()).resolves.toBe(0);
    await expect(upgraded.canvas_assets.count()).resolves.toBe(0);
    await expect(upgraded.canvas_templates.count()).resolves.toBe(0);
    await expect(upgraded.canvas_revisions.count()).resolves.toBe(0);
    await expect(upgraded.canvas_tombstones.count()).resolves.toBe(0);
    await expect(upgraded.canvas_recovery.count()).resolves.toBe(0);
    upgraded.close();
  });

  it('round-trips Canvas rows and enforces deterministic page, revision, and placement uniqueness on a fresh V8 database', async () => {
    const database = createTestJarvisDb(testDbName('jarvis-v8-canvas'));
    await database.open();
    const docId = 'doc-v8' as CanvasDocumentId;
    const otherDocId = 'doc-v8-other' as CanvasDocumentId;
    const ownerId = 'owner-v8' as CanvasOwnerId;
    const projectId = 'project-v8' as CanvasProjectId;
    const blockA = 'block-a' as CanvasBlockId;
    const blockB = 'block-b' as CanvasBlockId;

    await expect(
      database.canvas_documents.add({
        id: docId,
        accountId: 'account-v8',
        ownerId,
        projectId,
        schemaVersion: 1,
        title: 'Canvas',
        icon: null,
        thumbnail: null,
        layoutMode: 'edgeless',
        background: { kind: 'grid', color: '#0f172a' },
        localRevision: 1,
        syncRevision: 0,
        createdAt: 100,
        updatedAt: 101,
        archivedAt: null,
        deletedAt: null,
      }),
    ).resolves.toBe(docId);
    await expect(database.canvas_documents.get(docId)).resolves.toMatchObject({
      id: docId,
      title: 'Canvas',
    });

    await expect(
      database.canvas_objects.add({
        id: blockA,
        accountId: 'account-v8',
        documentId: docId,
        kind: 'note',
        content: { kind: 'note', text: 'hello' },
        createdAt: 102,
        updatedAt: 103,
      }),
    ).resolves.toBe(blockA);

    await expect(
      database.canvas_cameras.add({
        documentId: docId,
        accountId: 'account-v8',
        x: 10,
        y: 20,
        zoom: 1.5,
        updatedAt: 104,
      }),
    ).resolves.toBe(docId);

    await expect(
      database.canvas_pages.add({
        id: 'page-0',
        accountId: 'account-v8',
        documentId: docId,
        pageIndex: 0,
        blockId: blockA,
        presentationIndex: 0,
        createdAt: 105,
        updatedAt: 105,
      }),
    ).resolves.toBe('page-0');
    await expect(
      database.canvas_pages.add({
        id: 'page-1',
        accountId: 'account-v8',
        documentId: docId,
        pageIndex: 1,
        blockId: blockB,
        presentationIndex: null,
        createdAt: 106,
        updatedAt: 106,
      }),
    ).resolves.toBe('page-1');
    await expect(
      database.canvas_pages.add({
        id: 'page-dup',
        accountId: 'account-v8',
        documentId: docId,
        pageIndex: 0,
        blockId: blockB,
        presentationIndex: null,
        createdAt: 107,
        updatedAt: 107,
      }),
    ).rejects.toBeDefined();
    await expect(
      database.canvas_pages.add({
        id: 'page-dup-block',
        accountId: 'account-v8',
        documentId: docId,
        pageIndex: 2,
        blockId: blockA,
        presentationIndex: null,
        createdAt: 107,
        updatedAt: 107,
      }),
    ).rejects.toBeDefined();
    await expect(
      database.canvas_pages.add({
        id: 'page-other-0',
        accountId: 'account-v8',
        documentId: otherDocId,
        pageIndex: 0,
        blockId: blockA,
        presentationIndex: null,
        createdAt: 108,
        updatedAt: 108,
      }),
    ).resolves.toBe('page-other-0');

    await expect(
      database.canvas_spatial.add({
        id: 'spatial-a',
        accountId: 'account-v8',
        documentId: docId,
        blockId: blockA,
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        rotation: 0,
        z: 0,
        updatedAt: 109,
      }),
    ).resolves.toBe('spatial-a');
    await expect(
      database.canvas_spatial.add({
        id: 'spatial-dup',
        accountId: 'account-v8',
        documentId: docId,
        blockId: blockA,
        x: 5,
        y: 5,
        width: 10,
        height: 10,
        rotation: 0,
        z: 1,
        updatedAt: 110,
      }),
    ).rejects.toBeDefined();

    await expect(
      database.canvas_revisions.add({
        id: 'rev-1',
        accountId: 'account-v8',
        documentId: docId,
        sequence: 1,
        localRevision: 1,
        syncRevision: 0,
        changeKind: 'created',
        snapshotAssetId: null,
        contentHash: null,
        createdAt: 111,
      }),
    ).resolves.toBe('rev-1');
    await expect(
      database.canvas_revisions.add({
        id: 'rev-dup',
        accountId: 'account-v8',
        documentId: docId,
        sequence: 1,
        localRevision: 1,
        syncRevision: 0,
        changeKind: 'updated',
        snapshotAssetId: null,
        contentHash: null,
        createdAt: 112,
      }),
    ).rejects.toBeDefined();
    await expect(
      database.canvas_revisions.add({
        id: 'rev-other-1',
        accountId: 'account-v8',
        documentId: otherDocId,
        sequence: 1,
        localRevision: 1,
        syncRevision: 0,
        changeKind: 'created',
        snapshotAssetId: null,
        contentHash: null,
        createdAt: 113,
      }),
    ).resolves.toBe('rev-other-1');

    await expect(
      database.canvas_assets.add({
        id: 'asset-v8',
        accountId: 'account-v8',
        ownerId,
        projectId,
        documentId: docId,
        kind: 'image',
        mimeType: 'image/png',
        checksum: 'c'.repeat(64),
        sizeBytes: 1234,
        storageKind: 'filesystem',
        storageRef: 'assets/doc-v8/asset-v8.png',
        orphanedAt: null,
        createdAt: 114,
        updatedAt: 114,
      }),
    ).resolves.toBe('asset-v8');

    await expect(
      database.canvas_tombstones.add({
        id: 'tomb-v8',
        accountId: 'account-v8',
        documentId: docId,
        entityId: 'block-gone',
        entityKind: 'object',
        deletedAt: 115,
        syncRevision: 1,
        createdAt: 115,
      }),
    ).resolves.toBe('tomb-v8');

    await expect(
      database.canvas_recovery.add({
        id: 'rec-v8',
        accountId: 'account-v8',
        documentId: docId,
        kind: 'stroke',
        status: 'pending',
        snapshotAssetId: 'asset-v8',
        payload: { strokes: ['unsaved'] },
        contentHash: null,
        createdAt: 116,
        recoveredAt: null,
      }),
    ).resolves.toBe('rec-v8');

    await expect(
      database.canvas_templates.add({
        id: 'tpl-v8',
        accountId: 'account-v8',
        ownerId,
        projectId,
        name: 'Blank',
        layoutMode: 'page',
        background: { kind: 'plain', color: '#ffffff' },
        snapshot: { blocks: [] },
        createdAt: 117,
        updatedAt: 117,
      }),
    ).resolves.toBe('tpl-v8');

    database.close();
  });

  it('declares V12 additively without a destructive upgrade callback', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(source).not.toContain('.upgrade(');
    expect(source).toContain('this.version(1).stores(STORES_V1)');
    expect(source).toContain('this.version(2).stores(STORES_V2)');
    expect(source).toContain('this.version(3).stores(STORES_V3)');
    expect(source).toContain('this.version(4).stores(STORES_V4)');
    expect(source).toContain('this.version(5).stores(STORES_V5)');
    expect(source).toContain('this.version(6).stores(STORES_V6)');
    expect(source).toContain('this.version(7).stores(STORES_V7)');
    expect(source).toContain('this.version(8).stores(STORES_V8)');
    expect(source).toContain('this.version(9).stores(STORES_V9)');
    expect(source).toContain('this.version(10).stores(STORES_V10)');
    expect(source).toContain('this.version(11).stores(STORES_V11)');
    expect(source).toContain('this.version(12).stores(STORES_V12)');
  });
});

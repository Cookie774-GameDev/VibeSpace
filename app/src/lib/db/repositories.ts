/**
 * Typed repositories for every Dexie table in Jarvis V1.
 *
 * Each repo exposes the standard contract:
 *   - getById(id)
 *   - list(filter?)
 *   - create(input)
 *   - update(id, patch)
 *   - delete(id)
 *
 * Plus table-specific helpers like `taskRepo.listOpen(workspaceId)` and
 * `messageRepo.listByChat(chatId)`. Mutating helpers ALWAYS bump
 * `updated_at` and never allow patching `id` or `created_at`.
 *
 * Repos also mirror mutations into the local `sync_queue`. The sync loop
 * drains that queue when Jarvis Cloud is configured, while local writes stay
 * reliable even if queueing fails.
 */

import { nanoid } from 'nanoid';
import {
  captureSyncQueueOwner,
  cloudSyncQueueClaimKey,
  cloudSyncQueueOwnerKey,
  legacyCloudSyncQueueAuthorityKey,
  materializeSyncQueueOwner,
  ownersMayCoalesce,
  parseSyncQueueOwner,
  type SyncQueueOwnerSnapshot,
} from '@/lib/cloudSyncQueueOwner';
import { isProtectedJarvisAgent } from '@/lib/jarvis/identity';
import type {
  AgentId,
  ChatId,
  EventId,
  IntegrationId,
  MessageId,
  ProjectId,
  QuickLinkGroupId,
  QuickLinkId,
  ReminderId,
  TaskId,
  TerminalPresetId,
  TerminalSessionId,
  WorkspaceId,
} from '@/types/common';
import type { Agent } from '@/types/agent';
import type { Chat, ChatMode, Message } from '@/types/chat';
import type { EventRow, EventStatus } from '@/types/event';
import type { Integration, IntegrationKind } from '@/types/integration';
import type { MemoryItem } from '@/types/memory';
import type { MemoryEvidenceItem, MemoryEvidenceStatus } from '@/features/jarvis-memory/types';
import { hasDetectedSecret } from '@/lib/security/secretDetector';
import type { QuickLink, QuickLinkGroup } from '@/types/quick-link';
import type {
  EnergyLevel,
  EffortPoints,
  Reminder,
  Task,
  TaskInput,
  TaskPriority,
  TaskStatus,
} from '@/types/task';
import type {
  TerminalLayout,
  TerminalPreset,
  TerminalScrollbackChunk,
  TerminalSession,
  TerminalSessionStatus,
} from '@/types/terminal';
import {
  newAgentId,
  newChatId,
  newEventId,
  newIntegrationId,
  newMessageId,
  newProjectId,
  newQuickLinkGroupId,
  newQuickLinkId,
  newReminderId,
  newTaskId,
  newTerminalPresetId,
  newTerminalSessionId,
  newWorkspaceId,
} from '@/lib/ids';
import { db, type JarvisDexie } from './index';
import { enqueueLocalSyncInTransaction } from './kernelTurnTransactionAuthority';
import type {
  MemoryEvidenceHistoryRow,
  MemoryEvidenceRow,
  Project,
  SettingsRow,
  StoreName,
  SyncOp,
  SyncQueueRow,
  Workspace,
} from './schema';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const now = (): number => Date.now();

/**
 * Strip out fields that callers are never allowed to set during update().
 */
function sanitizeUpdate<T extends { id?: unknown; created_at?: unknown }>(
  patch: Partial<T>,
): Partial<T> {
  const { id: _i, created_at: _c, ...rest } = patch;
  return rest as Partial<T>;
}

async function requireRow<T>(
  loader: () => Promise<T | undefined>,
  table: string,
  id: string,
): Promise<T> {
  const row = await loader();
  if (!row) throw new Error(`${table} ${id} not found`);
  return row;
}

const SYNCABLE_TABLES = new Set<StoreName>([
  'workspaces',
  'projects',
  'chats',
  'messages',
  'agents',
  'tasks',
  'memory_items',
  'settings',
  'events',
  'quick_links',
  'quick_link_groups',
  'terminal_presets',
  'terminal_sessions',
  'terminal_layouts',
  'integrations',
]);

const SYNC_ID_PREFIX = 'syq';

export const SETTINGS_RESERVED_SYNC_METADATA_ERROR = 'SETTINGS_RESERVED_CLOUD_SYNC_METADATA_KEY';

const RESERVED_SYNC_METADATA_KEY_FAMILIES = [
  cloudSyncQueueClaimKey(''),
  cloudSyncQueueOwnerKey(''),
  legacyCloudSyncQueueAuthorityKey(''),
] as const;

function assertMutableSettingKey(key: string): void {
  const reserved = RESERVED_SYNC_METADATA_KEY_FAMILIES.some(
    (family) => key === family.slice(0, -1) || key.startsWith(family),
  );
  if (reserved) throw new Error(SETTINGS_RESERVED_SYNC_METADATA_ERROR);
}

function syncRowId(table: StoreName, row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const key = table === 'settings' ? 'key' : table === 'terminal_layouts' ? 'project_id' : 'id';
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function payloadForSync(
  table: StoreName,
  row: unknown,
  options: { wasProtectedJarvisAgent?: boolean } = {},
): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const record = row as Record<string, unknown>;
  if (table === 'chats') {
    const { connection: _localConnection, ...payload } = record;
    return payload;
  }
  if (
    table !== 'agents' ||
    (!options.wasProtectedJarvisAgent &&
      (typeof record.slug !== 'string' ||
        !isProtectedJarvisAgent({ builtin: record.builtin === true, slug: record.slug })))
  ) {
    return row;
  }

  const sanitized: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'system_prompt') sanitized[key] = record[key];
  }
  return sanitized;
}

function entityPayloadFreshness(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const value = record.updated_at ?? record.last_active_at;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type CoalescibleMutation = Readonly<{
  op: SyncOp;
  payload: unknown;
  createdAt: number;
  sourceId: string;
  incoming: boolean;
}>;

function queueTime(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function fresherMutation(
  left: CoalescibleMutation,
  right: CoalescibleMutation,
): CoalescibleMutation {
  const leftFreshness = entityPayloadFreshness(left.payload);
  const rightFreshness = entityPayloadFreshness(right.payload);
  if (leftFreshness !== null && rightFreshness !== null && leftFreshness !== rightFreshness) {
    return leftFreshness > rightFreshness ? left : right;
  }
  const leftTime = queueTime(left.createdAt);
  const rightTime = queueTime(right.createdAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (left.incoming !== right.incoming) return left.incoming ? left : right;
  return left.sourceId >= right.sourceId ? left : right;
}

function reduceCoalescibleMutations(
  candidates: readonly SyncQueueRow[],
  incomingOp: SyncOp,
  incomingPayload: unknown,
  incomingCreatedAt: number,
): Readonly<{ op: SyncOp; payload: unknown }> {
  const mutations: CoalescibleMutation[] = [
    ...candidates.map((candidate) => ({
      op: candidate.op,
      payload: candidate.payload,
      createdAt: candidate.created_at,
      sourceId: candidate.id,
      incoming: false,
    })),
    {
      op: incomingOp,
      payload: incomingPayload,
      createdAt: incomingCreatedAt,
      sourceId: '',
      incoming: true,
    },
  ];
  if (mutations.some((mutation) => mutation.op === 'delete')) {
    return { op: 'delete', payload: null };
  }
  return {
    op: mutations.some((mutation) => mutation.op === 'insert') ? 'insert' : 'update',
    payload: mutations.reduce(fresherMutation).payload,
  };
}

function laterPendingRow(left: SyncQueueRow, right: SyncQueueRow): SyncQueueRow {
  const leftTime = queueTime(left.created_at);
  const rightTime = queueTime(right.created_at);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return left.id >= right.id ? left : right;
}

async function enqueueGenericLocalSyncInTransaction(
  op: SyncOp,
  table: StoreName,
  rowId: string,
  payload: unknown,
  owner: SyncQueueOwnerSnapshot,
  ts: number,
): Promise<void> {
  const candidates = await db.sync_queue
    .where('status')
    .equals('pending')
    .filter((row) => row.table === table && row.row_id === rowId)
    .toArray();
  const coalescible: (typeof candidates)[number][] = [];
  for (const candidate of candidates) {
    if (await db.settings.get(cloudSyncQueueClaimKey(candidate.id))) continue;
    if (await db.settings.get(legacyCloudSyncQueueAuthorityKey(candidate.id))) continue;
    const stored = await db.settings.get(cloudSyncQueueOwnerKey(candidate.id));
    const candidateOwner = parseSyncQueueOwner(candidate.id, stored?.value);
    if (candidateOwner && ownersMayCoalesce(candidateOwner, owner)) {
      coalescible.push(candidate);
    }
  }
  if (coalescible.length > 0) {
    const survivor = coalescible.reduce(laterPendingRow);
    const reduced = reduceCoalescibleMutations(coalescible, op, payload, ts);
    await db.sync_queue.update(survivor.id, {
      op: reduced.op,
      payload: reduced.payload,
      created_at: ts,
      error: undefined,
    });
    for (const duplicate of coalescible) {
      if (duplicate.id === survivor.id) continue;
      await db.sync_queue.delete(duplicate.id);
      await db.settings.delete(cloudSyncQueueOwnerKey(duplicate.id));
    }
    return;
  }
  const id = `${SYNC_ID_PREFIX}_${nanoid(16)}`;
  await db.sync_queue.add({
    id,
    op,
    table,
    row_id: rowId,
    payload,
    status: 'pending',
    created_at: ts,
  });
  await db.settings.put({
    key: cloudSyncQueueOwnerKey(id),
    value: materializeSyncQueueOwner(id, owner),
    updated_at: ts,
  });
}

async function enqueueLocalSync(
  op: SyncOp,
  table: StoreName,
  rowId: string,
  payload: unknown,
  owner: SyncQueueOwnerSnapshot,
): Promise<boolean> {
  if (!SYNCABLE_TABLES.has(table)) return true;
  try {
    const ts = now();
    if ((table === 'messages' && op === 'insert') || (table === 'chats' && op === 'update')) {
      await db.transaction('rw', [db.sync_queue, db.settings], () =>
        enqueueLocalSyncInTransaction(
          { sync_queue: db.sync_queue, settings: db.settings },
          table === 'messages'
            ? {
                op: 'insert',
                table: 'messages',
                row: payload as Message,
                createdAt: ts,
                ownerSnapshot: owner,
              }
            : {
                op: 'update',
                table: 'chats',
                row: payload as Chat,
                createdAt: ts,
                ownerSnapshot: owner,
              },
        ),
      );
      return true;
    }
    await db.transaction('rw', [db.sync_queue, db.settings], () =>
      enqueueGenericLocalSyncInTransaction(op, table, rowId, payload, owner, ts),
    );
    return true;
  } catch (err) {
    console.warn('[sync] failed to enqueue local mutation', { table, rowId, op, err });
    return false;
  }
}

async function syncInsert<T>(
  table: StoreName,
  row: T,
  owner: SyncQueueOwnerSnapshot,
): Promise<void> {
  const rowId = syncRowId(table, row);
  if (rowId) {
    await enqueueLocalSync('insert', table, rowId, payloadForSync(table, row), owner);
  }
}

async function syncUpdate<T>(
  table: StoreName,
  row: T,
  owner: SyncQueueOwnerSnapshot,
  options?: { wasProtectedJarvisAgent?: boolean },
): Promise<void> {
  const rowId = syncRowId(table, row);
  if (rowId) {
    await enqueueLocalSync('update', table, rowId, payloadForSync(table, row, options), owner);
  }
}

async function syncDelete(
  table: StoreName,
  rowId: string,
  owner: SyncQueueOwnerSnapshot,
): Promise<boolean> {
  return enqueueLocalSync('delete', table, rowId, null, owner);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type WorkspaceCreateInput = Omit<Workspace, 'id' | 'created_at' | 'updated_at'> & {
  id?: WorkspaceId;
};

/**
 * CRUD over the `workspaces` table.
 *
 * A workspace is the top-level container for projects, chats, tasks and memory.
 * V1 ships with one workspace ("Personal") seeded automatically.
 */
export const workspaceRepo = {
  async getById(id: WorkspaceId): Promise<Workspace | undefined> {
    return db.workspaces.get(id);
  },
  async list(): Promise<Workspace[]> {
    return db.workspaces.orderBy('updated_at').reverse().toArray();
  },
  async create(input: WorkspaceCreateInput): Promise<Workspace> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: Workspace = {
      id: input.id ?? newWorkspaceId(),
      name: input.name,
      owner_id: input.owner_id,
      created_at: ts,
      updated_at: ts,
    };
    await db.workspaces.add(row);
    await syncInsert('workspaces', row, syncOwner);
    return row;
  },
  async update(id: WorkspaceId, patch: Partial<Workspace>): Promise<Workspace> {
    const syncOwner = captureSyncQueueOwner();
    await db.workspaces.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.workspaces.get(id), 'workspace', id);
    await syncUpdate('workspaces', row, syncOwner);
    return row;
  },
  async delete(id: WorkspaceId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.workspaces.delete(id);
    await syncDelete('workspaces', id, syncOwner);
  },
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectCreateInput = Omit<Project, 'id' | 'created_at' | 'updated_at'> & {
  id?: ProjectId;
};

/**
 * CRUD over the `projects` table.
 *
 * A project is a sub-bucket of a workspace. Chats, tasks and memory items can
 * optionally point to a project. The seeded "Inbox" project is the default
 * catch-all when no project context is set.
 */
export const projectRepo = {
  async getById(id: ProjectId): Promise<Project | undefined> {
    return db.projects.get(id);
  },
  async list(filter?: { workspace_id?: WorkspaceId }): Promise<Project[]> {
    if (filter?.workspace_id) {
      return db.projects.where('workspace_id').equals(filter.workspace_id).toArray();
    }
    return db.projects.toArray();
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<Project[]> {
    return db.projects.where('workspace_id').equals(workspaceId).toArray();
  },
  async create(input: ProjectCreateInput): Promise<Project> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: Project = {
      id: input.id ?? newProjectId(),
      workspace_id: input.workspace_id,
      name: input.name,
      color_hue: input.color_hue,
      created_at: ts,
      updated_at: ts,
    };
    await db.projects.add(row);
    await syncInsert('projects', row, syncOwner);
    return row;
  },
  async update(id: ProjectId, patch: Partial<Project>): Promise<Project> {
    const syncOwner = captureSyncQueueOwner();
    await db.projects.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.projects.get(id), 'project', id);
    await syncUpdate('projects', row, syncOwner);
    return row;
  },
  async delete(id: ProjectId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.projects.delete(id);
    await syncDelete('projects', id, syncOwner);
  },
};

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export type ChatCreateInput = Omit<Chat, 'id' | 'created_at' | 'updated_at'> & {
  id?: ChatId;
};

export interface ChatDeleteOutcome {
  localDeleted: true;
  syncQueued: boolean;
}

export interface AuthorizedChatDeleteOutcome extends ChatDeleteOutcome {
  deletedChatId: ChatId;
  deletedMessageIds: MessageId[];
}

export interface ChatDeleteAuthority {
  expectedAccountId: string;
  expectedWorkspaceId: string;
  getActiveAccountId(): string | null;
  getActiveWorkspaceId(): string | null;
}

export type ChatListFilter = {
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  archived?: boolean;
  mode?: ChatMode;
  limit?: number;
};

function assertChatDeleteAuthority(authority: ChatDeleteAuthority): void {
  if (authority.getActiveAccountId() !== authority.expectedAccountId) {
    throw new Error('The active account changed; remaining chats were not deleted.');
  }
  if (authority.getActiveWorkspaceId() !== authority.expectedWorkspaceId) {
    throw new Error('The active workspace changed; remaining chats were not deleted.');
  }
}

async function deleteChatLocally(
  id: ChatId,
  authority?: ChatDeleteAuthority,
): Promise<MessageId[]> {
  return db.transaction('rw', [db.chats, db.messages], async () => {
    if (authority) {
      const chat = await db.chats.get(id);
      if (!chat) throw new Error('The chat no longer exists.');
      if (String(chat.workspace_id) !== authority.expectedWorkspaceId) {
        throw new Error('The chat does not belong to the reviewed workspace.');
      }
    }
    const messageIds = (await db.messages.where('chat_id').equals(id).primaryKeys())
      .map((messageId) => String(messageId) as MessageId)
      .sort((left, right) => String(left).localeCompare(String(right)));
    if (authority) assertChatDeleteAuthority(authority);
    await db.messages.bulkDelete(messageIds);
    await db.chats.delete(id);
    return messageIds;
  });
}

async function enqueueChatDeleteTombstones(
  id: ChatId,
  messageIds: readonly MessageId[],
  syncOwner: SyncQueueOwnerSnapshot,
): Promise<boolean> {
  const queued = await Promise.all([
    ...messageIds.map((messageId) => syncDelete('messages', messageId, syncOwner)),
    syncDelete('chats', id, syncOwner),
  ]);
  return queued.every(Boolean);
}

/**
 * CRUD over the `chats` table.
 *
 * Chats are the top-level conversation containers. Each chat has a mode
 * (`chat`, `council`, `doc`, `code`) that the UI uses to pick the right
 * canvas layout. `active_agent_ids` is one for chat mode and N for council.
 */
export const chatRepo = {
  async getById(id: ChatId): Promise<Chat | undefined> {
    return db.chats.get(id);
  },
  async list(filter?: ChatListFilter): Promise<Chat[]> {
    let coll = db.chats.orderBy('updated_at').reverse();
    if (filter?.workspace_id) {
      coll = db.chats.where('workspace_id').equals(filter.workspace_id);
    }
    let rows = await coll.toArray();
    if (filter?.project_id !== undefined) {
      rows = rows.filter((c) => c.project_id === filter.project_id);
    }
    if (filter?.archived !== undefined) {
      rows = rows.filter((c) => Boolean(c.archived) === filter.archived);
    }
    if (filter?.mode) {
      rows = rows.filter((c) => c.mode === filter.mode);
    }
    rows.sort((a, b) => b.updated_at - a.updated_at);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  },
  async listByWorkspace(workspaceId: WorkspaceId, opts?: { archived?: boolean }): Promise<Chat[]> {
    return chatRepo.list({ workspace_id: workspaceId, archived: opts?.archived });
  },
  async listByProject(projectId: ProjectId): Promise<Chat[]> {
    return db.chats.where('project_id').equals(projectId).toArray();
  },
  async create(input: ChatCreateInput): Promise<Chat> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: Chat = {
      id: input.id ?? newChatId(),
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      title: input.title,
      mode: input.mode,
      active_agent_ids: input.active_agent_ids,
      connection: input.connection,
      archived: input.archived,
      pinned: input.pinned,
      pinned_at: input.pinned_at,
      created_at: ts,
      updated_at: ts,
    };
    await db.chats.add(row);
    await syncInsert('chats', row, syncOwner);
    return row;
  },
  async createAuthorized(
    input: ChatCreateInput,
    syncOwner: SyncQueueOwnerSnapshot,
    authorize: () => boolean,
  ): Promise<Chat | null> {
    if (!authorize()) return null;
    const ts = now();
    const row: Chat = {
      id: input.id ?? newChatId(),
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      title: input.title,
      mode: input.mode,
      active_agent_ids: input.active_agent_ids,
      connection: input.connection,
      archived: input.archived,
      pinned: input.pinned,
      pinned_at: input.pinned_at,
      created_at: ts,
      updated_at: ts,
    };
    let authorityRevoked = false;
    try {
      await db.transaction('rw', db.chats, db.sync_queue, db.settings, async () => {
        await db.chats.add(row);
        await enqueueGenericLocalSyncInTransaction(
          'insert',
          'chats',
          String(row.id),
          payloadForSync('chats', row),
          syncOwner,
          now(),
        );
        if (!authorize()) {
          authorityRevoked = true;
          throw new Error('CHAT_CREATION_AUTHORITY_REVOKED');
        }
      });
    } catch (error) {
      if (authorityRevoked) return null;
      throw error;
    }
    return row;
  },
  async update(id: ChatId, patch: Partial<Chat>): Promise<Chat> {
    const syncOwner = captureSyncQueueOwner();
    await db.chats.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.chats.get(id), 'chat', id);
    await syncUpdate('chats', row, syncOwner);
    return row;
  },
  async delete(id: ChatId): Promise<ChatDeleteOutcome> {
    const syncOwner = captureSyncQueueOwner();
    const messageIds = await deleteChatLocally(id);
    return {
      localDeleted: true,
      syncQueued: await enqueueChatDeleteTombstones(id, messageIds, syncOwner),
    };
  },
  async deleteAuthorized(
    id: ChatId,
    authority: ChatDeleteAuthority,
  ): Promise<AuthorizedChatDeleteOutcome> {
    assertChatDeleteAuthority(authority);
    const syncOwner = captureSyncQueueOwner();
    const messageIds = await deleteChatLocally(id, authority);
    return {
      localDeleted: true,
      syncQueued: await enqueueChatDeleteTombstones(id, messageIds, syncOwner),
      deletedChatId: id,
      deletedMessageIds: messageIds,
    };
  },
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageCreateInput = Omit<Message, 'id' | 'created_at' | 'updated_at'> & {
  id?: MessageId;
  /** Preserve ordering when copying messages into a branched chat. */
  created_at?: number;
  updated_at?: number;
};

/**
 * CRUD over the `messages` table.
 *
 * A message belongs to a chat and has multiple parts (text, reasoning, tool
 * call, tool result, image, file ref). Branches use `parent_id` to link
 * regenerations and forks.
 */
export const messageRepo = {
  async getById(id: MessageId): Promise<Message | undefined> {
    return db.messages.get(id);
  },
  async list(filter?: { chat_id?: ChatId; limit?: number }): Promise<Message[]> {
    let rows: Message[];
    if (filter?.chat_id) {
      rows = await db.messages.where('chat_id').equals(filter.chat_id).sortBy('created_at');
    } else {
      rows = await db.messages.toArray();
      rows.sort((a, b) => a.created_at - b.created_at);
    }
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  },
  async listByChat(chatId: ChatId): Promise<Message[]> {
    return db.messages
      .where('[chat_id+created_at]')
      .between([chatId, 0], [chatId, Infinity])
      .toArray();
  },
  async listChildren(parentId: MessageId): Promise<Message[]> {
    return db.messages.where('parent_id').equals(parentId).sortBy('created_at');
  },
  async countByChat(chatId: ChatId): Promise<number> {
    return db.messages.where('chat_id').equals(chatId).count();
  },
  async mutateIfChatEmpty(chatId: ChatId, mutation: () => boolean): Promise<boolean> {
    return db.transaction('rw', db.messages, async () => {
      const messageCount = await db.messages.where('chat_id').equals(chatId).count();
      if (messageCount !== 0) return false;
      return mutation();
    });
  },
  async create(input: MessageCreateInput): Promise<Message> {
    const syncOwner = captureSyncQueueOwner();
    const ts = input.created_at ?? now();
    const row: Message = {
      id: input.id ?? newMessageId(),
      chat_id: input.chat_id,
      role: input.role,
      agent_id: input.agent_id,
      parts: input.parts,
      parent_id: input.parent_id,
      usage: input.usage,
      created_at: ts,
      updated_at: input.updated_at ?? ts,
    };
    await db.messages.add(row);
    // Bump the parent chat's updated_at so chat lists reorder by recency.
    await db.chats.update(input.chat_id, { updated_at: ts });
    await syncInsert('messages', row, syncOwner);
    const chat = await db.chats.get(input.chat_id);
    if (chat) await syncUpdate('chats', chat, syncOwner);
    return row;
  },
  async update(id: MessageId, patch: Partial<Message>): Promise<Message> {
    const syncOwner = captureSyncQueueOwner();
    await db.messages.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.messages.get(id), 'message', id);
    await syncUpdate('messages', row, syncOwner);
    return row;
  },
  async delete(id: MessageId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.messages.delete(id);
    await syncDelete('messages', id, syncOwner);
  },
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentCreateInput = Omit<Agent, 'id' | 'created_at' | 'updated_at'> & {
  id?: AgentId;
};

/**
 * CRUD over the `agents` table.
 *
 * Agents are persona + model + tool-allowlist bundles. Built-in agents are
 * seeded on first run and cannot be deleted. Slugs are unique and used for
 * stable references in code (`@/lib/orchestrator` resolves agents by slug).
 */
export const agentRepo = {
  async getById(id: AgentId): Promise<Agent | undefined> {
    return db.agents.get(id);
  },
  async getBySlug(slug: string): Promise<Agent | undefined> {
    return db.agents.where('slug').equals(slug).first();
  },
  async list(): Promise<Agent[]> {
    return db.agents.toArray();
  },
  async create(input: AgentCreateInput): Promise<Agent> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: Agent = {
      ...input,
      id: input.id ?? newAgentId(),
      created_at: ts,
      updated_at: ts,
    } as Agent;
    await db.agents.add(row);
    await syncInsert('agents', row, syncOwner);
    return row;
  },
  async update(id: AgentId, patch: Partial<Agent>): Promise<Agent> {
    const syncOwner = captureSyncQueueOwner();
    const existing = await requireRow(() => db.agents.get(id), 'agent', id);
    const wasProtectedJarvisAgent = isProtectedJarvisAgent(existing);
    const row: Agent = {
      ...existing,
      ...sanitizeUpdate(patch),
      ...(wasProtectedJarvisAgent ? { builtin: existing.builtin, slug: existing.slug } : {}),
      updated_at: now(),
    };
    await db.agents.put(row);
    await syncUpdate('agents', row, syncOwner, {
      wasProtectedJarvisAgent,
    });
    return row;
  },
  async delete(id: AgentId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    const existing = await db.agents.get(id);
    if (existing?.builtin) {
      throw new Error(`agent ${id} is built-in and cannot be deleted`);
    }
    await db.agents.delete(id);
    await syncDelete('agents', id, syncOwner);
  },
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskCreateInput = TaskInput & {
  /** Required when creating - tasks must belong to a workspace. */
  workspace_id: WorkspaceId;
};

export type TaskListFilter = {
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  context_tag?: string;
  limit?: number;
};

/** Statuses considered "open" - i.e. still actionable and not completed/cancelled. */
const OPEN_STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked'];

export type ReminderMutationScope = {
  taskId: TaskId;
  reminderId: ReminderId;
  claimId: string;
  expectedWorkspaceId: WorkspaceId;
  getActiveWorkspaceId: () => WorkspaceId | null;
  now: number;
};

export type ReminderClaimInput = ReminderMutationScope & {
  expiresAt: number;
};

function reminderWithoutClaim(reminder: Reminder): Reminder {
  const { delivery_claim: _claim, ...rest } = reminder;
  return rest;
}

function ownsReminderClaim(reminder: Reminder | undefined, claimId: string): reminder is Reminder {
  return reminder?.status === 'scheduled' && reminder.delivery_claim?.id === claimId;
}

/**
 * A transaction-scoped reminder CAS. Separate renderer connections serialize
 * on the shared IndexedDB task row; the process-local delivery Set is only an
 * optimization and is never the ownership authority.
 */
export function createReminderClaimRepository(database?: JarvisDexie) {
  const resolveDatabase = (): JarvisDexie => database ?? db;
  const syncPersistedTask = async (
    task: Task | undefined,
    activeDatabase: JarvisDexie,
  ): Promise<void> => {
    if (task && activeDatabase === db) {
      await syncUpdate('tasks', task, captureSyncQueueOwner());
    }
  };

  return {
    async claim(input: ReminderClaimInput): Promise<Task | undefined> {
      const activeDatabase = resolveDatabase();
      const claimed = await activeDatabase.transaction('rw', activeDatabase.tasks, async () => {
        const task = await activeDatabase.tasks.get(input.taskId);
        const reminder = task?.reminders.find((candidate) => candidate.id === input.reminderId);
        if (
          !task ||
          task.workspace_id !== input.expectedWorkspaceId ||
          input.getActiveWorkspaceId() !== input.expectedWorkspaceId ||
          !reminder ||
          reminder.status !== 'scheduled' ||
          reminder.fires_at > input.now ||
          (reminder.delivery_claim && reminder.delivery_claim.expires_at > input.now)
        ) {
          return undefined;
        }

        const updated: Task = {
          ...task,
          reminders: task.reminders.map((candidate) =>
            candidate.id === input.reminderId
              ? {
                  ...candidate,
                  delivery_claim: {
                    id: input.claimId,
                    claimed_at: input.now,
                    expires_at: input.expiresAt,
                  },
                }
              : candidate,
          ),
          updated_at: input.now,
        };
        await activeDatabase.tasks.put(updated);
        return updated;
      });
      await syncPersistedTask(claimed, activeDatabase);
      return claimed;
    },

    async finalize(input: ReminderMutationScope): Promise<Task | undefined> {
      const activeDatabase = resolveDatabase();
      const finalized = await activeDatabase.transaction('rw', activeDatabase.tasks, async () => {
        const task = await activeDatabase.tasks.get(input.taskId);
        const reminder = task?.reminders.find((candidate) => candidate.id === input.reminderId);
        if (
          !task ||
          task.workspace_id !== input.expectedWorkspaceId ||
          input.getActiveWorkspaceId() !== input.expectedWorkspaceId ||
          !ownsReminderClaim(reminder, input.claimId)
        ) {
          return undefined;
        }

        const updated: Task = {
          ...task,
          reminders: task.reminders.map((candidate) =>
            candidate.id === input.reminderId
              ? { ...reminderWithoutClaim(candidate), status: 'fired' as const }
              : candidate,
          ),
          updated_at: input.now,
        };
        await activeDatabase.tasks.put(updated);
        return updated;
      });
      await syncPersistedTask(finalized, activeDatabase);
      return finalized;
    },

    async release(input: ReminderMutationScope): Promise<Task | undefined> {
      const activeDatabase = resolveDatabase();
      const released = await activeDatabase.transaction('rw', activeDatabase.tasks, async () => {
        const task = await activeDatabase.tasks.get(input.taskId);
        const reminder = task?.reminders.find((candidate) => candidate.id === input.reminderId);
        if (
          !task ||
          task.workspace_id !== input.expectedWorkspaceId ||
          input.getActiveWorkspaceId() !== input.expectedWorkspaceId ||
          !ownsReminderClaim(reminder, input.claimId)
        ) {
          return undefined;
        }

        const updated: Task = {
          ...task,
          reminders: task.reminders.map((candidate) =>
            candidate.id === input.reminderId ? reminderWithoutClaim(candidate) : candidate,
          ),
          updated_at: input.now,
        };
        await activeDatabase.tasks.put(updated);
        return updated;
      });
      await syncPersistedTask(released, activeDatabase);
      return released;
    },
  };
}

export const reminderClaimRepo = createReminderClaimRepository();

async function updateTaskWithOwner(
  id: TaskId,
  patch: Partial<Task>,
  syncOwner: SyncQueueOwnerSnapshot,
): Promise<Task> {
  await db.tasks.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
  const row = await requireRow(() => db.tasks.get(id), 'task', id);
  await syncUpdate('tasks', row, syncOwner);
  return row;
}

/**
 * CRUD over the `tasks` table.
 *
 * Tasks are the to-do entities the scheduler and notification engine work
 * over. `effort`, `context_tags`, `energy_required` and `due_at` drive smart
 * scheduling. `source_refs` keeps provenance from chats / meetings / voice.
 */
export const taskRepo = {
  async getById(id: TaskId): Promise<Task | undefined> {
    return db.tasks.get(id);
  },
  async list(filter?: TaskListFilter): Promise<Task[]> {
    let rows: Task[];
    if (filter?.workspace_id) {
      rows = await db.tasks.where('workspace_id').equals(filter.workspace_id).toArray();
    } else {
      rows = await db.tasks.toArray();
    }
    if (filter?.project_id !== undefined) {
      rows = rows.filter((t) => t.project_id === filter.project_id);
    }
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      rows = rows.filter((t) => statuses.includes(t.status));
    }
    if (filter?.priority) {
      rows = rows.filter((t) => t.priority === filter.priority);
    }
    if (filter?.context_tag) {
      rows = rows.filter((t) => t.context_tags.includes(filter.context_tag!));
    }
    rows.sort((a, b) => b.updated_at - a.updated_at);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<Task[]> {
    return db.tasks.where('workspace_id').equals(workspaceId).toArray();
  },
  async listByProject(projectId: ProjectId): Promise<Task[]> {
    return db.tasks.where('project_id').equals(projectId).toArray();
  },
  async listOpen(workspaceId: WorkspaceId): Promise<Task[]> {
    const rows = await db.tasks
      .where('[workspace_id+status]')
      .anyOf(OPEN_STATUSES.map((s) => [workspaceId, s] as [WorkspaceId, TaskStatus]))
      .toArray();
    rows.sort((a, b) => {
      // Open in_progress first, then due_at ascending (with null due dates last).
      if (a.status !== b.status) {
        if (a.status === 'in_progress') return -1;
        if (b.status === 'in_progress') return 1;
      }
      const aDue = a.due_at ?? Number.POSITIVE_INFINITY;
      const bDue = b.due_at ?? Number.POSITIVE_INFINITY;
      return aDue - bDue;
    });
    return rows;
  },
  async listByStatus(workspaceId: WorkspaceId, status: TaskStatus): Promise<Task[]> {
    return db.tasks.where('[workspace_id+status]').equals([workspaceId, status]).toArray();
  },
  async listDueBefore(workspaceId: WorkspaceId, ts: number): Promise<Task[]> {
    const rows = await db.tasks.where('workspace_id').equals(workspaceId).toArray();
    return rows.filter((t) => t.due_at !== undefined && t.due_at <= ts);
  },
  async listScheduledBetween(
    workspaceId: WorkspaceId,
    fromTs: number,
    toTs: number,
  ): Promise<Task[]> {
    const rows = await db.tasks.where('workspace_id').equals(workspaceId).toArray();
    return rows.filter(
      (t) => t.scheduled_for !== undefined && t.scheduled_for >= fromTs && t.scheduled_for <= toTs,
    );
  },
  async create(input: TaskCreateInput): Promise<Task> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const id = newTaskId();
    const reminders: Reminder[] = (input.reminders ?? []).map((r) => ({
      id: newReminderId(),
      task_id: id,
      fires_at: r.fires_at,
      channels: r.channels,
      message_override: r.message_override,
      smart_reason: r.smart_reason,
      snooze_history: [],
      status: 'scheduled',
    }));

    const row: Task = {
      id,
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      title: input.title,
      notes: input.notes,
      status: input.status ?? 'open',
      priority: input.priority ?? 'normal',
      due_at: input.due_at,
      scheduled_for: input.scheduled_for,
      estimated_duration_min: input.estimated_duration_min,
      effort: (input.effort as EffortPoints | undefined) ?? 3,
      context_tags: input.context_tags ?? [],
      location: input.location,
      energy_required: (input.energy_required as EnergyLevel | undefined) ?? 'medium',
      blocked_by_task_ids: input.blocked_by_task_ids,
      reminders,
      created_by: input.created_by ?? 'user_text',
      source_refs: input.source_refs ?? [],
      agent_owner: input.agent_owner,
      external_ids: input.external_ids,
      done_at: input.done_at,
      completion_evidence: input.completion_evidence,
      created_at: ts,
      updated_at: ts,
    };
    await db.tasks.add(row);
    await syncInsert('tasks', row, syncOwner);
    return row;
  },
  async update(id: TaskId, patch: Partial<Task>): Promise<Task> {
    const syncOwner = captureSyncQueueOwner();
    return updateTaskWithOwner(id, patch, syncOwner);
  },
  async delete(id: TaskId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.tasks.delete(id);
    await syncDelete('tasks', id, syncOwner);
  },

  // ---------- Reminder helpers (live inside the task row) ----------

  /**
   * Append a new reminder to the task. Returns the updated task.
   */
  async addReminder(
    taskId: TaskId,
    reminder: Omit<Reminder, 'id' | 'task_id' | 'snooze_history' | 'status'>,
  ): Promise<Task> {
    const syncOwner = captureSyncQueueOwner();
    const task = await requireRow(() => db.tasks.get(taskId), 'task', taskId);
    const next: Reminder = {
      id: newReminderId(),
      task_id: taskId,
      fires_at: reminder.fires_at,
      channels: reminder.channels,
      message_override: reminder.message_override,
      smart_reason: reminder.smart_reason,
      snooze_history: [],
      status: 'scheduled',
    };
    return updateTaskWithOwner(taskId, { reminders: [...task.reminders, next] }, syncOwner);
  },
  async updateReminder(
    taskId: TaskId,
    reminderId: ReminderId,
    patch: Partial<Reminder>,
  ): Promise<Task> {
    const syncOwner = captureSyncQueueOwner();
    const task = await requireRow(() => db.tasks.get(taskId), 'task', taskId);
    const reminders = task.reminders.map((r) =>
      r.id === reminderId ? { ...r, ...patch, id: r.id, task_id: r.task_id } : r,
    );
    return updateTaskWithOwner(taskId, { reminders }, syncOwner);
  },
  async deleteReminder(taskId: TaskId, reminderId: ReminderId): Promise<Task> {
    const syncOwner = captureSyncQueueOwner();
    const task = await requireRow(() => db.tasks.get(taskId), 'task', taskId);
    return updateTaskWithOwner(
      taskId,
      { reminders: task.reminders.filter((r) => r.id !== reminderId) },
      syncOwner,
    );
  },
};

// ---------------------------------------------------------------------------
// Memory items
// ---------------------------------------------------------------------------

export type MemoryCreateInput = Omit<MemoryItem, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

export type MemoryListFilter = {
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  agent_id?: AgentId;
  source?: MemoryItem['source'];
  tag?: string;
  limit?: number;
};

type LegacyMemoryItemsTable = import('dexie').EntityTable<MemoryItem, 'id'>;

const getLegacyMemoryItems = (): LegacyMemoryItemsTable =>
  db.memory_items as unknown as LegacyMemoryItemsTable;

function isLegacyMemoryItem(value: MemoryItem | MemoryEvidenceRow): value is MemoryItem {
  return !('recordKind' in value) && 'workspace_id' in value && 'source_ref' in value;
}

/**
 * CRUD over the `memory_items` table.
 *
 * Memory items are atoms of recalled context - chat snippets, meeting
 * highlights, file chunks, voice transcripts, web pages. The vector
 * embedding is optional client-side; the runtime computes it lazily.
 */
export const memoryRepo = {
  async getById(id: string): Promise<MemoryItem | undefined> {
    const row = await db.memory_items.get(id);
    return row && isLegacyMemoryItem(row) ? row : undefined;
  },
  async list(filter?: MemoryListFilter): Promise<MemoryItem[]> {
    let storedRows: Array<MemoryItem | MemoryEvidenceRow>;
    if (filter?.workspace_id) {
      storedRows = await db.memory_items
        .where('workspace_id')
        .equals(filter.workspace_id)
        .toArray();
    } else {
      storedRows = await db.memory_items.toArray();
    }
    let rows = storedRows.filter(isLegacyMemoryItem);
    if (filter?.project_id !== undefined) {
      rows = rows.filter((m) => m.project_id === filter.project_id);
    }
    if (filter?.agent_id !== undefined) {
      rows = rows.filter((m) => m.agent_id === filter.agent_id);
    }
    if (filter?.source) {
      rows = rows.filter((m) => m.source === filter.source);
    }
    if (filter?.tag) {
      rows = rows.filter((m) => m.tags.includes(filter.tag!));
    }
    rows.sort(
      (a, b) => (b.last_accessed_at ?? b.updated_at) - (a.last_accessed_at ?? a.updated_at),
    );
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<MemoryItem[]> {
    const rows = await db.memory_items.where('workspace_id').equals(workspaceId).toArray();
    return rows.filter(isLegacyMemoryItem);
  },
  async listBySource(
    workspaceId: WorkspaceId,
    source: MemoryItem['source'],
  ): Promise<MemoryItem[]> {
    const rows = await db.memory_items
      .where('[workspace_id+source]')
      .equals([workspaceId, source])
      .toArray();
    return rows.filter(isLegacyMemoryItem);
  },
  async listByAgent(agentId: AgentId): Promise<MemoryItem[]> {
    const rows = await db.memory_items.where('agent_id').equals(agentId).toArray();
    return rows.filter(isLegacyMemoryItem);
  },
  async create(input: MemoryCreateInput): Promise<MemoryItem> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: MemoryItem = {
      ...input,
      id: input.id ?? `mem_${nanoid(16)}`,
      created_at: ts,
      updated_at: ts,
    } as MemoryItem;
    await getLegacyMemoryItems().add(row);
    await syncInsert('memory_items', row, syncOwner);
    return row;
  },
  async update(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem> {
    const syncOwner = captureSyncQueueOwner();
    await requireRow(() => memoryRepo.getById(id), 'memory_item', id);
    await getLegacyMemoryItems().update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => getLegacyMemoryItems().get(id), 'memory_item', id);
    await syncUpdate('memory_items', row, syncOwner);
    return row;
  },
  async delete(id: string): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await requireRow(() => memoryRepo.getById(id), 'memory_item', id);
    await getLegacyMemoryItems().delete(id);
    await syncDelete('memory_items', id, syncOwner);
  },
  /** Stamp `last_accessed_at` to mark a memory item as recently used by retrieval. */
  async touchAccessed(id: string): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await requireRow(() => memoryRepo.getById(id), 'memory_item', id);
    await getLegacyMemoryItems().update(id, { last_accessed_at: now() });
    const row = await getLegacyMemoryItems().get(id);
    if (row) await syncUpdate('memory_items', row, syncOwner);
  },
};

// ---------------------------------------------------------------------------
// Curated memory evidence (V9)
// ---------------------------------------------------------------------------

export type MemoryEvidenceListFilter = {
  profileId?: string;
  workspaceId?: string;
  projectId?: string;
  status?: MemoryEvidenceStatus;
};

const MEMORY_EVIDENCE_STATUSES = new Set<MemoryEvidenceStatus>([
  'candidate',
  'pending_approval',
  'approved',
  'rejected',
  'superseded',
  'archived',
]);

function isMemoryEvidenceRow(value: MemoryItem | MemoryEvidenceRow): value is MemoryEvidenceRow {
  return (
    'recordKind' in value &&
    value.recordKind === 'evidence' &&
    value.schemaVersion === 1 &&
    Number.isInteger(value.revision) &&
    value.revision > 0
  );
}

function assertMemoryEvidence(
  ownerId: string,
  value: MemoryEvidenceItem,
  existing?: MemoryEvidenceRow,
): void {
  const persistedText = [value.content, value.sourceRef.label, value.sourceRef.uri ?? ''].join(
    '\n',
  );
  const containsPromptOverride =
    /(?:ignore|disregard|override)\s+(?:all\s+|any\s+|the\s+)?(?:(?:previous|prior)\s+)?(?:(?:system|developer)\s+)?(?:instructions?|messages?|prompts?)|(?:reveal|print|expose)\s+(?:the\s+)?(?:system|developer)\s+(?:instructions?|messages?|prompts?)|<\s*\/?\s*(?:system|developer)\s*>|\bjailbreak\b/i.test(
      persistedText,
    );
  if (
    !ownerId.trim() ||
    value.ownerId !== ownerId ||
    !value.id.trim() ||
    !value.workspaceId.trim() ||
    !value.content.trim() ||
    value.content.length > 4_000 ||
    !value.sourceRef.kind.trim() ||
    !value.sourceRef.id.trim() ||
    !value.sourceRef.label.trim() ||
    !Number.isFinite(value.sourceRef.occurredAt) ||
    value.sourceRef.occurredAt < 0 ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !Number.isFinite(value.durabilityScore) ||
    value.durabilityScore < 0 ||
    value.durabilityScore > 1 ||
    !Number.isInteger(value.reinforcedCount) ||
    value.reinforcedCount < 1 ||
    !MEMORY_EVIDENCE_STATUSES.has(value.status) ||
    value.sensitivity === 'prohibited' ||
    hasDetectedSecret(persistedText) ||
    containsPromptOverride
  ) {
    throw new Error('memory_evidence_rejected');
  }
  if (value.sensitivity === 'sensitive') {
    throw new Error('memory_evidence_encryption_required');
  }
  if (
    existing &&
    (value.id !== existing.id ||
      value.ownerId !== existing.ownerId ||
      value.profileId !== existing.profileId ||
      value.workspaceId !== existing.workspaceId ||
      value.projectId !== existing.projectId ||
      value.createdAt !== existing.createdAt)
  ) {
    throw new Error('memory_evidence_scope_immutable');
  }
}

function evidenceHistory(
  row: MemoryEvidenceRow,
  action: MemoryEvidenceHistoryRow['action'],
  createdAt: number,
): MemoryEvidenceHistoryRow {
  return {
    id: `${row.id}:${row.revision}`,
    evidenceId: row.id,
    ownerId: row.ownerId,
    revision: row.revision,
    action,
    snapshot: structuredClone(row),
    createdAt,
  };
}

export function createMemoryEvidenceRepository(database: JarvisDexie, clock: () => number = now) {
  return {
    async create(ownerId: string, item: MemoryEvidenceItem): Promise<MemoryEvidenceRow> {
      assertMemoryEvidence(ownerId, item);
      const row: MemoryEvidenceRow = {
        ...structuredClone(item),
        schemaVersion: 1,
        recordKind: 'evidence',
        revision: 1,
      };
      await database.transaction(
        'rw',
        database.memory_items,
        database.memory_evidence_history,
        async () => {
          if (await database.memory_items.get(row.id)) {
            throw new Error('memory_evidence_conflict');
          }
          await database.memory_items.add(row);
          await database.memory_evidence_history.add(evidenceHistory(row, 'created', clock()));
        },
      );
      return structuredClone(row);
    },

    async getById(ownerId: string, id: string): Promise<MemoryEvidenceRow | undefined> {
      if (!ownerId.trim() || !id.trim()) return undefined;
      const row = await database.memory_items.get(id);
      return row && isMemoryEvidenceRow(row) && row.ownerId === ownerId
        ? structuredClone(row)
        : undefined;
    },

    async list(
      ownerId: string,
      filter: MemoryEvidenceListFilter = {},
    ): Promise<MemoryEvidenceRow[]> {
      if (!ownerId.trim()) return [];
      const rows = filter.status
        ? await database.memory_items
            .where('[ownerId+status]')
            .equals([ownerId, filter.status])
            .toArray()
        : await database.memory_items.where('ownerId').equals(ownerId).toArray();
      return rows
        .filter(isMemoryEvidenceRow)
        .filter(
          (row) =>
            row.ownerId === ownerId &&
            (filter.profileId === undefined || row.profileId === filter.profileId) &&
            (filter.workspaceId === undefined || row.workspaceId === filter.workspaceId) &&
            (filter.projectId === undefined || row.projectId === filter.projectId),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .map((row) => structuredClone(row));
    },

    async replace(ownerId: string, item: MemoryEvidenceItem): Promise<MemoryEvidenceRow> {
      return database.transaction(
        'rw',
        database.memory_items,
        database.memory_evidence_history,
        async () => {
          const current = await database.memory_items.get(item.id);
          if (!current || !isMemoryEvidenceRow(current) || current.ownerId !== ownerId) {
            throw new Error('memory_evidence_not_found');
          }
          assertMemoryEvidence(ownerId, item, current);
          const row: MemoryEvidenceRow = {
            ...structuredClone(item),
            updatedAt: clock(),
            schemaVersion: 1,
            recordKind: 'evidence',
            revision: current.revision + 1,
          };
          await database.memory_items.put(row);
          await database.memory_evidence_history.add(evidenceHistory(row, 'updated', clock()));
          return structuredClone(row);
        },
      );
    },

    async delete(ownerId: string, id: string): Promise<void> {
      await database.transaction(
        'rw',
        database.memory_items,
        database.memory_evidence_history,
        async () => {
          const current = await database.memory_items.get(id);
          if (!current || !isMemoryEvidenceRow(current) || current.ownerId !== ownerId) {
            throw new Error('memory_evidence_not_found');
          }
          const deleted = { ...current, revision: current.revision + 1, updatedAt: clock() };
          await database.memory_evidence_history.add(evidenceHistory(deleted, 'deleted', clock()));
          await database.memory_items.delete(id);
        },
      );
    },

    async history(ownerId: string, evidenceId: string): Promise<MemoryEvidenceHistoryRow[]> {
      if (!ownerId.trim() || !evidenceId.trim()) return [];
      const rows = await database.memory_evidence_history
        .where('[ownerId+evidenceId]')
        .equals([ownerId, evidenceId])
        .toArray();
      return rows
        .filter((row) => row.ownerId === ownerId && row.evidenceId === evidenceId)
        .sort((left, right) => left.revision - right.revision)
        .map((row) => structuredClone(row));
    },
  };
}

type MemoryEvidenceRepository = ReturnType<typeof createMemoryEvidenceRepository>;

let defaultMemoryEvidenceRepository: MemoryEvidenceRepository | undefined;

function getDefaultMemoryEvidenceRepository(): MemoryEvidenceRepository {
  defaultMemoryEvidenceRepository ??= createMemoryEvidenceRepository(db);
  return defaultMemoryEvidenceRepository;
}

export const memoryEvidenceRepo: MemoryEvidenceRepository = {
  create: (...args) => getDefaultMemoryEvidenceRepository().create(...args),
  getById: (...args) => getDefaultMemoryEvidenceRepository().getById(...args),
  list: (...args) => getDefaultMemoryEvidenceRepository().list(...args),
  replace: (...args) => getDefaultMemoryEvidenceRepository().replace(...args),
  delete: (...args) => getDefaultMemoryEvidenceRepository().delete(...args),
  history: (...args) => getDefaultMemoryEvidenceRepository().history(...args),
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function createSettingWithOwner(
  input: { key: string; value: unknown },
  syncOwner: SyncQueueOwnerSnapshot,
): Promise<SettingsRow> {
  const row: SettingsRow = {
    key: input.key,
    value: input.value,
    updated_at: now(),
  };
  await db.settings.put(row);
  await syncUpdate('settings', row, syncOwner);
  return row;
}

/**
 * Simple key/value store over the `settings` table.
 *
 * Values are stored as raw JSON-serialisable values; consumers cast at the
 * call site via `settingsRepo.get<T>(key)`. Use this for things like
 * quiet-hours config, daily-briefing time, last sync timestamp, etc.
 */
export const settingsRepo = {
  async getById(key: string): Promise<SettingsRow | undefined> {
    return db.settings.get(key);
  },
  /** Convenience accessor that returns the raw value, or undefined if unset. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await db.settings.get(key);
    return row?.value as T | undefined;
  },
  async list(): Promise<SettingsRow[]> {
    return db.settings.toArray();
  },
  async create(input: { key: string; value: unknown }): Promise<SettingsRow> {
    assertMutableSettingKey(input.key);
    const syncOwner = captureSyncQueueOwner();
    return createSettingWithOwner(input, syncOwner);
  },
  /** Upsert `value` at `key`. Idempotent. */
  async set(key: string, value: unknown): Promise<SettingsRow> {
    assertMutableSettingKey(key);
    const syncOwner = captureSyncQueueOwner();
    return createSettingWithOwner({ key, value }, syncOwner);
  },
  async update(key: string, patch: Partial<SettingsRow>): Promise<SettingsRow> {
    assertMutableSettingKey(key);
    if (patch.key !== undefined) assertMutableSettingKey(patch.key);
    const syncOwner = captureSyncQueueOwner();
    const existing = await db.settings.get(key);
    const next: SettingsRow = {
      key,
      value: patch.value !== undefined ? patch.value : existing?.value,
      updated_at: now(),
    };
    await db.settings.put(next);
    await syncUpdate('settings', next, syncOwner);
    return next;
  },
  async delete(key: string): Promise<void> {
    assertMutableSettingKey(key);
    const syncOwner = captureSyncQueueOwner();
    await db.settings.delete(key);
    await syncDelete('settings', key, syncOwner);
  },
};

// ===========================================================================
// V2 — Events
// ===========================================================================

export type EventListFilter = {
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  status?: EventStatus;
  /** Inclusive lower bound on start_at (unix ms). */
  from_ms?: number;
  /** Exclusive upper bound on start_at (unix ms). */
  to_ms?: number;
  limit?: number;
};

export type EventCreateInput = Pick<
  EventRow,
  'workspace_id' | 'title' | 'start_at' | 'end_at' | 'created_by'
> &
  Partial<Omit<EventRow, 'id' | 'created_at' | 'updated_at'>> & {
    id?: EventId;
  };

/**
 * Helper — read the device IANA timezone safely. Falls back to UTC if the
 * Intl API isn't available (older runtimes).
 */
function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * CRUD over the `events` table.
 *
 * Events have a definite (start, end) window in unix ms. The DayGrid view
 * uses `listInRange` to fetch events for a visible day; ScheduleView uses
 * `listByWorkspace` for upcoming feeds. Reminders are stored inline as a
 * `reminders` jsonb-style column on the row.
 */
export const eventRepo = {
  async getById(id: EventId): Promise<EventRow | undefined> {
    return db.events.get(id);
  },
  async list(filter?: EventListFilter): Promise<EventRow[]> {
    let rows: EventRow[];
    if (filter?.workspace_id && filter.from_ms !== undefined && filter.to_ms !== undefined) {
      rows = await db.events
        .where('[workspace_id+start_at]')
        .between(
          [filter.workspace_id, filter.from_ms],
          [filter.workspace_id, filter.to_ms],
          true,
          false,
        )
        .toArray();
    } else if (filter?.workspace_id) {
      rows = await db.events.where('workspace_id').equals(filter.workspace_id).toArray();
    } else {
      rows = await db.events.toArray();
    }
    if (filter?.project_id !== undefined) {
      rows = rows.filter((e) => e.project_id === filter.project_id);
    }
    if (filter?.status) {
      rows = rows.filter((e) => e.status === filter.status);
    }
    rows.sort((a, b) => a.start_at - b.start_at);
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<EventRow[]> {
    return db.events.where('workspace_id').equals(workspaceId).sortBy('start_at');
  },
  async listInRange(workspaceId: WorkspaceId, fromMs: number, toMs: number): Promise<EventRow[]> {
    return db.events
      .where('[workspace_id+start_at]')
      .between([workspaceId, fromMs], [workspaceId, toMs], true, false)
      .sortBy('start_at');
  },
  async listUpcoming(workspaceId: WorkspaceId, limit = 5): Promise<EventRow[]> {
    const ts = now();
    const rows = await db.events
      .where('[workspace_id+start_at]')
      .between([workspaceId, ts], [workspaceId, Number.MAX_SAFE_INTEGER], true, true)
      .toArray();
    return rows
      .filter((e) => e.status === 'scheduled' || e.status === 'tentative')
      .sort((a, b) => a.start_at - b.start_at)
      .slice(0, limit);
  },
  async create(input: EventCreateInput): Promise<EventRow> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: EventRow = {
      id: input.id ?? newEventId(),
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      title: input.title,
      description: input.description,
      start_at: input.start_at,
      end_at: input.end_at,
      all_day: input.all_day ?? false,
      timezone: input.timezone ?? deviceTimezone(),
      location: input.location,
      attendees: input.attendees ?? [],
      source: input.source ?? 'manual',
      source_ref: input.source_ref,
      recurrence_rule: input.recurrence_rule,
      reminders: input.reminders ?? [],
      status: input.status ?? 'scheduled',
      color_hue: input.color_hue,
      created_by: input.created_by,
      created_at: ts,
      updated_at: ts,
    };
    await db.events.add(row);
    await syncInsert('events', row, syncOwner);
    return row;
  },
  async update(id: EventId, patch: Partial<EventRow>): Promise<EventRow> {
    const syncOwner = captureSyncQueueOwner();
    await db.events.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.events.get(id), 'event', id);
    await syncUpdate('events', row, syncOwner);
    return row;
  },
  async delete(id: EventId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.events.delete(id);
    await syncDelete('events', id, syncOwner);
  },
};

// ===========================================================================
// V2 — Quick Links + Quick Link Groups
// ===========================================================================

export type QuickLinkCreateInput = Pick<QuickLink, 'workspace_id' | 'label' | 'url' | 'kind'> &
  Partial<Omit<QuickLink, 'id' | 'created_at' | 'updated_at'>> & {
    id?: QuickLinkId;
  };

export type QuickLinkGroupCreateInput = Pick<QuickLinkGroup, 'workspace_id' | 'name'> &
  Partial<Omit<QuickLinkGroup, 'id' | 'created_at' | 'updated_at'>> & {
    id?: QuickLinkGroupId;
  };

/**
 * CRUD over the `quick_link_groups` table.
 *
 * Groups are user-defined containers shown as chips in the launcher. Empty
 * groups are allowed (so you can build up a "Reading" chip before pasting
 * links into it). Position drives left-to-right order.
 */
export const quickLinkGroupRepo = {
  async getById(id: QuickLinkGroupId): Promise<QuickLinkGroup | undefined> {
    return db.quick_link_groups.get(id);
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<QuickLinkGroup[]> {
    const rows = await db.quick_link_groups.where('workspace_id').equals(workspaceId).toArray();
    rows.sort((a, b) => a.position - b.position);
    return rows;
  },
  async create(input: QuickLinkGroupCreateInput): Promise<QuickLinkGroup> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: QuickLinkGroup = {
      id: input.id ?? newQuickLinkGroupId(),
      workspace_id: input.workspace_id,
      name: input.name,
      color_hue: input.color_hue,
      position: input.position ?? 0,
      created_at: ts,
      updated_at: ts,
    };
    await db.quick_link_groups.add(row);
    await syncInsert('quick_link_groups', row, syncOwner);
    return row;
  },
  async update(id: QuickLinkGroupId, patch: Partial<QuickLinkGroup>): Promise<QuickLinkGroup> {
    const syncOwner = captureSyncQueueOwner();
    await db.quick_link_groups.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.quick_link_groups.get(id), 'quick_link_group', id);
    await syncUpdate('quick_link_groups', row, syncOwner);
    return row;
  },
  async delete(id: QuickLinkGroupId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    // Detach links from the group rather than cascading. Keeps user data safe.
    const affectedLinkIds = (await db.quick_links.where('group_id').equals(id).toArray()).map(
      (link) => link.id,
    );
    const ts = now();
    await db.transaction('rw', db.quick_link_groups, db.quick_links, async () => {
      await db.quick_links
        .where('group_id')
        .equals(id)
        .modify({ group_id: undefined, updated_at: ts });
      await db.quick_link_groups.delete(id);
    });
    await Promise.all(
      affectedLinkIds.map(async (linkId) => {
        const link = await db.quick_links.get(linkId);
        if (link) await syncUpdate('quick_links', link, syncOwner);
      }),
    );
    await syncDelete('quick_link_groups', id, syncOwner);
  },
};

/**
 * CRUD over the `quick_links` table.
 *
 * Links represent any launchable URL/app/file/jarvis-action. The launcher
 * renders by group + position. `last_used_at` is bumped on launch so the
 * "stale links" hook can surface neglected entries on the ambient screen.
 */
export const quickLinkRepo = {
  async getById(id: QuickLinkId): Promise<QuickLink | undefined> {
    return db.quick_links.get(id);
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<QuickLink[]> {
    const rows = await db.quick_links.where('workspace_id').equals(workspaceId).toArray();
    rows.sort((a, b) => a.position - b.position);
    return rows;
  },
  async listByGroup(
    workspaceId: WorkspaceId,
    groupId: QuickLinkGroupId | undefined,
  ): Promise<QuickLink[]> {
    const rows = await db.quick_links.where('workspace_id').equals(workspaceId).toArray();
    return rows
      .filter((l) => (groupId ? l.group_id === groupId : !l.group_id))
      .sort((a, b) => a.position - b.position);
  },
  async listStale(workspaceId: WorkspaceId, sinceMs: number): Promise<QuickLink[]> {
    const cutoff = now() - sinceMs;
    const rows = await db.quick_links.where('workspace_id').equals(workspaceId).toArray();
    return rows
      .filter((l) => (l.last_used_at ?? 0) < cutoff)
      .sort((a, b) => (a.last_used_at ?? 0) - (b.last_used_at ?? 0));
  },
  async create(input: QuickLinkCreateInput): Promise<QuickLink> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: QuickLink = {
      id: input.id ?? newQuickLinkId(),
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      group_id: input.group_id,
      label: input.label,
      url: input.url,
      kind: input.kind,
      icon: input.icon,
      color_hue: input.color_hue,
      behavior: input.behavior ?? 'external_browser',
      hotkey: input.hotkey,
      position: input.position ?? 0,
      tags: input.tags ?? [],
      last_used_at: input.last_used_at,
      created_at: ts,
      updated_at: ts,
    };
    await db.quick_links.add(row);
    await syncInsert('quick_links', row, syncOwner);
    return row;
  },
  async update(id: QuickLinkId, patch: Partial<QuickLink>): Promise<QuickLink> {
    const syncOwner = captureSyncQueueOwner();
    await db.quick_links.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.quick_links.get(id), 'quick_link', id);
    await syncUpdate('quick_links', row, syncOwner);
    return row;
  },
  async delete(id: QuickLinkId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.quick_links.delete(id);
    await syncDelete('quick_links', id, syncOwner);
  },
  async touchLastUsed(id: QuickLinkId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.quick_links.update(id, { last_used_at: now() });
    const row = await db.quick_links.get(id);
    if (row) await syncUpdate('quick_links', row, syncOwner);
  },
  /**
   * Re-order `dragId` to land just before `beforeId` (or at the end of the
   * list when `beforeId` is null). The new order applies to whatever subset
   * of links the caller passes via `scope`, so the launcher can reorder a
   * filtered view (single group, "ungrouped", or "all") without us having
   * to re-derive the visible list inside the repo.
   *
   * Implementation: renumber every row in `scope` from 0..n with a step of
   * 100, leaving room between rows for future float-style inserts.
   */
  async reorder(
    dragId: QuickLinkId,
    beforeId: QuickLinkId | null,
    scope: QuickLink[],
  ): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    if (dragId === beforeId) return;
    const ordered = scope.slice().sort((a, b) => a.position - b.position);
    const without = ordered.filter((l) => l.id !== dragId);
    const dragRow = ordered.find((l) => l.id === dragId);
    if (!dragRow) return;

    const insertAt =
      beforeId === null ? without.length : without.findIndex((l) => l.id === beforeId);
    if (beforeId !== null && insertAt === -1) return;
    without.splice(insertAt, 0, dragRow);

    const ts = now();
    await db.transaction('rw', db.quick_links, async () => {
      for (let i = 0; i < without.length; i++) {
        const newPos = (i + 1) * 100;
        if (without[i].position !== newPos) {
          await db.quick_links.update(without[i].id, { position: newPos, updated_at: ts });
        }
      }
    });
    await Promise.all(
      without.map(async (link) => {
        const row = await db.quick_links.get(link.id);
        if (row) await syncUpdate('quick_links', row, syncOwner);
      }),
    );
  },
};

// ===========================================================================
// V2 — Terminals (presets, sessions, scrollback, layouts)
// ===========================================================================

export type TerminalPresetCreateInput = Pick<
  TerminalPreset,
  'workspace_id' | 'name' | 'slug' | 'command'
> &
  Partial<Omit<TerminalPreset, 'id' | 'created_at' | 'updated_at'>> & {
    id?: TerminalPresetId;
  };

/**
 * CRUD over the `terminal_presets` table.
 *
 * Built-in presets (Claude, OpenCode, Bash, etc) live in code only — see
 * `features/terminals/presets/builtin.ts`. This table holds user-defined
 * entries plus user overrides of built-ins (a user-defined row with the
 * same slug shadows the built-in).
 *
 * Uniqueness scoped to (workspace_id, slug) so the same slug can exist in
 * different workspaces.
 */
export const terminalPresetRepo = {
  async getById(id: TerminalPresetId): Promise<TerminalPreset | undefined> {
    return db.terminal_presets.get(id);
  },
  async getBySlug(workspaceId: WorkspaceId, slug: string): Promise<TerminalPreset | undefined> {
    return db.terminal_presets.where('[workspace_id+slug]').equals([workspaceId, slug]).first();
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<TerminalPreset[]> {
    return db.terminal_presets.where('workspace_id').equals(workspaceId).toArray();
  },
  async create(input: TerminalPresetCreateInput): Promise<TerminalPreset> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: TerminalPreset = {
      id: input.id ?? newTerminalPresetId(),
      workspace_id: input.workspace_id,
      name: input.name,
      slug: input.slug,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      cwd: input.cwd,
      color_hue: input.color_hue,
      icon: input.icon,
      one_shot: input.one_shot ?? false,
      auto_run: input.auto_run ?? false,
      requires: input.requires,
      user_defined: input.user_defined ?? true,
      created_at: ts,
      updated_at: ts,
    };
    await db.terminal_presets.add(row);
    await syncInsert('terminal_presets', row, syncOwner);
    return row;
  },
  async update(id: TerminalPresetId, patch: Partial<TerminalPreset>): Promise<TerminalPreset> {
    const syncOwner = captureSyncQueueOwner();
    await db.terminal_presets.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.terminal_presets.get(id), 'terminal_preset', id);
    await syncUpdate('terminal_presets', row, syncOwner);
    return row;
  },
  async delete(id: TerminalPresetId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.terminal_presets.delete(id);
    await syncDelete('terminal_presets', id, syncOwner);
  },
};

export type TerminalSessionCreateInput = Pick<
  TerminalSession,
  'workspace_id' | 'title' | 'shell_command'
> &
  Partial<Omit<TerminalSession, 'id' | 'created_at' | 'last_active_at'>> & {
    id?: TerminalSessionId;
  };

async function updateTerminalSessionWithOwner(
  id: TerminalSessionId,
  patch: Partial<TerminalSession>,
  syncOwner: SyncQueueOwnerSnapshot,
): Promise<TerminalSession> {
  const sanitized: Partial<TerminalSession> = { ...patch };
  delete (sanitized as { id?: unknown }).id;
  delete (sanitized as { created_at?: unknown }).created_at;
  await db.terminal_sessions.update(id, sanitized);
  const row = await requireRow(() => db.terminal_sessions.get(id), 'terminal_session', id);
  await syncUpdate('terminal_sessions', row, syncOwner);
  return row;
}

/**
 * CRUD over the `terminal_sessions` table.
 *
 * Each row mirrors a live PTY managed by the Rust backend. Status lifecycle:
 *   running   — process alive, pty attached
 *   detached  — process alive, pty detached (UI not subscribed)
 *   exited    — process gone; row kept until user dismisses
 *
 * Denormalized `preset_slug`, `shell_command`, `shell_args` mean a session
 * is replayable even after the source preset is deleted.
 */
export const terminalSessionRepo = {
  async getById(id: TerminalSessionId): Promise<TerminalSession | undefined> {
    return db.terminal_sessions.get(id);
  },
  async listByProject(projectId: ProjectId): Promise<TerminalSession[]> {
    return db.terminal_sessions.where('project_id').equals(projectId).toArray();
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<TerminalSession[]> {
    return db.terminal_sessions.where('workspace_id').equals(workspaceId).toArray();
  },
  async listRunning(projectId: ProjectId): Promise<TerminalSession[]> {
    return db.terminal_sessions
      .where('[project_id+status]')
      .anyOf([
        [projectId, 'running'] as [ProjectId, TerminalSessionStatus],
        [projectId, 'detached'] as [ProjectId, TerminalSessionStatus],
      ])
      .toArray();
  },
  async listRecentByLastActive(limit = 20): Promise<TerminalSession[]> {
    return db.terminal_sessions.orderBy('last_active_at').reverse().limit(limit).toArray();
  },
  async create(input: TerminalSessionCreateInput): Promise<TerminalSession> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const row: TerminalSession = {
      id: input.id ?? newTerminalSessionId(),
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      title: input.title,
      preset_id: input.preset_id,
      preset_slug: input.preset_slug,
      shell_command: input.shell_command,
      shell_args: input.shell_args ?? [],
      status: input.status ?? 'running',
      pid: input.pid,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      cwd: input.cwd,
      env: input.env,
      exit_code: input.exit_code,
      one_shot: input.one_shot ?? false,
      created_at: ts,
      last_active_at: ts,
    };
    await db.terminal_sessions.add(row);
    await syncInsert('terminal_sessions', row, syncOwner);
    return row;
  },
  async update(id: TerminalSessionId, patch: Partial<TerminalSession>): Promise<TerminalSession> {
    const syncOwner = captureSyncQueueOwner();
    return updateTerminalSessionWithOwner(id, patch, syncOwner);
  },
  async touchActive(id: TerminalSessionId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.terminal_sessions.update(id, { last_active_at: now() });
    const row = await db.terminal_sessions.get(id);
    if (row) await syncUpdate('terminal_sessions', row, syncOwner);
  },
  async markExited(id: TerminalSessionId, exitCode: number): Promise<TerminalSession> {
    const syncOwner = captureSyncQueueOwner();
    return updateTerminalSessionWithOwner(id, { status: 'exited', exit_code: exitCode }, syncOwner);
  },
  async delete(id: TerminalSessionId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.transaction('rw', db.terminal_sessions, db.terminal_scrollback, async () => {
      await db.terminal_scrollback.where('session_id').equals(id).delete();
      await db.terminal_sessions.delete(id);
    });
    await syncDelete('terminal_sessions', id, syncOwner);
  },
};

/**
 * Append-only scrollback for terminal output. Chunks are base64-encoded
 * raw bytes from the PTY (terminal output is binary-safe). The compound
 * primary key [session_id+chunk_seq] ensures monotonic ordering per session.
 *
 * `cap` enforces a per-session retention cap (default 5000 chunks, ~50MB at
 * 10KB/chunk). Older chunks are pruned on each append past the cap.
 */
export const terminalScrollbackRepo = {
  async append(
    sessionId: TerminalSessionId,
    data: string,
    cap = 5000,
  ): Promise<TerminalScrollbackChunk> {
    const ts = now();
    const result = await db.transaction('rw', db.terminal_scrollback, async () => {
      // Find next sequence number for this session.
      const last = await db.terminal_scrollback
        .where('session_id')
        .equals(sessionId)
        .reverse()
        .sortBy('chunk_seq');
      const nextSeq = last.length === 0 ? 0 : last[0].chunk_seq + 1;
      const chunk: TerminalScrollbackChunk = {
        session_id: sessionId,
        chunk_seq: nextSeq,
        data,
        created_at: ts,
      };
      await db.terminal_scrollback.add(chunk);

      // Prune anything beyond the cap (keep the newest `cap` chunks).
      if (nextSeq + 1 > cap) {
        const pruneBefore = nextSeq + 1 - cap;
        await db.terminal_scrollback
          .where('[session_id+chunk_seq]')
          .between([sessionId, 0], [sessionId, pruneBefore], true, false)
          .delete();
      }
      return chunk;
    });
    return result;
  },
  async listBySession(
    sessionId: TerminalSessionId,
    limit?: number,
  ): Promise<TerminalScrollbackChunk[]> {
    const coll = db.terminal_scrollback.where('session_id').equals(sessionId);
    const rows = await coll.toArray();
    rows.sort((a, b) => a.chunk_seq - b.chunk_seq);
    return limit ? rows.slice(-limit) : rows;
  },
  async listRecent(sinceMs: number, limit = 50): Promise<TerminalScrollbackChunk[]> {
    const cutoff = now() - sinceMs;
    const rows = await db.terminal_scrollback.where('created_at').above(cutoff).toArray();
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows.slice(0, limit);
  },
  async clearForSession(sessionId: TerminalSessionId): Promise<void> {
    await db.terminal_scrollback.where('session_id').equals(sessionId).delete();
  },
};

/**
 * One row per project. Captures the user's last-used view mode and pane
 * assignments so re-opening a project restores its terminal layout.
 *
 * V2 view modes: 'single' | 'grid' | 'tabs' | 'fullscreen'. The fullscreen
 * mode (Mod+Shift+F) records `fullscreen_session_id` so the canvas re-mounts
 * the right pane on next open.
 */
export const terminalLayoutRepo = {
  async get(projectId: ProjectId): Promise<TerminalLayout | undefined> {
    return db.terminal_layouts.get(projectId);
  },
  async upsert(layout: Omit<TerminalLayout, 'updated_at'>): Promise<TerminalLayout> {
    const syncOwner = captureSyncQueueOwner();
    const next: TerminalLayout = { ...layout, updated_at: now() };
    await db.terminal_layouts.put(next);
    await syncUpdate('terminal_layouts', next, syncOwner);
    return next;
  },
  async update(projectId: ProjectId, patch: Partial<TerminalLayout>): Promise<TerminalLayout> {
    const syncOwner = captureSyncQueueOwner();
    const sanitized: Partial<TerminalLayout> = { ...patch };
    delete (sanitized as { project_id?: unknown }).project_id;
    await db.terminal_layouts.update(projectId, { ...sanitized, updated_at: now() });
    const row = await requireRow(
      () => db.terminal_layouts.get(projectId),
      'terminal_layout',
      projectId,
    );
    await syncUpdate('terminal_layouts', row, syncOwner);
    return row;
  },
  async delete(projectId: ProjectId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.terminal_layouts.delete(projectId);
    await syncDelete('terminal_layouts', projectId, syncOwner);
  },
};

// ===========================================================================
// V2 — Integrations
// ===========================================================================

export type IntegrationCreateInput = Pick<Integration, 'kind'> &
  Partial<Omit<Integration, 'id' | 'created_at' | 'updated_at'>> & {
    id?: IntegrationId;
  };

/**
 * CRUD over the `integrations` table.
 *
 * One row per (kind) — at most one Supabase, one GitHub, one Google. Secrets
 * live in Stronghold/keyring; only `secret_ref` (the lookup key) is stored
 * here. `config_json` carries kind-specific public config (URLs, default
 * repo, calendar id, etc).
 */
export const integrationRepo = {
  async getById(id: IntegrationId): Promise<Integration | undefined> {
    return db.integrations.get(id);
  },
  async getByKind(kind: IntegrationKind): Promise<Integration | undefined> {
    return db.integrations.where('kind').equals(kind).first();
  },
  async list(): Promise<Integration[]> {
    return db.integrations.toArray();
  },
  async upsert(input: IntegrationCreateInput): Promise<Integration> {
    const syncOwner = captureSyncQueueOwner();
    const ts = now();
    const existing = await integrationRepo.getByKind(input.kind);
    if (existing) {
      const sanitized: Partial<Integration> = { ...input };
      delete (sanitized as { id?: unknown }).id;
      delete (sanitized as { created_at?: unknown }).created_at;
      delete (sanitized as { kind?: unknown }).kind;
      await db.integrations.update(existing.id, { ...sanitized, updated_at: ts });
      const row = await requireRow(
        () => db.integrations.get(existing.id),
        'integration',
        existing.id,
      );
      await syncUpdate('integrations', row, syncOwner);
      return row;
    }
    const row: Integration = {
      id: input.id ?? newIntegrationId(),
      kind: input.kind,
      status: input.status ?? 'disconnected',
      config_json: input.config_json ?? {},
      secret_ref: input.secret_ref ?? null,
      scopes_json: input.scopes_json ?? [],
      last_synced_at: input.last_synced_at ?? null,
      expires_at: input.expires_at ?? null,
      error_message: input.error_message ?? null,
      created_at: ts,
      updated_at: ts,
    };
    await db.integrations.add(row);
    await syncInsert('integrations', row, syncOwner);
    return row;
  },
  async update(id: IntegrationId, patch: Partial<Integration>): Promise<Integration> {
    const syncOwner = captureSyncQueueOwner();
    await db.integrations.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    const row = await requireRow(() => db.integrations.get(id), 'integration', id);
    await syncUpdate('integrations', row, syncOwner);
    return row;
  },
  async delete(id: IntegrationId): Promise<void> {
    const syncOwner = captureSyncQueueOwner();
    await db.integrations.delete(id);
    await syncDelete('integrations', id, syncOwner);
  },
};

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
 * Repos do NOT call into the sync layer. The runtime calls
 * `enqueueMutation` from `@/lib/sync` after CRUD when cloud sync is on.
 * That keeps the layers decoupled and avoids circular imports between
 * `db/*` and `sync.ts`.
 */

import { nanoid } from 'nanoid';
import type {
  AgentId,
  ChatId,
  MessageId,
  ProjectId,
  ReminderId,
  TaskId,
  WorkspaceId,
} from '@/types/common';
import type { Agent } from '@/types/agent';
import type { Chat, ChatMode, Message } from '@/types/chat';
import type { MemoryItem } from '@/types/memory';
import type {
  EnergyLevel,
  EffortPoints,
  Reminder,
  Task,
  TaskInput,
  TaskPriority,
  TaskStatus,
} from '@/types/task';
import {
  newAgentId,
  newChatId,
  newMessageId,
  newProjectId,
  newReminderId,
  newTaskId,
  newWorkspaceId,
} from '@/lib/ids';
import { db } from './index';
import type { Project, SettingsRow, Workspace } from './schema';

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

async function requireRow<T>(loader: () => Promise<T | undefined>, table: string, id: string): Promise<T> {
  const row = await loader();
  if (!row) throw new Error(`${table} ${id} not found`);
  return row;
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
    const ts = now();
    const row: Workspace = {
      id: input.id ?? newWorkspaceId(),
      name: input.name,
      owner_id: input.owner_id,
      created_at: ts,
      updated_at: ts,
    };
    await db.workspaces.add(row);
    return row;
  },
  async update(id: WorkspaceId, patch: Partial<Workspace>): Promise<Workspace> {
    await db.workspaces.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.workspaces.get(id), 'workspace', id);
  },
  async delete(id: WorkspaceId): Promise<void> {
    await db.workspaces.delete(id);
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
    return row;
  },
  async update(id: ProjectId, patch: Partial<Project>): Promise<Project> {
    await db.projects.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.projects.get(id), 'project', id);
  },
  async delete(id: ProjectId): Promise<void> {
    await db.projects.delete(id);
  },
};

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export type ChatCreateInput = Omit<Chat, 'id' | 'created_at' | 'updated_at'> & {
  id?: ChatId;
};

export type ChatListFilter = {
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  archived?: boolean;
  mode?: ChatMode;
  limit?: number;
};

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
    const ts = now();
    const row: Chat = {
      id: input.id ?? newChatId(),
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      title: input.title,
      mode: input.mode,
      active_agent_ids: input.active_agent_ids,
      archived: input.archived,
      created_at: ts,
      updated_at: ts,
    };
    await db.chats.add(row);
    return row;
  },
  async update(id: ChatId, patch: Partial<Chat>): Promise<Chat> {
    await db.chats.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.chats.get(id), 'chat', id);
  },
  async delete(id: ChatId): Promise<void> {
    await db.transaction('rw', db.chats, db.messages, async () => {
      await db.messages.where('chat_id').equals(id).delete();
      await db.chats.delete(id);
    });
  },
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageCreateInput = Omit<Message, 'id' | 'created_at' | 'updated_at'> & {
  id?: MessageId;
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
    return db.messages.where('[chat_id+created_at]').between([chatId, 0], [chatId, Infinity]).toArray();
  },
  async listChildren(parentId: MessageId): Promise<Message[]> {
    return db.messages.where('parent_id').equals(parentId).sortBy('created_at');
  },
  async countByChat(chatId: ChatId): Promise<number> {
    return db.messages.where('chat_id').equals(chatId).count();
  },
  async create(input: MessageCreateInput): Promise<Message> {
    const ts = now();
    const row: Message = {
      id: input.id ?? newMessageId(),
      chat_id: input.chat_id,
      role: input.role,
      agent_id: input.agent_id,
      parts: input.parts,
      parent_id: input.parent_id,
      usage: input.usage,
      created_at: ts,
      updated_at: ts,
    };
    await db.messages.add(row);
    // Bump the parent chat's updated_at so chat lists reorder by recency.
    await db.chats.update(input.chat_id, { updated_at: ts });
    return row;
  },
  async update(id: MessageId, patch: Partial<Message>): Promise<Message> {
    await db.messages.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.messages.get(id), 'message', id);
  },
  async delete(id: MessageId): Promise<void> {
    await db.messages.delete(id);
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
    const ts = now();
    const row: Agent = {
      ...input,
      id: input.id ?? newAgentId(),
      created_at: ts,
      updated_at: ts,
    } as Agent;
    await db.agents.add(row);
    return row;
  },
  async update(id: AgentId, patch: Partial<Agent>): Promise<Agent> {
    await db.agents.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.agents.get(id), 'agent', id);
  },
  async delete(id: AgentId): Promise<void> {
    const existing = await db.agents.get(id);
    if (existing?.builtin) {
      throw new Error(`agent ${id} is built-in and cannot be deleted`);
    }
    await db.agents.delete(id);
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
    return db.tasks
      .where('[workspace_id+status]')
      .equals([workspaceId, status])
      .toArray();
  },
  async listDueBefore(workspaceId: WorkspaceId, ts: number): Promise<Task[]> {
    const rows = await db.tasks.where('workspace_id').equals(workspaceId).toArray();
    return rows.filter((t) => t.due_at !== undefined && t.due_at <= ts);
  },
  async listScheduledBetween(workspaceId: WorkspaceId, fromTs: number, toTs: number): Promise<Task[]> {
    const rows = await db.tasks.where('workspace_id').equals(workspaceId).toArray();
    return rows.filter((t) => t.scheduled_for !== undefined && t.scheduled_for >= fromTs && t.scheduled_for <= toTs);
  },
  async create(input: TaskCreateInput): Promise<Task> {
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
    return row;
  },
  async update(id: TaskId, patch: Partial<Task>): Promise<Task> {
    await db.tasks.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.tasks.get(id), 'task', id);
  },
  async delete(id: TaskId): Promise<void> {
    await db.tasks.delete(id);
  },

  // ---------- Reminder helpers (live inside the task row) ----------

  /**
   * Append a new reminder to the task. Returns the updated task.
   */
  async addReminder(
    taskId: TaskId,
    reminder: Omit<Reminder, 'id' | 'task_id' | 'snooze_history' | 'status'>,
  ): Promise<Task> {
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
    return taskRepo.update(taskId, { reminders: [...task.reminders, next] });
  },
  async updateReminder(taskId: TaskId, reminderId: ReminderId, patch: Partial<Reminder>): Promise<Task> {
    const task = await requireRow(() => db.tasks.get(taskId), 'task', taskId);
    const reminders = task.reminders.map((r) => (r.id === reminderId ? { ...r, ...patch, id: r.id, task_id: r.task_id } : r));
    return taskRepo.update(taskId, { reminders });
  },
  async deleteReminder(taskId: TaskId, reminderId: ReminderId): Promise<Task> {
    const task = await requireRow(() => db.tasks.get(taskId), 'task', taskId);
    return taskRepo.update(taskId, { reminders: task.reminders.filter((r) => r.id !== reminderId) });
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

/**
 * CRUD over the `memory_items` table.
 *
 * Memory items are atoms of recalled context - chat snippets, meeting
 * highlights, file chunks, voice transcripts, web pages. The vector
 * embedding is optional client-side; the runtime computes it lazily.
 */
export const memoryRepo = {
  async getById(id: string): Promise<MemoryItem | undefined> {
    return db.memory_items.get(id);
  },
  async list(filter?: MemoryListFilter): Promise<MemoryItem[]> {
    let rows: MemoryItem[];
    if (filter?.workspace_id) {
      rows = await db.memory_items.where('workspace_id').equals(filter.workspace_id).toArray();
    } else {
      rows = await db.memory_items.toArray();
    }
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
    rows.sort((a, b) => (b.last_accessed_at ?? b.updated_at) - (a.last_accessed_at ?? a.updated_at));
    if (filter?.limit) rows = rows.slice(0, filter.limit);
    return rows;
  },
  async listByWorkspace(workspaceId: WorkspaceId): Promise<MemoryItem[]> {
    return db.memory_items.where('workspace_id').equals(workspaceId).toArray();
  },
  async listBySource(workspaceId: WorkspaceId, source: MemoryItem['source']): Promise<MemoryItem[]> {
    return db.memory_items
      .where('[workspace_id+source]')
      .equals([workspaceId, source])
      .toArray();
  },
  async listByAgent(agentId: AgentId): Promise<MemoryItem[]> {
    return db.memory_items.where('agent_id').equals(agentId).toArray();
  },
  async create(input: MemoryCreateInput): Promise<MemoryItem> {
    const ts = now();
    const row: MemoryItem = {
      ...input,
      id: input.id ?? `mem_${nanoid(16)}`,
      created_at: ts,
      updated_at: ts,
    } as MemoryItem;
    await db.memory_items.add(row);
    return row;
  },
  async update(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem> {
    await db.memory_items.update(id, { ...sanitizeUpdate(patch), updated_at: now() });
    return requireRow(() => db.memory_items.get(id), 'memory_item', id);
  },
  async delete(id: string): Promise<void> {
    await db.memory_items.delete(id);
  },
  /** Stamp `last_accessed_at` to mark a memory item as recently used by retrieval. */
  async touchAccessed(id: string): Promise<void> {
    await db.memory_items.update(id, { last_accessed_at: now() });
  },
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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
    const row: SettingsRow = { key: input.key, value: input.value, updated_at: now() };
    await db.settings.put(row);
    return row;
  },
  /** Upsert `value` at `key`. Idempotent. */
  async set(key: string, value: unknown): Promise<SettingsRow> {
    return settingsRepo.create({ key, value });
  },
  async update(key: string, patch: Partial<SettingsRow>): Promise<SettingsRow> {
    const existing = await db.settings.get(key);
    const next: SettingsRow = {
      key,
      value: patch.value !== undefined ? patch.value : existing?.value,
      updated_at: now(),
    };
    await db.settings.put(next);
    return next;
  },
  async delete(key: string): Promise<void> {
    await db.settings.delete(key);
  },
};

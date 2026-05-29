/**
 * Dexie database singleton for Jarvis.
 *
 * Usage:
 *   import { db, openDb } from '@/lib/db';
 *   await openDb();
 *   const tasks = await db.tasks.toArray();
 *
 * The db is opened lazily; calling `openDb()` is idempotent and safe to call
 * from multiple call sites (initial bootstrap, seed, sync loop).
 *
 * V1 → V2 migration: Dexie sees DB_VERSION=2 and the V2 store list, then
 * auto-creates the new tables next time the user opens the app. No data is
 * touched in the V1 tables. New install paths skip straight to V2.
 */

import Dexie, { type EntityTable } from 'dexie';
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
import {
  DB_NAME,
  DB_VERSION,
  STORES_V1,
  STORES_V2,
  type Project,
  type SettingsRow,
  type SyncQueueRow,
  type Workspace,
} from './schema';

/**
 * Strongly-typed Dexie subclass. Each table is exposed as an `EntityTable`
 * keyed on the row's primary key field, which gives us proper typing on
 * `db.tasks.get(id)`, `.add(row)`, `.update(id, patch)` etc.
 */
class JarvisDexie extends Dexie {
  // V1 tables
  workspaces!: EntityTable<Workspace, 'id'>;
  projects!: EntityTable<Project, 'id'>;
  chats!: EntityTable<Chat, 'id'>;
  messages!: EntityTable<Message, 'id'>;
  agents!: EntityTable<Agent, 'id'>;
  tasks!: EntityTable<Task, 'id'>;
  memory_items!: EntityTable<MemoryItem, 'id'>;
  settings!: EntityTable<SettingsRow, 'key'>;
  sync_queue!: EntityTable<SyncQueueRow, 'id'>;

  // V2 tables (additive)
  events!: EntityTable<EventRow, 'id'>;
  quick_links!: EntityTable<QuickLink, 'id'>;
  quick_link_groups!: EntityTable<QuickLinkGroup, 'id'>;
  terminal_presets!: EntityTable<TerminalPreset, 'id'>;
  terminal_sessions!: EntityTable<TerminalSession, 'id'>;
  /**
   * Compound primary key — Dexie's EntityTable type wants a single key field.
   * We type it on `session_id` for ergonomic `where('session_id').equals(...)`
   * queries; direct `.get(...)` calls go through the compound key form.
   */
  terminal_scrollback!: EntityTable<TerminalScrollbackChunk, 'session_id'>;
  terminal_layouts!: EntityTable<TerminalLayout, 'project_id'>;
  integrations!: EntityTable<Integration, 'id'>;

  constructor() {
    super(DB_NAME);
    // Replay history so existing V1 users auto-migrate to V2.
    this.version(1).stores(STORES_V1);
    this.version(DB_VERSION).stores(STORES_V2);
  }
}

/**
 * Process-wide database singleton. Importing this does not open the
 * underlying IndexedDB connection - the first read or write triggers it,
 * or call `openDb()` explicitly during bootstrap.
 */
export const db: JarvisDexie = new JarvisDexie();

let _openPromise: Promise<JarvisDexie> | null = null;

/**
 * Idempotently open the database. Returns the same promise on repeat calls so
 * concurrent callers all wait for the single underlying open.
 */
export function openDb(): Promise<JarvisDexie> {
  if (!_openPromise) {
    _openPromise = db.open().then(() => db);
  }
  return _openPromise;
}

/**
 * Close the database and reset the cached open promise.
 * Mostly useful for tests; production code rarely calls this.
 */
export async function closeDb(): Promise<void> {
  if (db.isOpen()) db.close();
  _openPromise = null;
}

export { DB_NAME, DB_VERSION } from './schema';
export type { Workspace, Project, SettingsRow, SyncQueueRow, SyncOp, SyncStatus, StoreName } from './schema';
export * from './repositories';
export { seedIfEmpty, DEFAULT_AGENT_SEEDS } from './seed';


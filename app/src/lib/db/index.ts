/**
 * Dexie database singleton for Jarvis V1.
 *
 * Usage:
 *   import { db, openDb } from '@/lib/db';
 *   await openDb();
 *   const tasks = await db.tasks.toArray();
 *
 * The db is opened lazily; calling `openDb()` is idempotent and safe to call
 * from multiple call sites (initial bootstrap, seed, sync loop).
 */

import Dexie, { type EntityTable } from 'dexie';
import type { Agent } from '@/types/agent';
import type { Chat, Message } from '@/types/chat';
import type { MemoryItem } from '@/types/memory';
import type { Task } from '@/types/task';
import {
  DB_NAME,
  DB_VERSION,
  STORES,
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
  workspaces!: EntityTable<Workspace, 'id'>;
  projects!: EntityTable<Project, 'id'>;
  chats!: EntityTable<Chat, 'id'>;
  messages!: EntityTable<Message, 'id'>;
  agents!: EntityTable<Agent, 'id'>;
  tasks!: EntityTable<Task, 'id'>;
  memory_items!: EntityTable<MemoryItem, 'id'>;
  settings!: EntityTable<SettingsRow, 'key'>;
  sync_queue!: EntityTable<SyncQueueRow, 'id'>;

  constructor() {
    super(DB_NAME);
    this.version(DB_VERSION).stores(STORES);
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

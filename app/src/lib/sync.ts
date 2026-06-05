/**
 * Sync queue + skeleton sync loop for Jarvis V1.
 *
 * Cloud sync is optional. When a Supabase client is configured and signed
 * in, the loop drains the local `sync_queue` table and pushes mutations to
 * Postgres.
 * When no client is configured the loop is effectively a no-op - the queue
 * still grows so that flipping cloud sync on later flushes accumulated
 * changes.
 *
 * The cloud target is `app_sync_records`, a generic per-user document table.
 * That keeps desktop local-first data safe even while the hosted Supabase
 * schema evolves independently from Dexie's full table set.
 */

import { nanoid } from 'nanoid';
import { db, openDb } from './db';
import type { StoreName, SyncOp, SyncQueueRow, SyncStatus } from './db';
import { getSupabaseClient, isCloudSyncConfigured } from './supabase';

const SYNC_ID_PREFIX = 'syq';
const newSyncId = (): string => `${SYNC_ID_PREFIX}_${nanoid(16)}`;
const CLOUD_SYNC_RECORDS_TABLE = 'app_sync_records';
const CLOUD_SYNC_CONFLICT_TARGET = 'user_id,table_name,row_id';
let syncFlushInFlight = false;

const PRIMARY_KEY_BY_TABLE: Partial<Record<StoreName, string>> = {
  settings: 'key',
  terminal_layouts: 'project_id',
};

export function primaryKeyForSyncTable(table: string): string {
  return PRIMARY_KEY_BY_TABLE[table as StoreName] ?? 'id';
}

export type CloudSyncRecord = {
  user_id: string;
  table_name: string;
  row_id: string;
  op: SyncOp;
  payload: Record<string, unknown> | null;
  deleted_at: string | null;
  updated_at: string;
};

function payloadForCloudRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function isoFromMs(ms: number, fallbackIso: string): string {
  if (!Number.isFinite(ms)) return fallbackIso;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? fallbackIso : date.toISOString();
}

export function buildCloudSyncRecord(
  row: SyncQueueRow,
  userId: string,
  nowIso = new Date().toISOString(),
): CloudSyncRecord {
  return {
    user_id: userId,
    table_name: row.table,
    row_id: row.row_id,
    op: row.op,
    payload: row.op === 'delete' ? null : payloadForCloudRecord(row.payload),
    deleted_at: row.op === 'delete' ? nowIso : null,
    updated_at: isoFromMs(row.created_at, nowIso),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a mutation for eventual upload to Supabase.
 *
 * Always writes locally regardless of whether cloud sync is configured -
 * if the user later flips it on, the queue catches up. Returns the queued
 * row's id so callers can correlate with sync logs.
 */
export async function enqueueMutation(
  op: SyncOp,
  table: string,
  row_id: string,
  payload: unknown,
): Promise<string> {
  await openDb();
  const id = newSyncId();
  const row: SyncQueueRow = {
    id,
    op,
    table,
    row_id,
    payload,
    status: 'pending',
    created_at: Date.now(),
  };
  await db.sync_queue.add(row);
  return id;
}

/**
 * Result of one drain pass over the sync queue.
 */
export type SyncFlushResult = {
  /** Number of rows successfully pushed to Supabase. */
  processed: number;
  /** Number of rows that failed and were marked `error`. */
  errored: number;
  /** Number of rows skipped because cloud sync is not configured. */
  skipped: number;
};

/**
 * Drain up to `batchSize` pending rows from the sync queue.
 *
 * - If no Supabase client is configured or no user is signed in: returns
 *   immediately with `skipped` set to the pending count, leaving rows in
 *   `pending`.
 * - Otherwise: marks each row `in_progress`, calls Supabase, and marks
 *   `done` or `error` based on the result. Errors don't block the rest of
 *   the batch.
 *
 * Wrapped in try/catch so unexpected failures don't break the loop. Errors
 * are recorded on the offending row for later inspection.
 */
export async function processSyncQueue(batchSize = 100): Promise<SyncFlushResult> {
  if (syncFlushInFlight) return { processed: 0, errored: 0, skipped: 0 };
  syncFlushInFlight = true;
  try {
    await openDb();

    const client = getSupabaseClient();
    const pending = await db.sync_queue
      .where('status')
      .equals('pending' as SyncStatus)
      .limit(batchSize)
      .toArray();
    pending.sort((a, b) => a.created_at - b.created_at);

    if (!client) {
      return { processed: 0, errored: 0, skipped: pending.length };
    }

    const { data } = await client.auth.getSession();
    const userId = data.session?.user?.id;
    if (!userId) {
      return { processed: 0, errored: 0, skipped: pending.length };
    }

    let processed = 0;
    let errored = 0;

    for (const row of pending) {
      try {
        await db.sync_queue.update(row.id, {
          status: 'in_progress' as SyncStatus,
          attempted_at: Date.now(),
        });

        const cloudRecord = buildCloudSyncRecord(row, userId);
        const { error } = await client
          .from(CLOUD_SYNC_RECORDS_TABLE)
          .upsert(cloudRecord, { onConflict: CLOUD_SYNC_CONFLICT_TARGET });
        if (error) throw error;

        await db.sync_queue.update(row.id, { status: 'done' as SyncStatus });
        processed++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await db.sync_queue.update(row.id, {
          status: 'error' as SyncStatus,
          error: message,
        });
        errored++;
      }
    }

    return { processed, errored, skipped: 0 };
  } finally {
    syncFlushInFlight = false;
  }
}

/**
 * Reset rows that are stuck in `error` (or `in_progress` from a previous
 * crashed run) back to `pending` so they're picked up on the next drain.
 */
export async function retrySyncErrors(): Promise<number> {
  await openDb();
  const stuck = await db.sync_queue
    .where('status')
    .anyOf(['error', 'in_progress'] satisfies SyncStatus[])
    .toArray();
  for (const row of stuck) {
    await db.sync_queue.update(row.id, {
      status: 'pending' as SyncStatus,
      error: undefined,
    });
  }
  return stuck.length;
}

/**
 * Delete sync queue rows that have completed and are older than `olderThanMs`.
 * Default: keep 7 days of history.
 */
export async function pruneSyncQueue(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  await openDb();
  const cutoff = Date.now() - olderThanMs;
  const removed = await db.sync_queue
    .where('status')
    .equals('done' as SyncStatus)
    .filter((r) => r.created_at < cutoff)
    .delete();
  return removed;
}

/**
 * Start a background loop that drains the sync queue every `intervalMs`.
 * Returns a `stop()` function. Safe to call when cloud sync is not
 * configured - the loop runs and the inner `processSyncQueue` no-ops.
 *
 * The loop uses a single timer (not setInterval) so a long-running drain
 * never overlaps with the next tick.
 */
export function startSyncLoop(intervalMs: number = 30_000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await processSyncQueue();
    } catch (e) {
      // Swallow - we'll retry on the next tick. Log so it's visible in dev.
      // eslint-disable-next-line no-console
      console.warn('[sync] tick failed:', e);
    }
    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  };

  // Kick off after a short delay so the app finishes booting first.
  timer = setTimeout(() => {
    void tick();
  }, Math.min(intervalMs, 2_000));

  return function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

// Re-export for convenience so consumers don't need to import from supabase
// to ask the cheapest "is sync on?" question.
export { isCloudSyncConfigured };

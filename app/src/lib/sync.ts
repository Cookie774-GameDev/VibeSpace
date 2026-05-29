/**
 * Sync queue + skeleton sync loop for Jarvis V1.
 *
 * Cloud sync is optional. When a Supabase client is configured, the loop
 * drains the local `sync_queue` table and pushes mutations to Postgres.
 * When no client is configured the loop is effectively a no-op - the queue
 * still grows so that flipping cloud sync on later flushes accumulated
 * changes.
 *
 * Real conflict resolution is stubbed. The current strategy is naive
 * last-writer-wins via Supabase's default upsert. A richer per-field LWW
 * with a conflict log lives in the design doc and is owned by a later
 * subagent.
 */

import { nanoid } from 'nanoid';
import { db, openDb } from './db';
import type { SyncOp, SyncQueueRow, SyncStatus } from './db';
import { getSupabaseClient, isCloudSyncConfigured } from './supabase';

const SYNC_ID_PREFIX = 'syq';
const newSyncId = (): string => `${SYNC_ID_PREFIX}_${nanoid(16)}`;

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
 * - If no Supabase client is configured: returns immediately with `skipped`
 *   set to the pending count, leaving rows in `pending`.
 * - Otherwise: marks each row `in_progress`, calls Supabase, and marks
 *   `done` or `error` based on the result. Errors don't block the rest of
 *   the batch.
 *
 * Wrapped in try/catch so unexpected failures don't break the loop. Errors
 * are recorded on the offending row for later inspection.
 */
export async function processSyncQueue(batchSize = 100): Promise<SyncFlushResult> {
  await openDb();

  const client = getSupabaseClient();
  const pending = await db.sync_queue
    .where('status')
    .equals('pending' as SyncStatus)
    .limit(batchSize)
    .toArray();

  if (!client) {
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

      // Stubbed routing. Real impl would:
      //   - Map our prefixed string IDs to Supabase row keys (no-op since
      //     we accept client IDs).
      //   - Translate our snake_case JSONB columns to camelCase if the
      //     Postgres schema diverges (it doesn't today - see migration).
      //   - Implement per-field LWW conflict resolution against the server
      //     copy before upserting.
      if (row.op === 'delete') {
        const { error } = await client.from(row.table).delete().eq('id', row.row_id);
        if (error) throw error;
      } else {
        // insert and update both go through upsert for idempotency.
        const { error } = await client.from(row.table).upsert(row.payload as object);
        if (error) throw error;
      }

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

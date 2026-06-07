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
const CUSTOM_TOOLS_SYNC_TABLE = 'custom_tools';
const PLUGIN_CONNECTIONS_SYNC_TABLE = 'plugin_connections';
const PULL_CURSOR_KEY_PREFIX = 'cloud_sync:last_pull_at';
let syncFlushInFlight = false;
let syncPullInFlight = false;

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

type SyncedCustomTool = {
  slug: string;
  name: string;
  description: string;
  baseAction: string;
  params: Record<string, unknown>;
  steps?: SyncedCustomToolStep[];
  emoji?: string;
  createdAt: number;
  updatedAt: number;
  published: { id: string; at: number } | null;
};

type SyncedCustomToolStep = {
  action: string;
  params: Record<string, unknown>;
  label?: string;
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

function pullCursorKey(userId: string): string {
  return `${PULL_CURSOR_KEY_PREFIX}:${userId}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCustomToolSteps(value: unknown): SyncedCustomToolStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: SyncedCustomToolStep[] = [];
  for (const rawStep of value) {
    const step = recordValue(rawStep);
    const action = stringValue(step?.action);
    if (!step || !action || action.startsWith('custom.')) continue;
    const normalized: SyncedCustomToolStep = {
      action,
      params: recordValue(step.params) ?? {},
    };
    const label = stringValue(step.label);
    if (label) normalized.label = label;
    steps.push(normalized);
    if (steps.length >= 12) break;
  }
  return steps.length > 0 ? steps : undefined;
}

export function customToolFromCloudRecord(row: CloudSyncRecord): SyncedCustomTool | null {
  if (row.table_name !== CUSTOM_TOOLS_SYNC_TABLE || row.op === 'delete') return null;
  const payload = recordValue(row.payload);
  if (!payload) return null;
  const slug = stringValue(row.row_id) ?? stringValue(payload.slug);
  const name = stringValue(payload.name);
  const baseAction = stringValue(payload.baseAction);
  const steps = normalizeCustomToolSteps(payload.steps);
  if (!slug || !name || (!baseAction && !steps)) return null;
  const updatedFallback = Date.parse(row.updated_at);
  const now = Number.isFinite(updatedFallback) ? updatedFallback : Date.now();
  const published = recordValue(payload.published);
  const publishedId = stringValue(published?.id);
  const publishedAt = numberValue(published?.at, 0);
  return {
    slug,
    name,
    description: stringValue(payload.description) ?? '',
    baseAction: steps ? (baseAction ?? 'workflow.run') : (baseAction ?? 'workflow.run'),
    params: recordValue(payload.params) ?? {},
    steps,
    emoji: stringValue(payload.emoji) ?? undefined,
    createdAt: numberValue(payload.createdAt, now),
    updatedAt: numberValue(payload.updatedAt, now),
    published: publishedId && publishedAt > 0 ? { id: publishedId, at: publishedAt } : null,
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

export type SyncPullResult = {
  /** Number of remote rows applied locally. */
  applied: number;
  /** Number of remote rows intentionally ignored. */
  skipped: number;
  /** Number of remote rows that failed to apply. */
  errored: number;
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
export async function pruneSyncQueue(
  olderThanMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  await openDb();
  const cutoff = Date.now() - olderThanMs;
  const removed = await db.sync_queue
    .where('status')
    .equals('done' as SyncStatus)
    .filter((r) => r.created_at < cutoff)
    .delete();
  return removed;
}

async function applyCustomToolCloudRecord(row: CloudSyncRecord): Promise<boolean> {
  const { useToolStore } = await import('@/features/tools/toolStore');
  if (row.op === 'delete') {
    useToolStore.setState((state) => ({
      tools: state.tools.filter((tool) => tool.slug !== row.row_id),
    }));
  } else {
    const tool = customToolFromCloudRecord(row);
    if (!tool) return false;
    useToolStore.setState((state) => ({
      tools: [tool, ...state.tools.filter((existing) => existing.slug !== tool.slug)],
    }));
  }
  if (typeof window !== 'undefined') {
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('jarvis:tools-updated')));
  }
  return true;
}

function pluginConnectionFromCloudRecord(row: CloudSyncRecord) {
  if (row.table_name !== PLUGIN_CONNECTIONS_SYNC_TABLE || row.op === 'delete') return null;
  const payload = recordValue(row.payload);
  const pluginId = stringValue(row.row_id) ?? stringValue(payload?.pluginId);
  const state = stringValue(payload?.state);
  if (
    !payload ||
    !pluginId ||
    !['connected', 'not_connected', 'needs_setup', 'error'].includes(state ?? '')
  ) {
    return null;
  }
  return {
    pluginId,
    state: state as 'connected' | 'not_connected' | 'needs_setup' | 'error',
    enabled: payload.enabled === true,
    enabledProjectIds: Array.isArray(payload.enabledProjectIds)
      ? payload.enabledProjectIds
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 50)
      : ['*'],
    accountLabel: stringValue(payload.accountLabel) ?? undefined,
    lastTestedAt: numberValue(payload.lastTestedAt, 0) || undefined,
    error: stringValue(payload.error) ?? undefined,
    configuredFields: Array.isArray(payload.configuredFields)
      ? payload.configuredFields
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 20)
      : [],
    updatedAt: numberValue(payload.updatedAt, Date.parse(row.updated_at) || Date.now()),
  };
}

async function applyPluginConnectionCloudRecord(row: CloudSyncRecord): Promise<boolean> {
  const { usePluginStore } = await import('@/features/plugins/store');
  if (row.op === 'delete') {
    usePluginStore.setState((state) => {
      const connections = { ...state.connections };
      delete connections[row.row_id];
      return { connections };
    });
    return true;
  }
  const connection = pluginConnectionFromCloudRecord(row);
  if (!connection) return false;
  usePluginStore.setState((state) => ({
    connections: { ...state.connections, [connection.pluginId]: connection },
  }));
  return true;
}

async function applyCloudSyncRecord(row: CloudSyncRecord): Promise<boolean> {
  if (row.table_name === CUSTOM_TOOLS_SYNC_TABLE) {
    return applyCustomToolCloudRecord(row);
  }
  if (row.table_name === PLUGIN_CONNECTIONS_SYNC_TABLE) {
    return applyPluginConnectionCloudRecord(row);
  }
  return false;
}

/**
 * Pull remote app sync records and apply the small subset this client can
 * safely restore today. Unsupported table names still advance the cursor so
 * they do not replay forever while broader Dexie restore work is unfinished.
 */
export async function processCloudPull(batchSize = 200): Promise<SyncPullResult> {
  if (syncPullInFlight) return { applied: 0, skipped: 0, errored: 0 };
  syncPullInFlight = true;
  try {
    await openDb();
    const client = getSupabaseClient();
    if (!client) return { applied: 0, skipped: 0, errored: 0 };

    const { data } = await client.auth.getSession();
    const userId = data.session?.user?.id;
    if (!userId) return { applied: 0, skipped: 0, errored: 0 };

    const cursorKey = pullCursorKey(userId);
    const cursor = await db.settings.get(cursorKey);
    const lastPulledAt = typeof cursor?.value === 'string' ? cursor.value : null;
    let query = client
      .from(CLOUD_SYNC_RECORDS_TABLE)
      .select('user_id,table_name,row_id,op,payload,deleted_at,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: true })
      .limit(batchSize);
    if (lastPulledAt) query = query.gt('updated_at', lastPulledAt);

    const { data: rows, error } = await query;
    if (error) throw error;

    let applied = 0;
    let skipped = 0;
    let errored = 0;
    let cursorValue = lastPulledAt;

    for (const row of (rows ?? []) as CloudSyncRecord[]) {
      try {
        const didApply = await applyCloudSyncRecord(row);
        if (didApply) applied++;
        else skipped++;
        cursorValue = row.updated_at;
      } catch (e) {
        console.warn('[sync] cloud pull record failed:', e);
        errored++;
        break;
      }
    }

    if (cursorValue && cursorValue !== lastPulledAt) {
      await db.settings.put({ key: cursorKey, value: cursorValue, updated_at: Date.now() });
    }

    return { applied, skipped, errored };
  } finally {
    syncPullInFlight = false;
  }
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
      await processCloudPull();
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
  timer = setTimeout(
    () => {
      void tick();
    },
    Math.min(intervalMs, 2_000),
  );

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

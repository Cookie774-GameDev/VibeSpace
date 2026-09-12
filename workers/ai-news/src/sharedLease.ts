import {
  asRecord,
  parseIsoTimestamp,
  type Env,
  type FreshnessState,
  type Lease,
  type LeaseAcquisition,
  type PipelineStatus,
} from './sharedTypes';

export async function acquireLease(
  env: Env,
  lockKey: string,
  runKey: string,
  leaseMs = 15 * 60 * 1000,
): Promise<LeaseAcquisition> {
  const acquiredAt = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  const fencingToken = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO ingestion_leases (lock_key, run_key, fencing_token, acquired_at, lease_until)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(lock_key) DO UPDATE SET
       run_key = excluded.run_key,
       fencing_token = excluded.fencing_token,
       acquired_at = excluded.acquired_at,
       lease_until = excluded.lease_until
     WHERE ingestion_leases.lease_until <= excluded.acquired_at
       AND (
         ingestion_leases.last_completed_run_key IS NULL
         OR ingestion_leases.last_completed_run_key <> excluded.run_key
       )`,
  )
    .bind(lockKey, runKey, fencingToken, acquiredAt, leaseUntil)
    .run();
  if (Number(result.meta.changes ?? 0) === 1) {
    return { state: 'acquired', lease: { lockKey, runKey, fencingToken } };
  }
  const current = await env.DB.prepare(
    `SELECT run_key, lease_until, last_completed_run_key
       FROM ingestion_leases WHERE lock_key = ?`,
  )
    .bind(lockKey)
    .first<{ run_key?: string; lease_until?: string; last_completed_run_key?: string }>();
  return {
    state: current?.last_completed_run_key === runKey ? 'duplicate_run' : 'active_lease',
  };
}

export async function renewLease(
  env: Env,
  lease: Lease,
  leaseMs = 15 * 60 * 1000,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE ingestion_leases SET lease_until = ?
     WHERE lock_key = ? AND run_key = ? AND fencing_token = ?`,
  )
    .bind(
      new Date(Date.now() + leaseMs).toISOString(),
      lease.lockKey,
      lease.runKey,
      lease.fencingToken,
    )
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error('lease_lost');
}

export async function markLeaseSkipped(env: Env, lockKey: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ingestion_leases
     SET last_skipped_at = ?, skip_count = skip_count + 1
     WHERE lock_key = ?`,
  )
    .bind(new Date().toISOString(), lockKey)
    .run();
}

export async function releaseLease(
  env: Env,
  lease: Lease,
  status: PipelineStatus,
  completedRun: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  if (completedRun) {
    await env.DB.prepare(
      `UPDATE ingestion_leases
       SET lease_until = ?, last_completed_at = ?, last_status = ?, last_completed_run_key = ?
       WHERE lock_key = ? AND run_key = ? AND fencing_token = ?`,
    )
      .bind(now, now, status, lease.runKey, lease.lockKey, lease.runKey, lease.fencingToken)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE ingestion_leases SET lease_until = ?, last_status = ?
     WHERE lock_key = ? AND run_key = ? AND fencing_token = ?`,
  )
    .bind(now, status, lease.lockKey, lease.runKey, lease.fencingToken)
    .run();
}

export function freshnessFromRun(
  run: unknown,
  staleAfterMs: number,
  noun: string,
): { state: FreshnessState; ageMs?: number; warning?: string } {
  const row = asRecord(run);
  const completedAt = parseIsoTimestamp(row?.completed_at);
  if (!row || !completedAt) {
    return { state: 'never', warning: `No ${noun} ingestion has completed yet.` };
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(completedAt));
  if (row.status === 'failed') {
    return {
      state: 'failed',
      ageMs,
      warning: `The latest ${noun} ingestion failed. Last-known-good data is retained when available.`,
    };
  }
  if (ageMs > staleAfterMs) {
    return { state: 'stale', ageMs, warning: `The current ${noun} dataset is outside its freshness SLA.` };
  }
  if (row.status === 'partial') {
    return { state: 'degraded', ageMs, warning: `The latest ${noun} run completed with source failures.` };
  }
  return { state: 'fresh', ageMs };
}

export function corsHeaders(env: Env): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function json(payload: unknown, status: number, baseHeaders: Headers): Response {
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers });
}

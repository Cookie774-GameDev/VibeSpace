import { afterEach, describe, expect, it } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { createJarvisRepositories } from '@/lib/db/jarvisRepositories';
import { toJarvisRunRow, toJarvisEventRow } from '@/lib/db/jarvisMappers';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { JarvisRun, JarvisEvent, JarvisTransportAttemptV1, JarvisDurableLiveEvidenceV1 } from '@/lib/jarvis/contracts/execution';
import type { JarvisKernelAccountBinding } from '../kernelRuntime';
import { createRunOwnershipDiagnostic } from './runOwnershipDiagnostic';
const opened: JarvisDexie[] = [];
afterEach(async () => { for (const db of opened.splice(0)) { db.close(); await db.delete(); } });
function attempt(number: number): JarvisTransportAttemptV1 {
  return { schemaVersion: 1, attemptNumber: number, kind: number === 1 ? 'initial' : 'transport_retry',
    requestId: `request-${number}`, state: 'provider_in_flight', startedEventSeq: number * 2 - 1,
    effectBarrier: { state: 'open', version: 0, updatedAt: 2 }, createdAt: 2, updatedAt: 2 };
}
function resultEvent(number: number): JarvisEvent {
  return { runId: 'jrun_fixture', seq: number * 2 - 1,
    idempotencyKey: `synthetic-result-${number}`, type: 'warning', title: 'synthetic prior result',
    safeSummary: 'synthetic prior result', sourceRefs: [], artifactIds: [], createdAt: number * 2 + 10 };
}
function proofEvent(number: number): JarvisEvent {
  const liveEvidence: JarvisDurableLiveEvidenceV1 = { schemaVersion: 1, kind: 'model',
    accountId: 'synthetic-account', runId: 'jrun_fixture', requestId: `request-${number}`, attemptNumber: number,
    registrationId: `registration-${number}`, producerKind: 'provider',
    producerIdentity: { producerKind: 'provider', providerId: 'provider', modelId: 'model', modelSnapshotRef: 'snapshot' },
    transition: 'started', operations: ['generate', 'stream'], resultRef: `result-${number}`, resultEventSeq: number * 2 - 1,
    observedAt: number * 2 + 11, providerId: 'provider', modelId: 'model', modelSnapshotRef: 'snapshot' };
  return { runId: 'jrun_fixture', seq: number * 2, idempotencyKey: `synthetic-proof-${number}`, type: 'warning',
    title: 'synthetic', safeSummary: 'synthetic', sourceRefs: [], artifactIds: [], createdAt: number * 2 + 11, liveEvidence };
}
async function fixture(typed: number, journal: number, onTerminals?: (db: JarvisDexie, run: JarvisRun) => Promise<void>) {
  const db = createJarvisDb(uniqueTestDbName('orphan-diagnostic-isolated'), TEST_INDEXED_DB); opened.push(db); await db.open();
  const run: JarvisRun = { id: 'jrun_fixture', accountId: 'synthetic-account', workspaceId: 'synthetic-workspace',
    projectId: 'synthetic-project', chatId: 'synthetic-chat', source: 'schedule', status: 'running', agentId: 'synthetic-agent',
    identityVersion: 1, profileRevisionId: 'synthetic-profile', model: { providerId: 'provider', modelId: 'model', connectionMode: 'native-api',
      capabilities: { tools: false, vision: false }, capturedAt: 1 },
    transportAttempts: Array.from({ length: typed }, (_, index) => attempt(index + 1)), createdAt: 1, updatedAt: 2 };
  // Deliberately seed contradictory rows in THIS disposable DB; no production mutation API is used.
  await db.jarvis_runs.put(toJarvisRunRow(run));
  await db.jarvis_events.bulkPut([toJarvisEventRow(resultEvent(journal)), toJarvisEventRow(proofEvent(journal))]);
  // Test-only binding surrogate; never a production-issued authority or native proof.
  const binding = { identity: { accountId: run.accountId, source: 'local' as const },
    revocationSignal: new AbortController().signal, assertCurrent() {}, dispose() {} } as JarvisKernelAccountBinding;
  const issued = new WeakSet<object>([binding]);
  const diagnostic = createRunOwnershipDiagnostic({ repositories: createJarvisRepositories(db),
    assertIssuedBinding(value) { if (!issued.has(value)) throw new Error('unissued'); },
    ports: { registry: () => ({ owners: [], pendingCancellation: false, truncated: false }),
      queue: () => [], terminals: async () => { await onTerminals?.(db, run); return []; } } });
  return { db, run, binding, diagnostic };
}
describe('actual isolated DB diagnostic attempt correlation (synthetic data only)', () => {
  it('rejects stable typed attempt2 with valid journal attempt1', async () => {
    const f = await fixture(2, 1);
    await expect(f.diagnostic.inspect(f.binding, f.run.id)).rejects.toThrow('diagnostic_current_attempt_unverified');
    expect((await f.db.jarvis_runs.get(f.run.id))?.status).toBe('running');
    expect(await f.db.jarvis_events.count()).toBe(2);
  });
  it('rejects an attempt advanced after native-read await without matching journal', async () => {
    const f = await fixture(1, 1, async (db, run) => {
      await db.jarvis_runs.put(toJarvisRunRow({ ...run, transportAttempts: [attempt(1), attempt(2)] }));
    });
    await expect(f.diagnostic.inspect(f.binding, f.run.id)).rejects.toThrow('diagnostic_current_attempt_unverified');
    expect((await f.db.jarvis_runs.get(f.run.id))?.status).toBe('running');
    expect(await f.db.jarvis_events.count()).toBe(2);
  });
  it('reports changed read when both actual attempt and journal advance during await', async () => {
    const f = await fixture(1, 1, async (db, run) => {
      await db.jarvis_runs.put(toJarvisRunRow({ ...run, transportAttempts: [attempt(1), attempt(2)] }));
      await db.jarvis_events.bulkPut([toJarvisEventRow(resultEvent(2)), toJarvisEventRow(proofEvent(2))]);
    });
    const result = await f.diagnostic.inspect(f.binding, f.run.id);
    expect(result.consistency).toBe('changed_during_read'); expect(result.settlementAuthority).toBe(false);
    expect(await f.db.jarvis_events.count()).toBe(4);
    expect((await f.db.jarvis_runs.get(f.run.id))?.status).toBe('running');
  });
  it('returns verified correlated attempt only with matching validated journal, without writes', async () => {
    const f = await fixture(1, 1); const before = await f.db.jarvis_runs.get(f.run.id);
    const result = await f.diagnostic.inspect(f.binding, f.run.id);
    expect(result.latestAttempt).toMatchObject({ requestId: 'request-1', attemptNumber: 1 });
    const proofRow = await f.db.jarvis_events.get([f.run.id, 2]);
    expect(proofRow?.live_evidence?.resultEventSeq).toBe(1);
    expect(await f.db.jarvis_events.get([f.run.id, 1])).toBeDefined();
    expect(result.consistency).toBe('non_atomic_observation'); expect(result.settlementAuthority).toBe(false);
    expect(await f.db.jarvis_runs.get(f.run.id)).toEqual(before); expect(await f.db.jarvis_events.count()).toBe(2);
  });
});

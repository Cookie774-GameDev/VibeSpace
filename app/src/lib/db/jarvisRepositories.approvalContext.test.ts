import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  JarvisApprovalV1,
  JarvisEvent,
  JarvisRun,
  JarvisRunStatus,
  JarvisTransportAttemptV1,
} from '@/lib/jarvis/contracts/execution';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createJarvisDb, type JarvisDexie } from './index';
import {
  fromJarvisApprovalRow,
  fromJarvisRunRow,
  toJarvisApprovalRow,
  toJarvisEventRow,
  toJarvisRunRow,
} from './jarvisMappers';
import {
  claimApprovedExecutionInContext,
  claimSafeAutoExecutionInContext,
  createJarvisApprovalMutationRepository,
  createPendingApprovalInContext,
  decideApprovalInContext,
} from './jarvisRepositories';
import { createKernelTurnTransactionAuthority } from './kernelTurnTransactionAuthority';

const NOW = 1_786_301_000_000;
const opened: JarvisDexie[] = [];

async function openDb(label: string): Promise<JarvisDexie> {
  const db = createJarvisDb(uniqueTestDbName(label), TEST_INDEXED_DB);
  opened.push(db);
  await db.open();
  return db;
}

function runFixture(overrides: Partial<JarvisRun> = {}): JarvisRun {
  return {
    id: 'jrun-approval-context',
    accountId: 'account-approval-context',
    workspaceId: 'workspace-approval-context',
    chatId: 'chat-approval-context',
    source: 'typed_chat',
    status: 'running',
    agentId: 'agent-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-approval-context',
    model: {
      connectionId: 'connection-approval-context',
      providerId: 'provider-approval-context',
      modelId: 'model-approval-context',
      connectionMode: 'native-api',
      capabilities: { tools: true, vision: false },
      capturedAt: NOW - 20,
    },
    createdAt: NOW - 20,
    updatedAt: NOW - 20,
    ...overrides,
  };
}

function approvalFixture(overrides: Partial<JarvisApprovalV1> = {}): JarvisApprovalV1 {
  return {
    schemaVersion: 1,
    id: 'jappr-approval-context',
    runId: 'jrun-approval-context',
    requestId: 'request-approval-context',
    attemptNumber: 1,
    actionId: 'notes.create',
    actionVersion: 1,
    capabilityId: 'capability.notes.write',
    capabilitySnapshotHash: 'capability-hash-approval-context',
    expectedEffect: 'Create one note at the registered target.',
    expiresAt: NOW + 60_000,
    params: { title: 'Approval context' },
    paramsHash: 'params-hash-approval-context',
    targetSnapshot: {
      kind: 'app_resource',
      namespace: 'notes',
      resourceId: 'approval-context',
    },
    risk: 'confirm',
    status: 'pending',
    createdAt: NOW,
    ...overrides,
  };
}

async function rows(db: JarvisDexie) {
  return {
    runs: await db.jarvis_runs.toArray(),
    events: await db.jarvis_events.toArray(),
    approvals: await db.jarvis_approvals.toArray(),
  };
}

async function appendCancellation(
  db: JarvisDexie,
  runId: string,
  seq: number,
  createdAt: number,
): Promise<void> {
  const event: JarvisEvent = {
    runId,
    seq,
    idempotencyKey: `jcancel-${runId}-${seq}`,
    type: 'run_state',
    status: 'cancellation_requested',
    title: 'Cancellation requested',
    safeSummary: 'Cancellation intent was committed.',
    sourceRefs: [],
    artifactIds: [],
    createdAt,
  };
  await db.jarvis_events.add(toJarvisEventRow(event));
}

type TerminalRunStatus = Extract<
  JarvisRunStatus,
  'partial' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
>;

function scheduledAttemptFixture(
  overrides: Partial<JarvisTransportAttemptV1> = {},
): JarvisTransportAttemptV1 {
  return {
    schemaVersion: 1,
    attemptNumber: 1,
    kind: 'initial',
    requestId: 'request-approval-context',
    state: 'provider_in_flight',
    startedEventSeq: 1,
    effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 10 },
    createdAt: NOW - 10,
    updatedAt: NOW - 10,
    ...overrides,
  };
}

async function appendTerminalTransition(
  db: JarvisDexie,
  runId: string,
  status: TerminalRunStatus,
  createdAt: number,
): Promise<void> {
  await db.transaction('rw', db.jarvis_runs, db.jarvis_events, db.jarvis_approvals, async () => {
    const row = await db.jarvis_runs.get(runId);
    if (!row) throw new Error('missing_test_run');
    const run = fromJarvisRunRow(row);
    const events = await db.jarvis_events.where('run_id').equals(runId).toArray();
    const seq = Math.max(0, ...events.map((event) => event.seq)) + 1;
    await db.jarvis_runs.put(
      toJarvisRunRow({ ...run, status, updatedAt: createdAt, completedAt: createdAt }),
    );
    await db.jarvis_events.add(
      toJarvisEventRow({
        runId,
        seq,
        idempotencyKey: `terminal-${runId}-${status}-${seq}`,
        type: 'run_state',
        status,
        title: `Run ${status}`,
        safeSummary: `The run became ${status}.`,
        sourceRefs: [],
        artifactIds: [],
        createdAt,
      }),
    );
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((db) => db.delete()));
});

describe('signal-bound approval context cores', () => {
  it('atomically creates pending truth and matches the ordinary mutation repository', async () => {
    const directDb = await openDb('approval-context-direct');
    const ordinaryDb = await openDb('approval-context-ordinary');
    const run = runFixture();
    const approval = approvalFixture();
    await Promise.all([
      directDb.jarvis_runs.add(toJarvisRunRow(run)),
      ordinaryDb.jarvis_runs.add(toJarvisRunRow(run)),
    ]);
    const authority = createKernelTurnTransactionAuthority(directDb);
    const direct = await authority.approvalTransaction(
      ['jarvis_runs', 'jarvis_events', 'jarvis_approvals'],
      new AbortController().signal,
      (context) =>
        createPendingApprovalInContext(context, {
          accountId: run.accountId,
          approval,
          expectedEventTailSeq: 0,
        }),
    );
    const ordinary = await createJarvisApprovalMutationRepository(ordinaryDb).createPending({
      accountId: run.accountId,
      approval,
      expectedEventTailSeq: 0,
    });

    expect(direct).toEqual({ kind: 'committed', value: ordinary });
    expect(ordinary).toMatchObject({
      approval: { id: approval.id, status: 'pending' },
      run: { id: run.id, status: 'awaiting_approval' },
      events: [
        { seq: 1, type: 'run_state', status: 'awaiting_approval' },
        { seq: 2, type: 'approval', status: 'pending', idempotencyKey: approval.id },
      ],
    });
    expect(await directDb.jarvis_runs.toArray()).toEqual(await ordinaryDb.jarvis_runs.toArray());
    expect(await directDb.jarvis_events.toArray()).toEqual(
      await ordinaryDb.jarvis_events.toArray(),
    );
    expect(await directDb.jarvis_approvals.toArray()).toEqual(
      await ordinaryDb.jarvis_approvals.toArray(),
    );
  });

  it('keeps approval decisions and approved execution claims in the exact three-table boundary', async () => {
    const db = await openDb('approval-context-claim');
    const run = runFixture();
    const approval = approvalFixture();
    await db.jarvis_runs.add(toJarvisRunRow(run));
    const mutations = createJarvisApprovalMutationRepository(db);

    await mutations.createPending({ accountId: run.accountId, approval, expectedEventTailSeq: 0 });
    const approved = await mutations.decide({
      accountId: run.accountId,
      runId: run.id,
      requestId: approval.requestId,
      attemptNumber: approval.attemptNumber,
      approvalId: approval.id,
      decision: 'approve',
      decidedAt: NOW + 1,
      expectedEventTailSeq: 2,
    });
    expect(approved).toMatchObject({
      approval: { status: 'approved', decidedAt: NOW + 1 },
      run: { status: 'awaiting_approval' },
      events: [{ seq: 3, type: 'approval', status: 'approved' }],
    });

    const claimed = await mutations.claimApprovedExecution({
      accountId: run.accountId,
      runId: run.id,
      requestId: approval.requestId,
      attemptNumber: approval.attemptNumber,
      approvalId: approval.id,
      producerKind: 'action',
      ownerId: 'jexec-approval-context',
      evidenceRef: 'evidence-approval-context',
      startedAt: NOW + 2,
      expectedEventTailSeq: 3,
    });

    expect(claimed).toMatchObject({
      approval: { status: 'consumed', consumedAt: NOW + 2 },
      run: { status: 'running' },
      startEvent: {
        seq: 4,
        type: 'tool',
        status: 'consequential_effect_claimed',
        executionEvidence: {
          kind: 'consequential_effect_claimed',
          requestId: approval.requestId,
          attemptNumber: 1,
          ownerKind: 'action',
          ownerId: 'jexec-approval-context',
        },
        producerSourceEvidence: {
          producerKind: 'action',
          phase: 'start',
          state: 'ready',
          resultRef: 'evidence-approval-context',
        },
      },
    });
    expect(fromJarvisRunRow((await db.jarvis_runs.get(run.id))!).status).toBe('running');
    expect(fromJarvisApprovalRow((await db.jarvis_approvals.get(approval.id))!).status).toBe(
      'consumed',
    );
    expect(await db.jarvis_events.count()).toBe(4);
  });

  it('rolls back every table when the second or third table write fails', async () => {
    for (const failedTable of ['jarvis_approvals', 'jarvis_events'] as const) {
      const db = await openDb(`approval-context-rollback-${failedTable}`);
      const run = runFixture({ id: `jrun-rollback-${failedTable}` });
      const approval = approvalFixture({
        id: `jappr-rollback-${failedTable}`,
        runId: run.id,
      });
      await db.jarvis_runs.add(toJarvisRunRow(run));
      const authority = createKernelTurnTransactionAuthority(db);
      if (failedTable === 'jarvis_approvals') {
        vi.spyOn(db.jarvis_approvals, 'add').mockRejectedValueOnce(
          new Error('injected_second_table_failure'),
        );
      } else {
        vi.spyOn(db.jarvis_events, 'bulkAdd').mockRejectedValueOnce(
          new Error('injected_third_table_failure'),
        );
      }

      await expect(
        authority.approvalTransaction(
          ['jarvis_runs', 'jarvis_events', 'jarvis_approvals'],
          new AbortController().signal,
          (context) =>
            createPendingApprovalInContext(context, {
              accountId: run.accountId,
              approval,
              expectedEventTailSeq: 0,
            }),
        ),
      ).rejects.toThrow(
        `injected_${failedTable === 'jarvis_approvals' ? 'second' : 'third'}_table_failure`,
      );

      expect(fromJarvisRunRow((await db.jarvis_runs.get(run.id))!).status).toBe('running');
      expect(await db.jarvis_events.count()).toBe(0);
      expect(await db.jarvis_approvals.count()).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it('returns exact detached committed rows on replay and rejects changed reuse without writes', async () => {
    const db = await openDb('approval-context-drift');
    const run = runFixture();
    const approval = approvalFixture();
    await db.jarvis_runs.add(toJarvisRunRow(run));
    const mutations = createJarvisApprovalMutationRepository(db);
    const createInput = { accountId: run.accountId, approval, expectedEventTailSeq: 0 };
    const created = await mutations.createPending(createInput);
    expect(await mutations.createPending(createInput)).toEqual(created);
    created.run.status = 'failed';
    created.events[0]!.title = 'mutated caller copy';
    expect(fromJarvisRunRow((await db.jarvis_runs.get(run.id))!).status).toBe('awaiting_approval');
    const afterCreate = await rows(db);

    await expect(
      mutations.createPending({
        accountId: run.accountId,
        approval: { ...approval, paramsHash: 'drifted-params-hash' },
        expectedEventTailSeq: 0,
      }),
    ).rejects.toMatchObject({ name: 'JarvisRepositoryError' });
    expect(await rows(db)).toEqual(afterCreate);

    const decideInput = {
      accountId: run.accountId,
      runId: run.id,
      requestId: approval.requestId,
      attemptNumber: 1,
      approvalId: approval.id,
      decision: 'approve' as const,
      decidedAt: NOW + 1,
      expectedEventTailSeq: 2,
    };
    const decided = await mutations.decide(decideInput);
    const decidedReplay = await mutations.decide(decideInput);
    expect(decidedReplay).toEqual(decided);
    decidedReplay.events[0]!.title = 'mutated decision replay';
    expect((await db.jarvis_events.get([run.id, 3]))!.title).toBe('Approval granted');
    const afterDecision = await rows(db);
    await expect(
      mutations.decide({
        ...decideInput,
        decidedAt: NOW + 2,
      }),
    ).rejects.toMatchObject({ name: 'JarvisRepositoryError' });
    expect(await rows(db)).toEqual(afterDecision);

    const claimInput = {
      accountId: run.accountId,
      runId: run.id,
      requestId: approval.requestId,
      attemptNumber: 1,
      approvalId: approval.id,
      producerKind: 'action' as const,
      ownerId: 'jexec-replay',
      evidenceRef: 'evidence-replay',
      startedAt: NOW + 2,
      expectedEventTailSeq: 3,
    };
    const claimed = await mutations.claimApprovedExecution(claimInput);
    const claimedReplay = await mutations.claimApprovedExecution(claimInput);
    expect(claimedReplay).toEqual(claimed);
    claimedReplay.run.status = 'failed';
    expect(fromJarvisRunRow((await db.jarvis_runs.get(run.id))!).status).toBe('running');
    const afterClaim = await rows(db);
    await expect(
      mutations.claimApprovedExecution({
        ...claimInput,
        ownerId: 'jexec-drifted',
      }),
    ).rejects.toMatchObject({ name: 'JarvisRepositoryError' });
    expect(await rows(db)).toEqual(afterClaim);
  });

  it('fails closed with no changes when cancellation intent races decision or claim', async () => {
    const decisionDb = await openDb('approval-context-cancel-decision');
    const decisionRun = runFixture({ id: 'jrun-cancel-decision' });
    const decisionApproval = approvalFixture({
      id: 'jappr-cancel-decision',
      runId: decisionRun.id,
    });
    await decisionDb.jarvis_runs.add(toJarvisRunRow(decisionRun));
    const decisionMutations = createJarvisApprovalMutationRepository(decisionDb);
    await decisionMutations.createPending({
      accountId: decisionRun.accountId,
      approval: decisionApproval,
      expectedEventTailSeq: 0,
    });
    await appendCancellation(decisionDb, decisionRun.id, 3, NOW + 1);
    const beforeDecision = await rows(decisionDb);
    await expect(
      decisionMutations.decide({
        accountId: decisionRun.accountId,
        runId: decisionRun.id,
        requestId: decisionApproval.requestId,
        attemptNumber: 1,
        approvalId: decisionApproval.id,
        decision: 'approve',
        decidedAt: NOW + 2,
        expectedEventTailSeq: 3,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(decisionDb)).toEqual(beforeDecision);

    const claimDb = await openDb('approval-context-cancel-claim');
    const claimRun = runFixture({ id: 'jrun-cancel-claim' });
    const claimApproval = approvalFixture({ id: 'jappr-cancel-claim', runId: claimRun.id });
    await claimDb.jarvis_runs.add(toJarvisRunRow(claimRun));
    const claimMutations = createJarvisApprovalMutationRepository(claimDb);
    await claimMutations.createPending({
      accountId: claimRun.accountId,
      approval: claimApproval,
      expectedEventTailSeq: 0,
    });
    await claimMutations.decide({
      accountId: claimRun.accountId,
      runId: claimRun.id,
      requestId: claimApproval.requestId,
      attemptNumber: 1,
      approvalId: claimApproval.id,
      decision: 'approve',
      decidedAt: NOW + 1,
      expectedEventTailSeq: 2,
    });
    await appendCancellation(claimDb, claimRun.id, 4, NOW + 2);
    const beforeClaim = await rows(claimDb);
    await expect(
      claimMutations.claimApprovedExecution({
        accountId: claimRun.accountId,
        runId: claimRun.id,
        requestId: claimApproval.requestId,
        attemptNumber: 1,
        approvalId: claimApproval.id,
        producerKind: 'action',
        ownerId: 'jexec-cancel-claim',
        evidenceRef: 'evidence-cancel-claim',
        startedAt: NOW + 3,
        expectedEventTailSeq: 4,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(claimDb)).toEqual(beforeClaim);

    const safeDb = await openDb('approval-context-cancel-safe');
    const safeRun = runFixture({ id: 'jrun-cancel-safe' });
    const safeApproval = approvalFixture({
      id: 'jappr-cancel-safe',
      runId: safeRun.id,
      risk: 'safe',
    });
    await safeDb.jarvis_runs.add(toJarvisRunRow(safeRun));
    await appendCancellation(safeDb, safeRun.id, 1, NOW);
    const beforeSafe = await rows(safeDb);
    await expect(
      createJarvisApprovalMutationRepository(safeDb).claimSafeAutoExecution({
        accountId: safeRun.accountId,
        approval: safeApproval,
        producerKind: 'action',
        ownerId: 'jexec-cancel-safe',
        evidenceRef: 'evidence-cancel-safe',
        startedAt: NOW + 1,
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(safeDb)).toEqual(beforeSafe);
  });

  it('rejects invalid decisions, early expiry, and backward operation times', async () => {
    const createDb = await openDb('approval-context-time-create');
    const createRun = runFixture({ id: 'jrun-time-create', updatedAt: NOW + 1 });
    const createApproval = approvalFixture({ id: 'jappr-time-create', runId: createRun.id });
    await createDb.jarvis_runs.add(toJarvisRunRow(createRun));
    await expect(
      createJarvisApprovalMutationRepository(createDb).createPending({
        accountId: createRun.accountId,
        approval: createApproval,
        expectedEventTailSeq: 0,
      }),
    ).rejects.toMatchObject({ code: 'approval_integrity_error' });
    expect(await createDb.jarvis_approvals.count()).toBe(0);

    for (const [label, decision, decidedAt] of [
      ['backward', 'approve', NOW - 1],
      ['early-expire', 'expire', NOW + 1],
      ['invalid', 'invalid', NOW + 1],
    ] as const) {
      const db = await openDb(`approval-context-time-decision-${label}`);
      const run = runFixture({ id: `jrun-time-${label}` });
      const approval = approvalFixture({ id: `jappr-time-${label}`, runId: run.id });
      await db.jarvis_runs.add(toJarvisRunRow(run));
      const mutations = createJarvisApprovalMutationRepository(db);
      await mutations.createPending({
        accountId: run.accountId,
        approval,
        expectedEventTailSeq: 0,
      });
      const before = await rows(db);
      await expect(
        mutations.decide({
          accountId: run.accountId,
          runId: run.id,
          requestId: approval.requestId,
          attemptNumber: 1,
          approvalId: approval.id,
          decision: decision as never,
          decidedAt,
          expectedEventTailSeq: 2,
        }),
      ).rejects.toMatchObject({
        code: decision === 'invalid' ? 'approval_integrity_error' : 'approval_status_conflict',
      });
      expect(await rows(db)).toEqual(before);
    }

    const claimDb = await openDb('approval-context-time-claim');
    const claimRun = runFixture({ id: 'jrun-time-claim' });
    const claimApproval = approvalFixture({ id: 'jappr-time-claim', runId: claimRun.id });
    await claimDb.jarvis_runs.add(toJarvisRunRow(claimRun));
    const claimMutations = createJarvisApprovalMutationRepository(claimDb);
    await claimMutations.createPending({
      accountId: claimRun.accountId,
      approval: claimApproval,
      expectedEventTailSeq: 0,
    });
    await claimMutations.decide({
      accountId: claimRun.accountId,
      runId: claimRun.id,
      requestId: claimApproval.requestId,
      attemptNumber: 1,
      approvalId: claimApproval.id,
      decision: 'approve',
      decidedAt: NOW + 1,
      expectedEventTailSeq: 2,
    });
    await expect(
      claimMutations.claimApprovedExecution({
        accountId: claimRun.accountId,
        runId: claimRun.id,
        requestId: claimApproval.requestId,
        attemptNumber: 1,
        approvalId: claimApproval.id,
        producerKind: 'action',
        ownerId: 'jexec-time-claim',
        evidenceRef: 'evidence-time-claim',
        startedAt: NOW,
        expectedEventTailSeq: 3,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });

    const safeDb = await openDb('approval-context-time-safe');
    const safeRun = runFixture({ id: 'jrun-time-safe' });
    const safeApproval = approvalFixture({
      id: 'jappr-time-safe',
      runId: safeRun.id,
      risk: 'safe',
    });
    await safeDb.jarvis_runs.add(toJarvisRunRow(safeRun));
    await expect(
      createJarvisApprovalMutationRepository(safeDb).claimSafeAutoExecution({
        accountId: safeRun.accountId,
        approval: safeApproval,
        producerKind: 'action',
        ownerId: 'jexec-time-safe',
        evidenceRef: 'evidence-time-safe',
        startedAt: NOW - 1,
        expectedEventTailSeq: 0,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
  });

  it('binds every operation to the exact expected event tail without writes on drift', async () => {
    const createDb = await openDb('approval-context-tail-create');
    const createRun = runFixture({ id: 'jrun-tail-create' });
    const createApproval = approvalFixture({ id: 'jappr-tail-create', runId: createRun.id });
    await createDb.jarvis_runs.add(toJarvisRunRow(createRun));
    await expect(
      createJarvisApprovalMutationRepository(createDb).createPending({
        accountId: createRun.accountId,
        approval: createApproval,
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch' });
    expect(await createDb.jarvis_events.count()).toBe(0);

    const decisionDb = await openDb('approval-context-tail-decision');
    const decisionRun = runFixture({ id: 'jrun-tail-decision' });
    const decisionApproval = approvalFixture({
      id: 'jappr-tail-decision',
      runId: decisionRun.id,
    });
    await decisionDb.jarvis_runs.add(toJarvisRunRow(decisionRun));
    const decisionMutations = createJarvisApprovalMutationRepository(decisionDb);
    await decisionMutations.createPending({
      accountId: decisionRun.accountId,
      approval: decisionApproval,
      expectedEventTailSeq: 0,
    });
    const beforeDecision = await rows(decisionDb);
    await expect(
      decisionMutations.decide({
        accountId: decisionRun.accountId,
        runId: decisionRun.id,
        requestId: decisionApproval.requestId,
        attemptNumber: 1,
        approvalId: decisionApproval.id,
        decision: 'approve',
        decidedAt: NOW + 1,
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch' });
    expect(await rows(decisionDb)).toEqual(beforeDecision);

    const claimDb = await openDb('approval-context-tail-claim');
    const claimRun = runFixture({ id: 'jrun-tail-claim' });
    const claimApproval = approvalFixture({ id: 'jappr-tail-claim', runId: claimRun.id });
    await claimDb.jarvis_runs.add(toJarvisRunRow(claimRun));
    const claimMutations = createJarvisApprovalMutationRepository(claimDb);
    await claimMutations.createPending({
      accountId: claimRun.accountId,
      approval: claimApproval,
      expectedEventTailSeq: 0,
    });
    await claimMutations.decide({
      accountId: claimRun.accountId,
      runId: claimRun.id,
      requestId: claimApproval.requestId,
      attemptNumber: 1,
      approvalId: claimApproval.id,
      decision: 'approve',
      decidedAt: NOW + 1,
      expectedEventTailSeq: 2,
    });
    const beforeClaim = await rows(claimDb);
    await expect(
      claimMutations.claimApprovedExecution({
        accountId: claimRun.accountId,
        runId: claimRun.id,
        requestId: claimApproval.requestId,
        attemptNumber: 1,
        approvalId: claimApproval.id,
        producerKind: 'action',
        ownerId: 'jexec-tail-claim',
        evidenceRef: 'evidence-tail-claim',
        startedAt: NOW + 2,
        expectedEventTailSeq: 2,
      }),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch' });
    expect(await rows(claimDb)).toEqual(beforeClaim);

    const safeDb = await openDb('approval-context-tail-safe');
    const safeRun = runFixture({ id: 'jrun-tail-safe' });
    const safeApproval = approvalFixture({
      id: 'jappr-tail-safe',
      runId: safeRun.id,
      risk: 'safe',
    });
    await safeDb.jarvis_runs.add(toJarvisRunRow(safeRun));
    await expect(
      createJarvisApprovalMutationRepository(safeDb).claimSafeAutoExecution({
        accountId: safeRun.accountId,
        approval: safeApproval,
        producerKind: 'action',
        ownerId: 'jexec-tail-safe',
        evidenceRef: 'evidence-tail-safe',
        startedAt: NOW + 1,
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch' });
    expect(await safeDb.jarvis_events.count()).toBe(0);
  });

  it('rolls back each operation when exact persisted event readback is unavailable', async () => {
    const scenarios = ['create', 'decide', 'claim', 'safe'] as const;
    for (const scenario of scenarios) {
      const db = await openDb(`approval-context-readback-${scenario}`);
      const run = runFixture({ id: `jrun-readback-${scenario}` });
      const approval = approvalFixture({
        id: `jappr-readback-${scenario}`,
        runId: run.id,
        ...(scenario === 'safe' ? { risk: 'safe' as const } : {}),
      });
      await db.jarvis_runs.add(toJarvisRunRow(run));
      const mutations = createJarvisApprovalMutationRepository(db);
      if (scenario !== 'create' && scenario !== 'safe') {
        await mutations.createPending({
          accountId: run.accountId,
          approval,
          expectedEventTailSeq: 0,
        });
      }
      if (scenario === 'claim') {
        await mutations.decide({
          accountId: run.accountId,
          runId: run.id,
          requestId: approval.requestId,
          attemptNumber: 1,
          approvalId: approval.id,
          decision: 'approve',
          decidedAt: NOW + 1,
          expectedEventTailSeq: 2,
        });
      }
      const before = await rows(db);
      vi.spyOn(db.jarvis_events, 'get').mockResolvedValue(undefined);
      const operation =
        scenario === 'create'
          ? mutations.createPending({
              accountId: run.accountId,
              approval,
              expectedEventTailSeq: 0,
            })
          : scenario === 'decide'
            ? mutations.decide({
                accountId: run.accountId,
                runId: run.id,
                requestId: approval.requestId,
                attemptNumber: 1,
                approvalId: approval.id,
                decision: 'approve',
                decidedAt: NOW + 1,
                expectedEventTailSeq: 2,
              })
            : scenario === 'claim'
              ? mutations.claimApprovedExecution({
                  accountId: run.accountId,
                  runId: run.id,
                  requestId: approval.requestId,
                  attemptNumber: 1,
                  approvalId: approval.id,
                  producerKind: 'action',
                  ownerId: 'jexec-readback-claim',
                  evidenceRef: 'evidence-readback-claim',
                  startedAt: NOW + 2,
                  expectedEventTailSeq: 3,
                })
              : mutations.claimSafeAutoExecution({
                  accountId: run.accountId,
                  approval,
                  producerKind: 'action',
                  ownerId: 'jexec-readback-safe',
                  evidenceRef: 'evidence-readback-safe',
                  startedAt: NOW + 1,
                  expectedEventTailSeq: 0,
                });
      await expect(operation).rejects.toMatchObject({ code: 'approval_integrity_error' });
      expect(await rows(db)).toEqual(before);
      vi.restoreAllMocks();
    }
  });

  it('rejects incoherent lifecycle metadata without synthesizing or overwriting timestamps', async () => {
    for (const operation of ['create', 'safe'] as const) {
      for (const field of ['decidedAt', 'consumedAt'] as const) {
        const db = await openDb(`approval-context-metadata-${operation}-${field}`);
        const run = runFixture({ id: `jrun-metadata-${operation}-${field}` });
        const approval = approvalFixture({
          id: `jappr-metadata-${operation}-${field}`,
          runId: run.id,
          ...(operation === 'safe' ? { risk: 'safe' as const } : {}),
          [field]: NOW,
        });
        await db.jarvis_runs.add(toJarvisRunRow(run));
        const before = await rows(db);
        const mutations = createJarvisApprovalMutationRepository(db);
        const result =
          operation === 'create'
            ? mutations.createPending({
                accountId: run.accountId,
                approval,
                expectedEventTailSeq: 0,
              })
            : mutations.claimSafeAutoExecution({
                accountId: run.accountId,
                approval,
                producerKind: 'action',
                ownerId: `jexec-metadata-${field}`,
                evidenceRef: `evidence-metadata-${field}`,
                startedAt: NOW + 1,
                expectedEventTailSeq: 0,
              });
        await expect(result).rejects.toMatchObject({ code: 'approval_integrity_error' });
        expect(await rows(db)).toEqual(before);
      }
    }

    for (const column of ['decided_at', 'consumed_at'] as const) {
      const db = await openDb(`approval-context-metadata-decision-${column}`);
      const run = runFixture({ id: `jrun-metadata-decision-${column}` });
      const approval = approvalFixture({
        id: `jappr-metadata-decision-${column}`,
        runId: run.id,
      });
      await db.jarvis_runs.add(toJarvisRunRow(run));
      const mutations = createJarvisApprovalMutationRepository(db);
      await mutations.createPending({
        accountId: run.accountId,
        approval,
        expectedEventTailSeq: 0,
      });
      const row = (await db.jarvis_approvals.get(approval.id))!;
      await db.jarvis_approvals.put({ ...row, [column]: NOW });
      const before = await rows(db);
      await expect(
        mutations.decide({
          accountId: run.accountId,
          runId: run.id,
          requestId: approval.requestId,
          attemptNumber: 1,
          approvalId: approval.id,
          decision: 'approve',
          decidedAt: NOW + 1,
          expectedEventTailSeq: 2,
        }),
      ).rejects.toMatchObject({ code: 'approval_status_conflict' });
      expect(await rows(db)).toEqual(before);
    }

    for (const corruption of [
      'missing-decision',
      'decision-before-created',
      'decision-after-start',
      'prior-consumption',
      'nonfinite-decision',
    ] as const) {
      const db = await openDb(`approval-context-metadata-claim-${corruption}`);
      const run = runFixture({ id: `jrun-metadata-claim-${corruption}` });
      const approval = approvalFixture({ id: `jappr-metadata-claim-${corruption}`, runId: run.id });
      await db.jarvis_runs.add(toJarvisRunRow(run));
      const mutations = createJarvisApprovalMutationRepository(db);
      await mutations.createPending({
        accountId: run.accountId,
        approval,
        expectedEventTailSeq: 0,
      });
      await mutations.decide({
        accountId: run.accountId,
        runId: run.id,
        requestId: approval.requestId,
        attemptNumber: 1,
        approvalId: approval.id,
        decision: 'approve',
        decidedAt: NOW + 1,
        expectedEventTailSeq: 2,
      });
      const row = { ...(await db.jarvis_approvals.get(approval.id))! };
      if (corruption === 'missing-decision') delete row.decided_at;
      if (corruption === 'decision-before-created') row.decided_at = NOW - 1;
      if (corruption === 'decision-after-start') row.decided_at = NOW + 3;
      if (corruption === 'prior-consumption') row.consumed_at = NOW + 1;
      if (corruption === 'nonfinite-decision') row.decided_at = Number.NaN;
      await db.jarvis_approvals.put(row);
      const before = await rows(db);
      await expect(
        mutations.claimApprovedExecution({
          accountId: run.accountId,
          runId: run.id,
          requestId: approval.requestId,
          attemptNumber: 1,
          approvalId: approval.id,
          producerKind: 'action',
          ownerId: `jexec-metadata-claim-${corruption}`,
          evidenceRef: `evidence-metadata-claim-${corruption}`,
          startedAt: NOW + 2,
          expectedEventTailSeq: 3,
        }),
      ).rejects.toThrow();
      expect(await rows(db)).toEqual(before);
    }
  });

  it('fails closed on duplicate open approvals regardless of requested row order', async () => {
    for (const requestedFirst of [true, false]) {
      const suffix = requestedFirst ? 'requested-first' : 'requested-second';

      const createDb = await openDb(`approval-context-duplicate-create-${suffix}`);
      const createRun = runFixture({ id: `jrun-duplicate-create-${suffix}` });
      const createApproval = approvalFixture({
        id: requestedFirst ? 'jappr-a-requested-create' : 'jappr-z-requested-create',
        runId: createRun.id,
      });
      await createDb.jarvis_runs.add(toJarvisRunRow(createRun));
      const createMutations = createJarvisApprovalMutationRepository(createDb);
      const createInput = {
        accountId: createRun.accountId,
        approval: createApproval,
        expectedEventTailSeq: 0,
      };
      await createMutations.createPending(createInput);
      await createDb.jarvis_approvals.add(
        toJarvisApprovalRow(
          approvalFixture({
            id: requestedFirst ? 'jappr-z-duplicate-create' : 'jappr-a-duplicate-create',
            runId: createRun.id,
            requestId: `request-duplicate-create-${suffix}`,
          }),
        ),
      );
      const beforeCreate = await rows(createDb);
      await expect(createMutations.createPending(createInput)).rejects.toMatchObject({
        code: 'approval_status_conflict',
      });
      expect(await rows(createDb)).toEqual(beforeCreate);

      const decisionDb = await openDb(`approval-context-duplicate-decision-${suffix}`);
      const decisionRun = runFixture({ id: `jrun-duplicate-decision-${suffix}` });
      const decisionApproval = approvalFixture({
        id: requestedFirst ? 'jappr-a-requested-decision' : 'jappr-z-requested-decision',
        runId: decisionRun.id,
      });
      await decisionDb.jarvis_runs.add(toJarvisRunRow(decisionRun));
      const decisionMutations = createJarvisApprovalMutationRepository(decisionDb);
      await decisionMutations.createPending({
        accountId: decisionRun.accountId,
        approval: decisionApproval,
        expectedEventTailSeq: 0,
      });
      await decisionDb.jarvis_approvals.add(
        toJarvisApprovalRow(
          approvalFixture({
            id: requestedFirst ? 'jappr-z-duplicate-decision' : 'jappr-a-duplicate-decision',
            runId: decisionRun.id,
            requestId: `request-duplicate-decision-${suffix}`,
          }),
        ),
      );
      const beforeDecision = await rows(decisionDb);
      await expect(
        decisionMutations.decide({
          accountId: decisionRun.accountId,
          runId: decisionRun.id,
          requestId: decisionApproval.requestId,
          attemptNumber: 1,
          approvalId: decisionApproval.id,
          decision: 'approve',
          decidedAt: NOW + 1,
          expectedEventTailSeq: 2,
        }),
      ).rejects.toMatchObject({ code: 'approval_status_conflict' });
      expect(await rows(decisionDb)).toEqual(beforeDecision);

      const claimDb = await openDb(`approval-context-duplicate-claim-${suffix}`);
      const claimRun = runFixture({ id: `jrun-duplicate-claim-${suffix}` });
      const claimApproval = approvalFixture({
        id: requestedFirst ? 'jappr-a-requested-claim' : 'jappr-z-requested-claim',
        runId: claimRun.id,
      });
      await claimDb.jarvis_runs.add(toJarvisRunRow(claimRun));
      const claimMutations = createJarvisApprovalMutationRepository(claimDb);
      await claimMutations.createPending({
        accountId: claimRun.accountId,
        approval: claimApproval,
        expectedEventTailSeq: 0,
      });
      await claimMutations.decide({
        accountId: claimRun.accountId,
        runId: claimRun.id,
        requestId: claimApproval.requestId,
        attemptNumber: 1,
        approvalId: claimApproval.id,
        decision: 'approve',
        decidedAt: NOW + 1,
        expectedEventTailSeq: 2,
      });
      await claimDb.jarvis_approvals.add(
        toJarvisApprovalRow(
          approvalFixture({
            id: requestedFirst ? 'jappr-z-duplicate-claim' : 'jappr-a-duplicate-claim',
            runId: claimRun.id,
            requestId: `request-duplicate-claim-${suffix}`,
          }),
        ),
      );
      const beforeClaim = await rows(claimDb);
      await expect(
        claimMutations.claimApprovedExecution({
          accountId: claimRun.accountId,
          runId: claimRun.id,
          requestId: claimApproval.requestId,
          attemptNumber: 1,
          approvalId: claimApproval.id,
          producerKind: 'action',
          ownerId: `jexec-duplicate-claim-${suffix}`,
          evidenceRef: `evidence-duplicate-claim-${suffix}`,
          startedAt: NOW + 2,
          expectedEventTailSeq: 3,
        }),
      ).rejects.toMatchObject({ code: 'approval_status_conflict' });
      expect(await rows(claimDb)).toEqual(beforeClaim);
    }

    const freshDb = await openDb('approval-context-duplicate-fresh-create');
    const freshRun = runFixture({ id: 'jrun-duplicate-fresh-create' });
    await freshDb.jarvis_runs.add(toJarvisRunRow(freshRun));
    await freshDb.jarvis_approvals.add(
      toJarvisApprovalRow(
        approvalFixture({
          id: 'jappr-existing-open',
          runId: freshRun.id,
          requestId: 'request-existing-open',
        }),
      ),
    );
    const beforeFresh = await rows(freshDb);
    await expect(
      createJarvisApprovalMutationRepository(freshDb).createPending({
        accountId: freshRun.accountId,
        approval: approvalFixture({ id: 'jappr-new-open', runId: freshRun.id }),
        expectedEventTailSeq: 0,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(freshDb)).toEqual(beforeFresh);

    const safeDb = await openDb('approval-context-duplicate-safe-auto');
    const safeRun = runFixture({ id: 'jrun-duplicate-safe-auto' });
    await safeDb.jarvis_runs.add(toJarvisRunRow(safeRun));
    await safeDb.jarvis_approvals.add(
      toJarvisApprovalRow(
        approvalFixture({
          id: 'jappr-safe-existing-open',
          runId: safeRun.id,
          requestId: 'request-safe-existing-open',
        }),
      ),
    );
    const beforeSafe = await rows(safeDb);
    await expect(
      createJarvisApprovalMutationRepository(safeDb).claimSafeAutoExecution({
        accountId: safeRun.accountId,
        approval: approvalFixture({
          id: 'jappr-safe-new-claim',
          runId: safeRun.id,
          risk: 'safe',
        }),
        producerKind: 'action',
        ownerId: 'jexec-duplicate-safe',
        evidenceRef: 'evidence-duplicate-safe',
        startedAt: NOW + 1,
        expectedEventTailSeq: 0,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(safeDb)).toEqual(beforeSafe);
  });

  const operations = ['create', 'decide', 'claim', 'safe'] as const;
  const blockers = [
    'cancellation',
    'partial',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
  ] as const;

  it.each(operations.flatMap((operation) => blockers.map((blocker) => ({ operation, blocker }))))(
    'serializes $operation against $blocker in both commit orders',
    async ({ operation, blocker }) => {
      async function prepare(
        db: JarvisDexie,
        operation: (typeof operations)[number],
        suffix: string,
      ) {
        const run = runFixture({ id: `jrun-race-${operation}-${suffix}` });
        const approval = approvalFixture({
          id: `jappr-race-${operation}-${suffix}`,
          runId: run.id,
          createdAt: operation === 'create' ? NOW + 20 : NOW,
          expiresAt: NOW + 60_000,
          ...(operation === 'safe' ? { risk: 'safe' as const } : {}),
        });
        await db.jarvis_runs.add(toJarvisRunRow(run));
        const mutations = createJarvisApprovalMutationRepository(db);
        if (operation === 'decide' || operation === 'claim') {
          await mutations.createPending({
            accountId: run.accountId,
            approval,
            expectedEventTailSeq: 0,
          });
        }
        if (operation === 'claim') {
          await mutations.decide({
            accountId: run.accountId,
            runId: run.id,
            requestId: approval.requestId,
            attemptNumber: 1,
            approvalId: approval.id,
            decision: 'approve',
            decidedAt: NOW + 1,
            expectedEventTailSeq: 2,
          });
        }
        const baseTail = operation === 'claim' ? 3 : operation === 'decide' ? 2 : 0;
        const execute = (expectedEventTailSeq: number): Promise<unknown> => {
          if (operation === 'create') {
            return mutations.createPending({
              accountId: run.accountId,
              approval,
              expectedEventTailSeq,
            });
          }
          if (operation === 'decide') {
            return mutations.decide({
              accountId: run.accountId,
              runId: run.id,
              requestId: approval.requestId,
              attemptNumber: 1,
              approvalId: approval.id,
              decision: 'approve',
              decidedAt: NOW + 20,
              expectedEventTailSeq,
            });
          }
          if (operation === 'claim') {
            return mutations.claimApprovedExecution({
              accountId: run.accountId,
              runId: run.id,
              requestId: approval.requestId,
              attemptNumber: 1,
              approvalId: approval.id,
              producerKind: 'action',
              ownerId: `jexec-race-${suffix}`,
              evidenceRef: `evidence-race-${suffix}`,
              startedAt: NOW + 20,
              expectedEventTailSeq,
            });
          }
          return mutations.claimSafeAutoExecution({
            accountId: run.accountId,
            approval,
            producerKind: 'action',
            ownerId: `jexec-race-${suffix}`,
            evidenceRef: `evidence-race-${suffix}`,
            startedAt: NOW + 20,
            expectedEventTailSeq,
          });
        };
        return { approval, baseTail, execute, run };
      }

      const operationFirstDb = await openDb(`approval-context-race-${operation}-${blocker}-op`);
      const operationFirst = await prepare(operationFirstDb, operation, `${blocker}-op`);
      await operationFirst.execute(operationFirst.baseTail);
      const afterOperation = await rows(operationFirstDb);
      expect(afterOperation.approvals).toHaveLength(1);
      if (blocker === 'cancellation') {
        await appendCancellation(
          operationFirstDb,
          operationFirst.run.id,
          operationFirst.baseTail + (operation === 'create' ? 3 : 2),
          NOW + 30,
        );
      } else {
        await appendTerminalTransition(operationFirstDb, operationFirst.run.id, blocker, NOW + 30);
      }
      const afterBlocker = await rows(operationFirstDb);
      expect(afterBlocker.approvals).toEqual(afterOperation.approvals);
      expect(afterBlocker.events.slice(0, afterOperation.events.length)).toEqual(
        afterOperation.events,
      );
      expect(afterBlocker.events).toHaveLength(afterOperation.events.length + 1);
      if (blocker === 'cancellation') {
        expect(afterBlocker.runs).toEqual(afterOperation.runs);
      } else {
        expect(fromJarvisRunRow(afterBlocker.runs[0]!).status).toBe(blocker);
      }

      const blockerFirstDb = await openDb(`approval-context-race-${operation}-${blocker}-blocker`);
      const blockerFirst = await prepare(blockerFirstDb, operation, `${blocker}-blocker`);
      if (blocker === 'cancellation') {
        await appendCancellation(
          blockerFirstDb,
          blockerFirst.run.id,
          blockerFirst.baseTail + 1,
          NOW + 10,
        );
      } else {
        await appendTerminalTransition(blockerFirstDb, blockerFirst.run.id, blocker, NOW + 10);
      }
      const afterFirstBlocker = await rows(blockerFirstDb);
      await expect(blockerFirst.execute(blockerFirst.baseTail + 1)).rejects.toMatchObject({
        code: 'approval_status_conflict',
      });
      expect(await rows(blockerFirstDb)).toEqual(afterFirstBlocker);
    },
  );

  it('binds scheduled approvals to the latest open attempt and advances only the required barrier versions', async () => {
    async function seedScheduledRun(db: JarvisDexie, run: JarvisRun): Promise<void> {
      await db.jarvis_runs.add(toJarvisRunRow(run));
      await db.jarvis_events.add(
        toJarvisEventRow({
          runId: run.id,
          seq: 1,
          idempotencyKey: `scheduled-start-${run.id}`,
          type: 'run_state',
          status: 'running',
          title: 'Scheduled attempt started',
          safeSummary: 'The scheduled attempt started.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: NOW - 10,
        }),
      );
    }

    const claimDb = await openDb('approval-context-scheduled-claim');
    const claimRun = runFixture({
      id: 'jrun-scheduled-claim',
      source: 'schedule',
      updatedAt: NOW - 10,
      transportAttempts: [scheduledAttemptFixture()],
    });
    const claimApproval = approvalFixture({ id: 'jappr-scheduled-claim', runId: claimRun.id });
    await seedScheduledRun(claimDb, claimRun);
    const claimMutations = createJarvisApprovalMutationRepository(claimDb);
    const created = await claimMutations.createPending({
      accountId: claimRun.accountId,
      approval: claimApproval,
      expectedEventTailSeq: 1,
    });
    expect(created.run.transportAttempts?.at(-1)?.effectBarrier).toMatchObject({
      state: 'dirty',
      version: 1,
    });
    const approved = await claimMutations.decide({
      accountId: claimRun.accountId,
      runId: claimRun.id,
      requestId: claimApproval.requestId,
      attemptNumber: 1,
      approvalId: claimApproval.id,
      decision: 'approve',
      decidedAt: NOW + 1,
      expectedEventTailSeq: 3,
    });
    expect(approved.run.transportAttempts?.at(-1)?.effectBarrier.version).toBe(1);
    const claimed = await claimMutations.claimApprovedExecution({
      accountId: claimRun.accountId,
      runId: claimRun.id,
      requestId: claimApproval.requestId,
      attemptNumber: 1,
      approvalId: claimApproval.id,
      producerKind: 'action',
      ownerId: 'jexec-scheduled-claim',
      evidenceRef: 'evidence-scheduled-claim',
      startedAt: NOW + 2,
      expectedEventTailSeq: 4,
    });
    expect(claimed.run.transportAttempts?.at(-1)?.effectBarrier).toMatchObject({
      state: 'dirty',
      version: 2,
    });

    const safeDb = await openDb('approval-context-scheduled-safe');
    const safeRun = runFixture({
      id: 'jrun-scheduled-safe',
      source: 'schedule',
      updatedAt: NOW - 10,
      transportAttempts: [scheduledAttemptFixture()],
    });
    const safeApproval = approvalFixture({
      id: 'jappr-scheduled-safe',
      runId: safeRun.id,
      risk: 'safe',
    });
    await seedScheduledRun(safeDb, safeRun);
    const safe = await createJarvisApprovalMutationRepository(safeDb).claimSafeAutoExecution({
      accountId: safeRun.accountId,
      approval: safeApproval,
      producerKind: 'action',
      ownerId: 'jexec-scheduled-safe',
      evidenceRef: 'evidence-scheduled-safe',
      startedAt: NOW + 1,
      expectedEventTailSeq: 1,
    });
    expect(safe.run.transportAttempts?.at(-1)?.effectBarrier).toMatchObject({
      state: 'dirty',
      version: 1,
    });

    const staleDb = await openDb('approval-context-scheduled-stale');
    const staleRun = runFixture({
      id: 'jrun-scheduled-stale',
      source: 'schedule',
      updatedAt: NOW - 10,
      transportAttempts: [
        scheduledAttemptFixture({
          requestId: 'request-newer-attempt',
        }),
      ],
    });
    await seedScheduledRun(staleDb, staleRun);
    const beforeStale = await rows(staleDb);
    await expect(
      createJarvisApprovalMutationRepository(staleDb).createPending({
        accountId: staleRun.accountId,
        approval: approvalFixture({ id: 'jappr-scheduled-stale', runId: staleRun.id }),
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch' });
    expect(await rows(staleDb)).toEqual(beforeStale);

    const sealedDb = await openDb('approval-context-scheduled-sealed');
    const sealedRun = runFixture({
      id: 'jrun-scheduled-sealed',
      source: 'schedule',
      updatedAt: NOW - 10,
      transportAttempts: [
        scheduledAttemptFixture({
          effectBarrier: { state: 'sealed_for_retry', version: 0, updatedAt: NOW - 9 },
        }),
      ],
    });
    await seedScheduledRun(sealedDb, sealedRun);
    const beforeSealed = await rows(sealedDb);
    await expect(
      createJarvisApprovalMutationRepository(sealedDb).claimSafeAutoExecution({
        accountId: sealedRun.accountId,
        approval: approvalFixture({
          id: 'jappr-scheduled-sealed',
          runId: sealedRun.id,
          risk: 'safe',
        }),
        producerKind: 'action',
        ownerId: 'jexec-scheduled-sealed',
        evidenceRef: 'evidence-scheduled-sealed',
        startedAt: NOW + 1,
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(sealedDb)).toEqual(beforeSealed);

    const sealedClaimDb = await openDb('approval-context-scheduled-sealed-claim');
    const sealedClaimRun = runFixture({
      id: 'jrun-scheduled-sealed-claim',
      source: 'schedule',
      status: 'awaiting_approval',
      updatedAt: NOW + 1,
      transportAttempts: [
        scheduledAttemptFixture({
          effectBarrier: { state: 'sealed_for_retry', version: 0, updatedAt: NOW + 1 },
          updatedAt: NOW + 1,
        }),
      ],
    });
    const sealedClaimApproval = approvalFixture({
      id: 'jappr-scheduled-sealed-claim',
      runId: sealedClaimRun.id,
      status: 'approved',
      decidedAt: NOW + 1,
    });
    await seedScheduledRun(sealedClaimDb, sealedClaimRun);
    await sealedClaimDb.jarvis_approvals.add(toJarvisApprovalRow(sealedClaimApproval));
    const beforeSealedClaim = await rows(sealedClaimDb);
    await expect(
      createJarvisApprovalMutationRepository(sealedClaimDb).claimApprovedExecution({
        accountId: sealedClaimRun.accountId,
        runId: sealedClaimRun.id,
        requestId: sealedClaimApproval.requestId,
        attemptNumber: 1,
        approvalId: sealedClaimApproval.id,
        producerKind: 'action',
        ownerId: 'jexec-scheduled-sealed-claim',
        evidenceRef: 'evidence-scheduled-sealed-claim',
        startedAt: NOW + 2,
        expectedEventTailSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await rows(sealedClaimDb)).toEqual(beforeSealedClaim);
  });

  it('supports denial and expiry decisions by resuming the parent run atomically', async () => {
    for (const decision of ['deny', 'expire'] as const) {
      const db = await openDb(`approval-context-${decision}`);
      const run = runFixture({ id: `jrun-${decision}` });
      const approval = approvalFixture({ id: `jappr-${decision}`, runId: run.id });
      await db.jarvis_runs.add(toJarvisRunRow(run));
      const authority = createKernelTurnTransactionAuthority(db);
      await authority.approvalTransaction(
        ['jarvis_runs', 'jarvis_events', 'jarvis_approvals'],
        new AbortController().signal,
        (context) =>
          createPendingApprovalInContext(context, {
            accountId: run.accountId,
            approval,
            expectedEventTailSeq: 0,
          }),
      );
      const result = await authority.approvalTransaction(
        ['jarvis_runs', 'jarvis_events', 'jarvis_approvals'],
        new AbortController().signal,
        (context) =>
          decideApprovalInContext(context, {
            accountId: run.accountId,
            runId: run.id,
            requestId: approval.requestId,
            attemptNumber: 1,
            approvalId: approval.id,
            decision,
            decidedAt: decision === 'expire' ? approval.expiresAt : NOW + 1,
            expectedEventTailSeq: 2,
          }),
      );

      expect(result).toMatchObject({
        kind: 'committed',
        value: {
          approval: { status: decision === 'deny' ? 'denied' : 'expired' },
          run: { status: 'running' },
          events: [
            { type: 'approval', status: decision === 'deny' ? 'denied' : 'expired' },
            { type: 'run_state', status: 'running' },
          ],
        },
      });
    }
  });

  it('atomically records a consumed safe-auto audit and claim while the run stays running', async () => {
    const db = await openDb('approval-context-safe-auto');
    const run = runFixture();
    const approval = approvalFixture({
      id: 'jappr-safe-auto',
      risk: 'safe',
      status: 'pending',
    });
    await db.jarvis_runs.add(toJarvisRunRow(run));
    const authority = createKernelTurnTransactionAuthority(db);

    await expect(
      authority.approvalTransaction(
        ['jarvis_runs', 'jarvis_events', 'jarvis_approvals'],
        new AbortController().signal,
        (context) =>
          claimSafeAutoExecutionInContext(context, {
            accountId: run.accountId,
            approval: { ...approval, expiresAt: NOW },
            producerKind: 'action',
            ownerId: 'jexec-safe-auto-expired',
            evidenceRef: 'evidence-safe-auto-expired',
            startedAt: NOW + 1,
            expectedEventTailSeq: 0,
          }),
      ),
    ).rejects.toMatchObject({ code: 'approval_status_conflict' });
    expect(await db.jarvis_approvals.count()).toBe(0);
    expect(await db.jarvis_events.count()).toBe(0);

    const safeInput = {
      accountId: run.accountId,
      approval,
      producerKind: 'action' as const,
      ownerId: 'jexec-safe-auto',
      evidenceRef: 'evidence-safe-auto',
      startedAt: NOW + 1,
      expectedEventTailSeq: 0,
    };
    const mutations = createJarvisApprovalMutationRepository(db);
    const result = await mutations.claimSafeAutoExecution(safeInput);

    expect(result).toMatchObject({
      approval: {
        id: approval.id,
        status: 'consumed',
        decidedAt: NOW + 1,
        consumedAt: NOW + 1,
      },
      run: { id: run.id, status: 'running' },
      startEvent: {
        seq: 1,
        status: 'consequential_effect_claimed',
        producerSourceEvidence: { phase: 'start', state: 'ready' },
      },
    });
    const safeReplay = await mutations.claimSafeAutoExecution(safeInput);
    expect(safeReplay).toEqual(result);
    safeReplay.startEvent.title = 'mutated safe replay';
    expect((await db.jarvis_events.get([run.id, 1]))!.title).toBe(
      'Approved action execution claimed',
    );
    const committed = await rows(db);
    await expect(
      mutations.claimSafeAutoExecution({ ...safeInput, evidenceRef: 'evidence-safe-drifted' }),
    ).rejects.toMatchObject({ name: 'JarvisRepositoryError' });
    expect(await rows(db)).toEqual(committed);
    expect(await db.jarvis_approvals.count()).toBe(1);
    expect(await db.jarvis_events.count()).toBe(1);
  });
});

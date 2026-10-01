import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  authorizeCanonicalTerminalSpawn,
  attachTerminalExecution,
  bindLegacyTerminalExecutionOwner,
  claimTerminalExecution as claimTerminalExecutionWithScope,
  createCanonicalTerminalEvidenceAuthority,
  createJarvisTerminalExecutionAcceptor,
  failTerminalExecutionBeforeNativeExit,
  markTerminalExecution,
  observeTerminalExecutionNativeExit,
  readTerminalProcessIdentity,
  requestTerminalExecutionCancellation,
  revokeTerminalExecutionsForAccount,
  settleTerminalExecutionFromNativeExit,
  terminalCancellationDisposition,
  terminalExecutionCancellationToken,
  type NativeTerminalExitPayload,
  useTerminalExecutionStore,
} from './terminalExecutionStore';
import {
  claimTerminalCommands,
  jarvisTerminalCommandQueueAuthority,
  readTerminalCommandQueueDurableStateForTests,
  resetTerminalCommandQueueDurabilityForTests,
  useTerminalCommandQueue,
} from './terminalCommandQueue';
import type {
  JarvisAbortRegistration,
  JarvisAbortRegistrationAuthority,
} from '@/lib/jarvis/contracts/execution';
import type { JarvisTerminalOwnedExecution } from '@/lib/jarvis/approvalEngine';
import type { JarvisQueuedCancellationTransitionAuthority } from '@/lib/jarvis/executionJournal/abortRegistry';
import type { CanonicalTerminalEvidence } from '@/lib/jarvis/artifactProducerAdapters';

const notificationMocks = vi.hoisted(() => ({
  notifyDone: vi.fn(),
}));

vi.mock('@/lib/notifications', () => ({
  notifyDone: notificationMocks.notifyDone,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const exactClaimScope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
} as const;

function claimTerminalExecution(
  executionId: string,
  scope: Readonly<{ accountId: string; workspaceId: string; projectId: string }> = exactClaimScope,
) {
  return claimTerminalExecutionWithScope(executionId, scope);
}

describe('terminal execution lifecycle', () => {
  const processAttachment = {
    accountId: 'account-a',
    projectId: 'project-a',
    paneId: 'pane-a',
    sessionId: 'pty_1',
    processInstanceId: 'process-instance-1',
    pid: 4242,
    processStartedAt: 1_723_456_789_000,
    runtimeGeneration: 'runtime-generation-1',
  } as const;
  const canonicalAttachment = (sessionId = 'pty_1') => ({
    ...processAttachment,
    sessionId,
    processInstanceId: `process-${sessionId}`,
  });
  const nativeExit = (
    overrides: Partial<{
      sessionId: string;
      processInstanceId: string;
      pid: number;
      processStartedAt: number;
      runtimeGeneration: string;
      code: number | null;
      reason: 'natural_exit' | 'accepted_cancellation' | 'manual_termination';
      cancellationToken: string;
    }> = {},
  ) => ({
    ...canonicalAttachment(overrides.sessionId),
    code: 0,
    reason: 'natural_exit' as const,
    ...overrides,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    notificationMocks.notifyDone.mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValue(undefined);
    useTerminalExecutionStore.getState().clear();
    resetTerminalCommandQueueDurabilityForTests();
  });

  it('tracks real process lifecycle states', () => {
    markTerminalExecution('exec_1', 'queued');
    markTerminalExecution('exec_1', 'starting');
    markTerminalExecution('exec_1', 'running', { sessionId: 'pty_1' });
    expect(useTerminalExecutionStore.getState().executions.exec_1).toMatchObject({
      status: 'running',
      sessionId: 'pty_1',
    });
    markTerminalExecution('exec_1', 'complete', { exitCode: 0 });
    expect(useTerminalExecutionStore.getState().executions.exec_1).toMatchObject({
      status: 'complete',
      exitCode: 0,
    });
    markTerminalExecution('exec_2', 'failed', { exitCode: 1 });
    markTerminalExecution('exec_3', 'cancelled', { exitCode: null });
    expect(useTerminalExecutionStore.getState().executions.exec_2.status).toBe('failed');
    expect(useTerminalExecutionStore.getState().executions.exec_3.status).toBe('cancelled');
  });

  it('bounds retained metadata', () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    for (let index = 0; index < 140; index += 1) markTerminalExecution(`exec_${index}`, 'queued');
    expect(Object.keys(useTerminalExecutionStore.getState().executions)).toHaveLength(100);
  });

  it('kills a running PTY only when an explicit timeout expires', async () => {
    vi.useFakeTimers();
    markTerminalExecution('exec_timeout', 'queued', { timeoutMs: 1_000 });
    markTerminalExecution('exec_timeout', 'running', { sessionId: 'pty_timeout' });

    await vi.advanceTimersByTimeAsync(999);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(invoke).toHaveBeenCalledWith('terminal_kill', { sessionId: 'pty_timeout' });
    expect(useTerminalExecutionStore.getState().executions.exec_timeout).toMatchObject({
      status: 'failed',
      timedOut: true,
    });
    vi.useRealTimers();
  });

  it('does not impose a timeout on long-running commands by default', async () => {
    vi.useFakeTimers();
    markTerminalExecution('exec_server', 'running', { sessionId: 'pty_server' });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(invoke).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.exec_server.status).toBe('running');
    vi.useRealTimers();
  });

  it('kills a PTY that attaches after its drained command was cancelled', async () => {
    markTerminalExecution('exec_race', 'starting');
    markTerminalExecution('exec_race', 'cancelled');

    const attached = await attachTerminalExecution('exec_race', 'pty_race');

    expect(attached).toBe(false);
    expect(invoke).toHaveBeenCalledWith('terminal_kill', { sessionId: 'pty_race' });
    expect(useTerminalExecutionStore.getState().executions.exec_race.status).toBe('cancelled');
  });

  it('stays starting until startup input has been accepted by the PTY backend', async () => {
    markTerminalExecution('exec_start', 'starting');

    const attached = await attachTerminalExecution('exec_start', 'pty_start');

    expect(attached).toBe(true);
    expect(useTerminalExecutionStore.getState().executions.exec_start).toMatchObject({
      status: 'starting',
      sessionId: 'pty_start',
    });
    markTerminalExecution('exec_start', 'running');
    expect(useTerminalExecutionStore.getState().executions.exec_start.status).toBe('running');
  });

  it('atomically binds an owned legacy execution to its authoritative native process attachment', async () => {
    markTerminalExecution('exec_legacy', 'queued', {
      accountId: 'account-a',
      runId: 'run-a',
    });

    await expect(attachTerminalExecution('exec_legacy', processAttachment)).resolves.toBe(true);
    markTerminalExecution('exec_legacy', 'running');

    expect(useTerminalExecutionStore.getState().executions.exec_legacy).toMatchObject({
      status: 'running',
      accountId: 'account-a',
      runId: 'run-a',
      sessionId: 'pty_1',
      processIdentity: {
        accountId: 'account-a',
        projectId: 'project-a',
        runId: 'run-a',
        executionId: 'exec_legacy',
        paneId: 'pane-a',
        sessionId: 'pty_1',
        processInstanceId: 'process-instance-1',
        pid: 4242,
        processStartedAt: 1_723_456_789_000,
        runtimeGeneration: 'runtime-generation-1',
      },
    });

    await expect(
      attachTerminalExecution('exec_legacy', {
        ...processAttachment,
        processInstanceId: 'replacement-process',
      }),
    ).resolves.toBe(false);
    markTerminalExecution('exec_duplicate', 'queued', {
      accountId: 'account-a',
      runId: 'run-duplicate',
    });
    await expect(attachTerminalExecution('exec_duplicate', processAttachment)).resolves.toBe(false);
    markTerminalExecution('exec_foreign', 'queued', {
      accountId: 'account-b',
      runId: 'run-b',
    });
    await expect(attachTerminalExecution('exec_foreign', processAttachment)).resolves.toBe(false);
  });

  it('holds an attach-before-owner binding inert until the exact legacy owner is published', async () => {
    markTerminalExecution('exec_pending_owner', 'queued');

    await expect(attachTerminalExecution('exec_pending_owner', processAttachment)).resolves.toBe(
      true,
    );
    expect(
      useTerminalExecutionStore.getState().executions.exec_pending_owner?.processIdentity,
    ).toBeUndefined();

    expect(bindLegacyTerminalExecutionOwner('exec_pending_owner', 'account-a', 'run-a')).toBe(true);

    expect(useTerminalExecutionStore.getState().executions.exec_pending_owner).toMatchObject({
      accountId: 'account-a',
      runId: 'run-a',
      sessionId: 'pty_1',
      processIdentity: {
        accountId: 'account-a',
        projectId: 'project-a',
        runId: 'run-a',
        executionId: 'exec_pending_owner',
        paneId: 'pane-a',
        sessionId: 'pty_1',
        processInstanceId: 'process-instance-1',
      },
    });

    markTerminalExecution('exec_pending_foreign', 'queued');
    await expect(attachTerminalExecution('exec_pending_foreign', processAttachment)).resolves.toBe(
      true,
    );
    expect(bindLegacyTerminalExecutionOwner('exec_pending_foreign', 'account-b', 'run-b')).toBe(
      false,
    );
    expect(useTerminalExecutionStore.getState().executions.exec_pending_foreign).toMatchObject({
      status: 'failed',
    });
    expect(
      useTerminalExecutionStore.getState().executions.exec_pending_foreign?.processIdentity,
    ).toBeUndefined();

    markTerminalExecution('exec_pending_conflict', 'queued');
    await expect(attachTerminalExecution('exec_pending_conflict', processAttachment)).resolves.toBe(
      true,
    );
    await expect(
      attachTerminalExecution('exec_pending_conflict', {
        ...processAttachment,
        processInstanceId: 'replacement-process',
      }),
    ).resolves.toBe(false);

    markTerminalExecution('exec_pending_settled', 'queued');
    await expect(attachTerminalExecution('exec_pending_settled', processAttachment)).resolves.toBe(
      true,
    );
    markTerminalExecution('exec_pending_settled', 'complete', { exitCode: 0 });
    expect(bindLegacyTerminalExecutionOwner('exec_pending_settled', 'account-a', 'run-a')).toBe(
      false,
    );
    await expect(attachTerminalExecution('exec_pending_settled', processAttachment)).resolves.toBe(
      false,
    );
  });

  it('does not let a late startup result overwrite cancellation', () => {
    markTerminalExecution('exec_cancelled', 'starting');
    markTerminalExecution('exec_cancelled', 'cancelled');

    markTerminalExecution('exec_cancelled', 'running', { sessionId: 'pty_late' });
    markTerminalExecution('exec_cancelled', 'failed', { exitCode: 1 });

    expect(useTerminalExecutionStore.getState().executions.exec_cancelled).toMatchObject({
      status: 'cancelled',
    });
  });

  function canonicalHarness(
    request: {
      timeoutMs?: number;
      accountId?: string;
      runId?: string;
      executionId?: `jterm_${string}`;
      cancellationToken?: string;
    } = {},
  ) {
    const accountId = request.accountId ?? 'account-a';
    const runId = request.runId ?? 'jrun_1';
    const executionId = request.executionId ?? 'jterm_1';
    const registrations = new Map<string, JarvisAbortRegistration>();
    const registrationAuthority: JarvisAbortRegistrationAuthority = {
      registerIssuedOwner: vi.fn((registration) => {
        registrations.set(registration.registrationId, registration);
        return () => {
          if (registrations.get(registration.registrationId) === registration) {
            registrations.delete(registration.registrationId);
          }
        };
      }),
    };
    const recordResult = vi.fn<JarvisTerminalOwnedExecution['recordResult']>(async () => ({
      kind: 'committed' as const,
      value: {} as never,
    }));
    const recordCancellationVerified = vi.fn<
      JarvisTerminalOwnedExecution['recordCancellationVerified']
    >(async () => ({ kind: 'committed' as const, value: {} as never }));
    const requestCancellation = vi.fn<JarvisTerminalOwnedExecution['requestCancellation']>(
      async () => ({
        kind: 'intent_committed' as const,
        requestState: 'new' as const,
        authorityState: 'current' as const,
        cancellationRequestId: 'jcancel_1',
        aggregate: { kind: 'signal_delivered' as const, ownerIds: [`terminal:${executionId}`] },
      }),
    );
    const execution: JarvisTerminalOwnedExecution = {
      recordResult,
      recordCancellationVerified,
      requestCancellation,
      dispose: vi.fn(),
    };
    const transitionQueuedRunToCancelled = vi.fn<
      JarvisQueuedCancellationTransitionAuthority['transitionQueuedRunToCancelled']
    >(async () => ({ applied: true as const }));
    const acceptor = createJarvisTerminalExecutionAcceptor({
      request: {
        accountId,
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        runId,
        executionId,
        cancellationToken: request.cancellationToken ?? 'jcancel_native_1',
        command: 'powershell',
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      },
      registrationAuthority,
      queuedTransitionAuthority: { transitionQueuedRunToCancelled },
    });
    const receipt = acceptor.acceptIssuedExecution({
      executionId,
      ownerId: 'approval:jappr_1',
      execution,
    });
    return {
      registrations,
      registrationAuthority,
      transitionQueuedRunToCancelled,
      execution,
      recordResult,
      recordCancellationVerified,
      requestCancellation,
      receipt,
    };
  }

  it('accepts only the exact transferred controller and registers the queue owner before visibility', () => {
    const harness = canonicalHarness();

    expect(harness.receipt).toMatchObject({
      executionId: 'jterm_1',
      ownerId: 'approval:jappr_1',
    });
    expect(harness.registrationAuthority.registerIssuedOwner).toHaveBeenCalledOnce();
    expect(useTerminalExecutionStore.getState().executions.jterm_1).toMatchObject({
      status: 'queued',
      runId: 'jrun_1',
    });
    expect(Object.values(useTerminalExecutionStore.getState().executions)[0]).not.toHaveProperty(
      'execution',
    );
  });

  it('revalidates exact account workspace and project after claim before native spawn', async () => {
    canonicalHarness();
    await expect(
      claimTerminalExecution('jterm_1', {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      }),
    ).resolves.toBe(true);

    expect(
      authorizeCanonicalTerminalSpawn('jterm_1', {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      }),
    ).toBe('jcancel_native_1');
    expect(
      authorizeCanonicalTerminalSpawn('jterm_1', {
        accountId: 'account-a',
        workspaceId: 'workspace-b',
        projectId: 'project-a',
      }),
    ).toBeUndefined();
    expect(
      authorizeCanonicalTerminalSpawn('jterm_1', {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-b',
      }),
    ).toBeUndefined();
  });

  it('leaves a scoped canonical command queued when the active account or project changed', async () => {
    canonicalHarness();

    await expect(
      claimTerminalCommands(({ canonical }) =>
        claimTerminalExecution(canonical.executionId, {
          accountId: 'account-b',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
        }),
      ),
    ).resolves.toEqual([]);
    expect(useTerminalCommandQueue.getState().queue.map((item) => item.id)).toEqual(['jterm_1']);
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('queued');

    await expect(
      claimTerminalCommands(({ canonical }) =>
        claimTerminalExecution(canonical.executionId, {
          accountId: 'account-a',
          workspaceId: 'workspace-a',
          projectId: 'project-b',
        }),
      ),
    ).resolves.toEqual([]);
    expect(useTerminalCommandQueue.getState().queue.map((item) => item.id)).toEqual(['jterm_1']);
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('queued');
  });

  it('cancels before claim through the exact queue tombstone and canonical transition', async () => {
    const harness = canonicalHarness();
    const queueOwner = harness.registrations.get('terminal:jterm_1');

    await expect(queueOwner?.abort()).resolves.toEqual({
      kind: 'queued_tombstoned',
      ownerId: 'terminal:jterm_1',
      queueItemId: 'jterm_1',
    });
    expect(harness.transitionQueuedRunToCancelled).toHaveBeenCalledWith({
      accountId: 'account-a',
      runId: 'jrun_1',
      expectedStatus: 'queued',
    });
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('cancelled');
    expect(readTerminalCommandQueueDurableStateForTests('account-a', 'jterm_1')).toMatchObject({
      state: 'tombstone',
      runnable: false,
    });
    useTerminalCommandQueue.getState().clear();
    expect(readTerminalCommandQueueDurableStateForTests('account-a', 'jterm_1')).toMatchObject({
      state: 'tombstone',
    });
  });

  it('restores the exact runnable when the queued cancellation CAS loses', async () => {
    const harness = canonicalHarness();
    harness.transitionQueuedRunToCancelled.mockResolvedValueOnce({
      applied: false,
      reason: 'status_conflict',
    });

    await expect(harness.registrations.get('terminal:jterm_1')?.abort()).resolves.toEqual({
      kind: 'handoff_pending',
      ownerId: 'terminal:jterm_1',
    });

    expect(useTerminalCommandQueue.getState().queue).toHaveLength(1);
    expect(useTerminalCommandQueue.getState().queue[0]?.id).toBe('jterm_1');
    expect(harness.execution.dispose).not.toHaveBeenCalled();
    await expect(
      claimTerminalCommands(({ canonical }) => claimTerminalExecution(canonical.executionId)),
    ).resolves.toHaveLength(1);
  });

  it('fails closed when a queued cancellation CAS loses and exact rollback fails', async () => {
    const harness = canonicalHarness();
    harness.transitionQueuedRunToCancelled.mockResolvedValueOnce({
      applied: false,
      reason: 'authority_revoked',
    });
    vi.spyOn(jarvisTerminalCommandQueueAuthority, 'restoreExactRunnable').mockResolvedValueOnce(
      false,
    );

    await expect(harness.registrations.get('terminal:jterm_1')?.abort()).rejects.toThrow(
      'queued_cancellation_fail_closed',
    );
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(1);
    expect(harness.execution.dispose).not.toHaveBeenCalled();
    const claim = vi.fn(async () => true);
    await expect(claimTerminalCommands(claim)).resolves.toEqual([]);
    expect(claim).not.toHaveBeenCalled();
  });

  it('hands cancellation off after claim and delivers it after the PTY attaches', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);

    await expect(harness.registrations.get('terminal:jterm_1')?.abort()).resolves.toEqual({
      kind: 'handoff_pending',
      ownerId: 'terminal:jterm_1',
    });

    await attachTerminalExecution('jterm_1', canonicalAttachment());
    vi.mocked(invoke).mockResolvedValueOnce({
      kind: 'signal_delivered',
      requestKind: 'canonical_cancellation',
      cancellationToken: 'jcancel_native_1',
    });
    await expect(harness.registrations.get('terminal:jterm_1')?.abort()).resolves.toEqual({
      kind: 'signal_delivered',
      ownerId: 'terminal:jterm_1',
      cancellationToken: 'jcancel_native_1',
    });
  });

  it('revokes only the exact old account across queued and attached executions', async () => {
    const active = canonicalHarness({
      accountId: 'account-a',
      runId: 'jrun_active',
      executionId: 'jterm_active',
      cancellationToken: 'jcancel_native_active',
    });
    const queued = canonicalHarness({
      accountId: 'account-a',
      runId: 'jrun_queued',
      executionId: 'jterm_queued',
      cancellationToken: 'jcancel_native_queued',
    });
    const foreign = canonicalHarness({
      accountId: 'account-b',
      runId: 'jrun_foreign',
      executionId: 'jterm_foreign',
      cancellationToken: 'jcancel_native_foreign',
    });
    expect(await claimTerminalExecution('jterm_active')).toBe(true);
    expect(
      await attachTerminalExecution('jterm_active', {
        ...canonicalAttachment('pty_active'),
        accountId: 'account-a',
        paneId: 'pane-active',
      }),
    ).toBe(true);
    expect(
      await claimTerminalExecution('jterm_foreign', {
        ...exactClaimScope,
        accountId: 'account-b',
      }),
    ).toBe(true);
    expect(
      await attachTerminalExecution('jterm_foreign', {
        ...canonicalAttachment('pty_foreign'),
        accountId: 'account-b',
        paneId: 'pane-foreign',
      }),
    ).toBe(true);
    vi.mocked(invoke).mockResolvedValue({
      kind: 'signal_delivered',
      requestKind: 'canonical_cancellation',
      cancellationToken: 'jcancel_native_active',
    });
    active.requestCancellation.mockImplementationOnce(async () => {
      const outcome = await active.registrations.get('terminal:jterm_active')!.abort();
      expect(outcome).toMatchObject({
        kind: 'signal_delivered',
        cancellationToken: 'jcancel_native_active',
      });
      return {
        kind: 'intent_committed',
        requestState: 'new',
        authorityState: 'current',
        cancellationRequestId: 'jcancel_active',
        aggregate: { kind: 'signal_delivered', ownerIds: ['terminal:jterm_active'] },
      };
    });
    queued.requestCancellation.mockImplementationOnce(async () => {
      const outcome = await queued.registrations.get('terminal:jterm_queued')!.abort();
      expect(outcome).toMatchObject({
        kind: 'queued_tombstoned',
        queueItemId: 'jterm_queued',
      });
      return {
        kind: 'intent_committed',
        requestState: 'new',
        authorityState: 'current',
        cancellationRequestId: 'jcancel_queued',
        aggregate: {
          kind: 'queued_cancelled',
          ownerId: 'terminal:jterm_queued',
          queueItemId: 'jterm_queued',
        },
      };
    });

    await expect(revokeTerminalExecutionsForAccount('account-a')).resolves.toEqual({
      accountId: 'account-a',
      targeted: 2,
      revoked: 2,
      rejected: 0,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('terminal_kill', {
      sessionId: 'pty_active',
      cancellationToken: 'jcancel_native_active',
    });
    expect(foreign.requestCancellation).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.jterm_foreign.status).toBe('starting');
  });

  it('singleflights repeated account revocation and reports fail-closed rejection', async () => {
    const accepted = canonicalHarness({
      accountId: 'account-a',
      runId: 'jrun_active',
      executionId: 'jterm_active',
    });
    expect(await claimTerminalExecution('jterm_active')).toBe(true);
    await attachTerminalExecution('jterm_active', canonicalAttachment('pty_active'));
    let resolveCancellation:
      | ((value: Awaited<ReturnType<JarvisTerminalOwnedExecution['requestCancellation']>>) => void)
      | undefined;
    accepted.requestCancellation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCancellation = resolve;
        }),
    );

    const first = revokeTerminalExecutionsForAccount('account-a');
    const second = revokeTerminalExecutionsForAccount('account-a');
    await vi.waitFor(() => expect(accepted.requestCancellation).toHaveBeenCalledOnce());
    resolveCancellation?.({
      kind: 'intent_committed',
      requestState: 'new',
      authorityState: 'current',
      cancellationRequestId: 'jcancel_active',
      aggregate: { kind: 'signal_delivered', ownerIds: ['terminal:jterm_active'] },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { accountId: 'account-a', targeted: 1, revoked: 1, rejected: 0 },
      { accountId: 'account-a', targeted: 1, revoked: 1, rejected: 0 },
    ]);
    expect(accepted.requestCancellation).toHaveBeenCalledOnce();

    const rejected = canonicalHarness({
      accountId: 'account-rejected',
      runId: 'jrun_rejected',
      executionId: 'jterm_rejected',
    });
    rejected.requestCancellation.mockResolvedValueOnce({
      kind: 'authority_revoked_before_intent',
    });
    await expect(revokeTerminalExecutionsForAccount('account-rejected')).resolves.toEqual({
      accountId: 'account-rejected',
      targeted: 1,
      revoked: 0,
      rejected: 1,
    });
    await expect(revokeTerminalExecutionsForAccount('account-rejected')).resolves.toEqual({
      accountId: 'account-rejected',
      targeted: 1,
      revoked: 1,
      rejected: 0,
    });
    expect(rejected.requestCancellation).toHaveBeenCalledTimes(2);

    const wrongOwner = canonicalHarness({
      accountId: 'account-wrong-owner',
      runId: 'jrun_wrong_owner',
      executionId: 'jterm_wrong_owner',
    });
    wrongOwner.requestCancellation.mockResolvedValueOnce({
      kind: 'intent_committed',
      requestState: 'new',
      authorityState: 'current',
      cancellationRequestId: 'jcancel_wrong_owner',
      aggregate: { kind: 'signal_delivered', ownerIds: ['provider:unrelated'] },
    });
    await expect(revokeTerminalExecutionsForAccount('account-wrong-owner')).resolves.toEqual({
      accountId: 'account-wrong-owner',
      targeted: 1,
      revoked: 0,
      rejected: 1,
    });

    const terminalWithoutSettlement = canonicalHarness({
      accountId: 'account-terminal-race',
      runId: 'jrun_terminal_race',
      executionId: 'jterm_terminal_race',
    });
    terminalWithoutSettlement.requestCancellation.mockResolvedValueOnce({
      kind: 'already_terminal',
      terminalStatus: 'completed',
    });
    await expect(revokeTerminalExecutionsForAccount('account-terminal-race')).resolves.toEqual({
      accountId: 'account-terminal-race',
      targeted: 1,
      revoked: 0,
      rejected: 1,
    });
  });

  it('rejects invalid account revocation before touching any execution', async () => {
    const harness = canonicalHarness();

    await expect(revokeTerminalExecutionsForAccount('   ')).rejects.toThrow(
      'accountId must be a stable nonblank identifier',
    );

    expect(harness.requestCancellation).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats an exact repeated session attach as idempotent', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());
    const registrationsAfterFirstAttach = vi.mocked(
      harness.registrationAuthority.registerIssuedOwner,
    ).mock.calls.length;

    await expect(attachTerminalExecution('jterm_1', canonicalAttachment())).resolves.toBe(true);
    expect(harness.registrationAuthority.registerIssuedOwner).toHaveBeenCalledTimes(
      registrationsAfterFirstAttach,
    );
  });

  it('freezes the complete native process identity and reads it only for the exact scope', async () => {
    canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);

    await expect(attachTerminalExecution('jterm_1', processAttachment)).resolves.toBe(true);

    const identity = readTerminalProcessIdentity('jterm_1', {
      accountId: 'account-a',
      projectId: 'project-a',
      runId: 'jrun_1',
      executionId: 'jterm_1',
      paneId: 'pane-a',
    });
    expect(identity).toEqual({
      ...processAttachment,
      runId: 'jrun_1',
      executionId: 'jterm_1',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(useTerminalExecutionStore.getState().executions.jterm_1.processIdentity).toBe(identity);
    expect(
      readTerminalProcessIdentity('jterm_1', {
        accountId: 'account-b',
        projectId: 'project-a',
        runId: 'jrun_1',
        executionId: 'jterm_1',
        paneId: 'pane-a',
      }),
    ).toBeNull();
  });

  it('does not let a later status patch overwrite the canonical process identity', async () => {
    canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    expect(await attachTerminalExecution('jterm_1', processAttachment)).toBe(true);
    const identity = useTerminalExecutionStore.getState().executions.jterm_1.processIdentity;

    markTerminalExecution('jterm_1', 'running', {
      processIdentity: Object.freeze({
        ...processAttachment,
        runId: 'jrun-forged',
        executionId: 'jterm_1',
      }),
    });

    expect(useTerminalExecutionStore.getState().executions.jterm_1.processIdentity).toBe(identity);
  });

  it('keeps the canonical process identity immutable at the store boundary', async () => {
    canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    expect(await attachTerminalExecution('jterm_1', processAttachment)).toBe(true);
    const identity = useTerminalExecutionStore.getState().executions.jterm_1.processIdentity;

    useTerminalExecutionStore.getState().mark('jterm_1', 'running', {
      processIdentity: Object.freeze({
        ...processAttachment,
        runtimeGeneration: 'forged-generation',
        runId: 'jrun_1',
        executionId: 'jterm_1',
      }),
    });

    expect(useTerminalExecutionStore.getState().executions.jterm_1.processIdentity).toBe(identity);
  });

  it.each([
    ['missing process instance', { processInstanceId: '' }],
    ['control-bearing process instance', { processInstanceId: 'process\u0001instance' }],
    ['zero pid', { pid: 0 }],
    ['fractional pid', { pid: 42.5 }],
    ['pid beyond u32', { pid: 0x1_0000_0000 }],
    ['invalid process start', { processStartedAt: 0 }],
    ['control-bearing generation', { runtimeGeneration: 'generation\nforged' }],
    ['wrong account', { accountId: 'account-b' }],
  ])('rejects an invalid native process binding: %s', async (_label, patch) => {
    canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);

    await expect(
      attachTerminalExecution('jterm_1', { ...processAttachment, ...patch }),
    ).resolves.toBe(false);
    expect(
      readTerminalProcessIdentity('jterm_1', {
        accountId: 'account-a',
        projectId: 'project-a',
        runId: 'jrun_1',
        executionId: 'jterm_1',
        paneId: 'pane-a',
      }),
    ).toBeNull();
  });

  it.each([
    ['process instance', { processInstanceId: 'process-instance-2' }],
    ['pid reuse start time', { processStartedAt: 1_723_456_789_100 }],
    ['runtime restart', { runtimeGeneration: 'runtime-generation-2' }],
    ['pane', { paneId: 'pane-b' }],
    ['project', { projectId: 'project-b' }],
  ])(
    'rejects a repeated attach with changed %s without overwriting identity',
    async (_label, patch) => {
      canonicalHarness();
      expect(await claimTerminalExecution('jterm_1')).toBe(true);
      expect(await attachTerminalExecution('jterm_1', processAttachment)).toBe(true);

      await expect(
        attachTerminalExecution('jterm_1', { ...processAttachment, ...patch }),
      ).resolves.toBe(false);
      expect(
        readTerminalProcessIdentity('jterm_1', {
          accountId: 'account-a',
          projectId: 'project-a',
          runId: 'jrun_1',
          executionId: 'jterm_1',
          paneId: 'pane-a',
        }),
      ).toEqual({
        ...processAttachment,
        runId: 'jrun_1',
        executionId: 'jterm_1',
      });
    },
  );

  it('prevents two canonical executions from claiming the same active session or process', async () => {
    canonicalHarness();
    canonicalHarness({ executionId: 'jterm_2', runId: 'jrun_2' });
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    expect(await claimTerminalExecution('jterm_2')).toBe(true);
    expect(await attachTerminalExecution('jterm_1', processAttachment)).toBe(true);

    await expect(
      attachTerminalExecution('jterm_2', {
        ...processAttachment,
        sessionId: 'pty_2',
      }),
    ).resolves.toBe(false);
    await expect(
      attachTerminalExecution('jterm_2', {
        ...processAttachment,
        processInstanceId: 'process-instance-2',
      }),
    ).resolves.toBe(false);
    expect(
      readTerminalProcessIdentity('jterm_2', {
        accountId: 'account-a',
        projectId: 'project-a',
        runId: 'jrun_2',
        executionId: 'jterm_2',
        paneId: 'pane-a',
      }),
    ).toBeNull();
  });

  it('linearizes concurrent claims for the same native process identity', async () => {
    canonicalHarness();
    canonicalHarness({ executionId: 'jterm_2', runId: 'jrun_2' });
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    expect(await claimTerminalExecution('jterm_2')).toBe(true);

    const results = await Promise.all([
      attachTerminalExecution('jterm_1', processAttachment),
      attachTerminalExecution('jterm_2', {
        ...processAttachment,
        sessionId: 'pty_2',
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ['project', { projectId: 'project-b' }],
    ['run', { runId: 'jrun-other' }],
    ['execution', { executionId: 'jterm_other' }],
    ['pane', { paneId: 'pane-b' }],
  ])('rejects a %s-scoped identity read', async (_label, scopePatch) => {
    canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    expect(await attachTerminalExecution('jterm_1', processAttachment)).toBe(true);

    expect(
      readTerminalProcessIdentity('jterm_1', {
        accountId: 'account-a',
        projectId: 'project-a',
        runId: 'jrun_1',
        executionId: 'jterm_1',
        paneId: 'pane-a',
        ...scopePatch,
      }),
    ).toBeNull();
  });

  it.each([
    ['missing', 'already_exited'],
    ['already_exited', 'already_exited'],
    ['delivery_rejected', 'delivery_rejected'],
  ] as const)(
    'keeps a native %s kill result nonterminal and reports %s to Task 18',
    async (nativeKind, ownerKind) => {
      const harness = canonicalHarness();
      expect(await claimTerminalExecution('jterm_1')).toBe(true);
      await attachTerminalExecution('jterm_1', canonicalAttachment());
      vi.mocked(invoke).mockResolvedValueOnce({
        kind: nativeKind,
        requestKind: 'canonical_cancellation',
        cancellationToken: 'jcancel_native_1',
      });

      await expect(harness.registrations.get('terminal:jterm_1')?.abort()).resolves.toEqual({
        kind: ownerKind,
        ownerId: 'terminal:jterm_1',
      });
      expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('starting');
      expect(harness.recordCancellationVerified).not.toHaveBeenCalled();
      expect(harness.recordResult).not.toHaveBeenCalled();
      expect(harness.execution.dispose).not.toHaveBeenCalled();
    },
  );

  it('routes canonical timeout through Task 18 without making a local cancellation claim', async () => {
    vi.useFakeTimers();
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());
    markTerminalExecution('jterm_1', 'running', { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.requestCancellation).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.jterm_1).toMatchObject({
      status: 'cancellation_requested',
      timedOut: true,
    });
    expect(harness.recordCancellationVerified).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps signal delivery nonterminal until the matching native exit verifies cancellation', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());
    vi.mocked(invoke).mockResolvedValueOnce({
      kind: 'signal_delivered',
      requestKind: 'canonical_cancellation',
      cancellationToken: 'jcancel_native_1',
    });

    await requestTerminalExecutionCancellation('jterm_1');
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe(
      'cancellation_requested',
    );
    expect(harness.recordCancellationVerified).not.toHaveBeenCalled();

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: null,
        reason: 'accepted_cancellation',
        cancellationToken: 'jcancel_native_1',
      }),
    );

    expect(harness.recordCancellationVerified).toHaveBeenCalledWith({
      cancellationRequestId: 'jcancel_1',
      resultRef: expect.stringMatching(/^jterminal_result:/),
      verifiedAt: expect.any(Number),
    });
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('cancelled');
    expect(harness.execution.dispose).toHaveBeenCalledOnce();

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: 0,
        reason: 'natural_exit',
      }),
    );
    expect(harness.recordResult).not.toHaveBeenCalled();
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
  });

  it('settles through the process-level exit owner after the terminal view is absent', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await observeTerminalExecutionNativeExit(
      nativeExit({
        sessionId: 'pty_1',
        code: 0,
        reason: 'natural_exit',
      }),
    );

    expect(harness.recordResult).toHaveBeenCalledOnce();
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('complete');
  });

  it('rejects stale same-session process exits without consuming the exact exit', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await expect(
      observeTerminalExecutionNativeExit(
        nativeExit({ processInstanceId: 'stale-process-instance' }),
      ),
    ).resolves.toBe(false);
    expect(harness.recordResult).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('starting');

    await expect(observeTerminalExecutionNativeExit(nativeExit())).resolves.toBe(true);
    expect(harness.recordResult).toHaveBeenCalledOnce();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('complete');
    await expect(
      settleTerminalExecutionFromNativeExit(
        'jterm_1',
        nativeExit({ runtimeGeneration: 'stale-runtime-generation' }),
      ),
    ).resolves.toBe(false);
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('complete');
    await expect(settleTerminalExecutionFromNativeExit('jterm_1', nativeExit())).resolves.toBe(
      true,
    );
  });

  it.each([
    ['process instance', { processInstanceId: 'stale-process' }],
    ['pid reuse', { pid: 4243 }],
    ['process start', { processStartedAt: 1_723_456_789_001 }],
    ['runtime generation', { runtimeGeneration: 'runtime-generation-2' }],
  ])('fails closed on a mismatched %s exit', async (_label, mismatch) => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await expect(
      settleTerminalExecutionFromNativeExit('jterm_1', nativeExit(mismatch)),
    ).resolves.toBe(false);
    expect(harness.recordResult).not.toHaveBeenCalled();
    expect(harness.recordCancellationVerified).not.toHaveBeenCalled();
    expect(harness.execution.dispose).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('starting');
  });

  it('rejects malformed process-bound exits without retaining or settling them', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    for (const malformed of [
      {
        ...nativeExit(),
        processInstanceId: undefined,
      } as unknown as NativeTerminalExitPayload,
      nativeExit({ processInstanceId: '' }),
      nativeExit({ pid: 0 }),
      nativeExit({ processStartedAt: Number.NaN }),
      nativeExit({ runtimeGeneration: 'bad\u0000generation' }),
      nativeExit({ reason: 'natural_exit', cancellationToken: 'unexpected-token' }),
      nativeExit({
        code: null,
        reason: 'accepted_cancellation',
        cancellationToken: 'x'.repeat(513),
      }),
    ]) {
      await expect(observeTerminalExecutionNativeExit(malformed)).resolves.toBe(false);
    }

    expect(harness.recordResult).not.toHaveBeenCalled();
    expect(harness.execution.dispose).not.toHaveBeenCalled();
  });

  it('buffers native exit truth when unmount wins terminal_spawn and consumes it on late attach', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);

    await expect(
      observeTerminalExecutionNativeExit(
        nativeExit({
          sessionId: 'pty_spawn_race',
          code: 0,
          reason: 'natural_exit',
        }),
      ),
    ).resolves.toBe(false);
    expect(harness.recordResult).not.toHaveBeenCalled();

    await expect(
      attachTerminalExecution('jterm_1', canonicalAttachment('pty_spawn_race')),
    ).resolves.toBe(true);

    expect(harness.recordResult).toHaveBeenCalledOnce();
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('complete');
  });

  it('reconciles an externally requested cancellation before verifying its native exit', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: null,
        reason: 'accepted_cancellation',
        cancellationToken: 'jcancel_native_1',
      }),
    );

    expect(harness.requestCancellation).toHaveBeenCalledOnce();
    expect(harness.recordCancellationVerified).toHaveBeenCalledWith({
      cancellationRequestId: 'jcancel_1',
      resultRef: expect.stringMatching(/^jterminal_result:/),
      verifiedAt: expect.any(Number),
    });
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
  });

  it('records a bounded degraded result when native spawn never starts', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);

    await expect(
      failTerminalExecutionBeforeNativeExit('jterm_1', 'native_spawn_failed'),
    ).resolves.toBe(true);

    expect(harness.recordResult).toHaveBeenCalledWith({
      state: 'degraded',
      resultRef: 'jterminal_result:jterm_1:pre_native:native_spawn_failed:none',
      completedAt: expect.any(Number),
    });
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
    expect(terminalExecutionCancellationToken('jterm_1')).toBeUndefined();
    expect(useTerminalExecutionStore.getState().executions.jterm_1).toMatchObject({
      status: 'failed',
      settlementError: 'native_spawn_failed',
    });
  });

  it('records natural native completion once and rejects a stale cancellation token', async () => {
    const natural = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: 0,
        reason: 'natural_exit',
      }),
    );
    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: 0,
        reason: 'natural_exit',
      }),
    );

    expect(natural.recordResult).toHaveBeenCalledOnce();
    expect(natural.recordResult).toHaveBeenCalledWith({
      state: 'completed',
      resultRef: expect.stringMatching(/^jterminal_result:/),
      completedAt: expect.any(Number),
    });
    expect(natural.execution.dispose).toHaveBeenCalledOnce();
    expect(terminalExecutionCancellationToken('jterm_1')).toBeUndefined();

    useTerminalExecutionStore.getState().clear();
    resetTerminalCommandQueueDurabilityForTests();
    const stale = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());
    await requestTerminalExecutionCancellation('jterm_1');
    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: null,
        reason: 'accepted_cancellation',
        cancellationToken: 'stale-token',
      }),
    );

    expect(stale.recordCancellationVerified).not.toHaveBeenCalled();
    expect(stale.recordResult).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe(
      'cancellation_requested',
    );
    expect(stale.execution.dispose).not.toHaveBeenCalled();

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: null,
        reason: 'accepted_cancellation',
        cancellationToken: 'jcancel_native_1',
      }),
    );
    expect(stale.recordCancellationVerified).toHaveBeenCalledOnce();
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('cancelled');
  });

  it('shares the exact canonical run completion identity with task notifications', async () => {
    canonicalHarness();
    await expect(claimTerminalExecution('jterm_1')).resolves.toBe(true);
    await expect(attachTerminalExecution('jterm_1', canonicalAttachment())).resolves.toBe(true);

    await expect(
      settleTerminalExecutionFromNativeExit(
        'jterm_1',
        nativeExit({
          sessionId: 'pty_1',
          code: 0,
          reason: 'natural_exit',
        }),
      ),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(notificationMocks.notifyDone).toHaveBeenCalledOnce());
    expect(notificationMocks.notifyDone).toHaveBeenCalledWith(
      'terminal',
      'Terminal done',
      'Command finished successfully.',
      { completionIdentity: 'jarvis-run:jrun_1' },
    );
  });

  it('keeps canonical terminal failure presentation truthful and outside completion dedupe', async () => {
    canonicalHarness();
    await expect(claimTerminalExecution('jterm_1')).resolves.toBe(true);

    await expect(
      failTerminalExecutionBeforeNativeExit('jterm_1', 'pre_session_initialization_failed'),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(notificationMocks.notifyDone).toHaveBeenCalledOnce());
    expect(notificationMocks.notifyDone).toHaveBeenCalledWith(
      'terminal',
      'Terminal done',
      'Command failed.',
    );
  });

  it.each([
    ['manual_termination', null],
    ['natural_exit', 7],
  ] as const)(
    'maps %s to a degraded result and never canonical cancellation',
    async (reason, code) => {
      const harness = canonicalHarness();
      expect(await claimTerminalExecution('jterm_1')).toBe(true);
      await attachTerminalExecution('jterm_1', canonicalAttachment());

      await settleTerminalExecutionFromNativeExit(
        'jterm_1',
        nativeExit({
          sessionId: 'pty_1',
          code,
          reason,
        }),
      );

      expect(harness.recordResult).toHaveBeenCalledWith({
        state: 'degraded',
        resultRef: expect.stringContaining(`:${reason}:`),
        completedAt: expect.any(Number),
      });
      expect(harness.recordCancellationVerified).not.toHaveBeenCalled();
      expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('failed');
      expect(harness.execution.dispose).toHaveBeenCalledOnce();
    },
  );

  it('reads the matching cancellation intent before verifying an accepted exit', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: null,
        reason: 'accepted_cancellation',
        cancellationToken: 'jcancel_native_1',
      }),
    );
    expect(harness.requestCancellation).toHaveBeenCalledOnce();
    expect(harness.recordCancellationVerified).toHaveBeenCalledWith({
      cancellationRequestId: 'jcancel_1',
      resultRef: expect.stringMatching(/^jterminal_result:/),
      verifiedAt: expect.any(Number),
    });
    expect(useTerminalExecutionStore.getState().executions.jterm_1.status).toBe('cancelled');
  });

  it('routes canonical timeout intent through the retained cancellation controller', async () => {
    vi.useFakeTimers();
    const harness = canonicalHarness({ timeoutMs: 25 });
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());
    markTerminalExecution('jterm_1', 'running', { sessionId: 'pty_1' });

    await vi.advanceTimersByTimeAsync(25);

    expect(harness.requestCancellation).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(useTerminalExecutionStore.getState().executions.jterm_1).toMatchObject({
      status: 'cancellation_requested',
      timedOut: true,
    });
    vi.useRealTimers();
  });

  it('fails closed when account authority is revoked during native result settlement', async () => {
    const harness = canonicalHarness();
    harness.recordResult.mockResolvedValueOnce({ kind: 'account_authority_revoked' });
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());

    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: 0,
        reason: 'natural_exit',
      }),
    );

    expect(useTerminalExecutionStore.getState().executions.jterm_1).toMatchObject({
      status: 'failed',
      settlementError: 'result_account_authority_revoked',
    });
    expect(harness.execution.dispose).toHaveBeenCalledOnce();
  });

  it('fails closed after restart when no private canonical controller can be reconstructed', async () => {
    markTerminalExecution('jterm_restart', 'complete', { sessionId: 'pty_restart', exitCode: 0 });

    expect(useTerminalExecutionStore.getState().executions.jterm_restart).toMatchObject({
      status: 'failed',
      settlementError: 'canonical_terminal_handle_unavailable_after_restart',
    });
    await expect(attachTerminalExecution('jterm_restart', 'pty_restart')).resolves.toBe(false);
    await expect(
      settleTerminalExecutionFromNativeExit(
        'jterm_restart',
        nativeExit({
          sessionId: 'pty_restart',
          code: 0,
          reason: 'natural_exit',
        }),
      ),
    ).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects cancellation for an unverified restart sentinel without a canonical handle', async () => {
    markTerminalExecution('jterm_restart', 'complete', { sessionId: 'pty_restart', exitCode: 0 });

    const result = await requestTerminalExecutionCancellation('jterm_restart');

    expect(result).toBeNull();
    expect(terminalCancellationDisposition(result)).toBe('rejected');
    expect(useTerminalExecutionStore.getState().executions.jterm_restart).toMatchObject({
      status: 'failed',
      settlementError: 'canonical_terminal_handle_unavailable_after_restart',
    });
  });

  it('exhaustively classifies canonical cancellation authority results', () => {
    expect(terminalCancellationDisposition(null)).toBe('rejected');
    expect(terminalCancellationDisposition({ kind: 'authority_revoked_before_intent' })).toBe(
      'rejected',
    );
    expect(
      terminalCancellationDisposition({ kind: 'already_terminal', terminalStatus: 'failed' }),
    ).toBe('terminal');
    expect(
      terminalCancellationDisposition({
        kind: 'intent_committed',
        requestState: 'new',
        authorityState: 'current',
        cancellationRequestId: 'jcancel_1',
        aggregate: { kind: 'handoff_pending', ownerIds: ['terminal:jterm_1'] },
      }),
    ).toBe('pending');
  });

  it('returns truthful already-terminal state when a verified local execution is closed again', async () => {
    const harness = canonicalHarness();
    expect(await claimTerminalExecution('jterm_1')).toBe(true);
    await attachTerminalExecution('jterm_1', canonicalAttachment());
    await settleTerminalExecutionFromNativeExit(
      'jterm_1',
      nativeExit({
        sessionId: 'pty_1',
        code: 0,
        reason: 'natural_exit',
      }),
    );

    await expect(requestTerminalExecutionCancellation('jterm_1')).resolves.toEqual({
      kind: 'already_terminal',
      terminalStatus: 'completed',
    });
    expect(harness.requestCancellation).not.toHaveBeenCalled();
  });
});

describe('canonical terminal artifact evidence authority', () => {
  const exact = Object.freeze({
    producerId: 'terminal_exit',
    accountId: 'account-terminal',
    runId: 'jrun_terminal',
    requestId: 'jrequest_terminal',
    attemptNumber: 1,
    resultRef: 'jterminal_result:jterm_terminal:pty_terminal:natural_exit:0',
    state: 'exited',
    verifiedAt: 1_786_202_300_000,
    sessionId: 'pty_terminal',
    executionId: 'jterm_terminal',
  }) satisfies CanonicalTerminalEvidence;

  it('accepts only the exact frozen Task 19C result re-read', async () => {
    const readCanonicalTerminalEvidence = vi.fn(async () => exact);
    const authority = createCanonicalTerminalEvidenceAuthority({
      readCanonicalTerminalEvidence,
    });

    await expect(authority.verify(exact)).resolves.toBe(exact);
    for (const changed of [
      Object.freeze({ ...exact, runId: 'jrun_other' }),
      Object.freeze({ ...exact, requestId: 'jrequest_other' }),
      Object.freeze({ ...exact, resultRef: 'jterminal_result:other' }),
      Object.freeze({ ...exact, sessionId: 'pty_other' }),
      Object.freeze({ ...exact, executionId: 'jterm_other' }),
    ]) {
      await expect(authority.verify(changed)).resolves.toBeNull();
    }
  });

  it('accepts a real persisted partial and rejects queued or invalid terminal evidence', async () => {
    const partial = Object.freeze({
      ...exact,
      resultRef: 'jterminal_partial:jterm_terminal:pty_terminal:transcript-1',
      state: 'partial' as const,
    });
    const readCanonicalTerminalEvidence = vi.fn(async () => partial);
    const authority = createCanonicalTerminalEvidenceAuthority({
      readCanonicalTerminalEvidence,
    });

    await expect(authority.verify(partial)).resolves.toBe(partial);
    await expect(
      authority.verify(Object.freeze({ ...exact, state: 'queued' }) as never),
    ).resolves.toBeNull();
    await expect(authority.verify({ ...exact })).resolves.toBeNull();
    await expect(
      authority.verify(Object.freeze({ ...exact, verifiedAt: Number.POSITIVE_INFINITY })),
    ).resolves.toBeNull();
  });
});

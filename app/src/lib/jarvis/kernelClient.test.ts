import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KernelClientResponseEvent } from './kernelBridgeProtocol';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: [] as Array<(event: { payload: KernelClientResponseEvent }) => void>,
  unlisteners: [] as Array<ReturnType<typeof vi.fn>>,
}));
const localHost = vi.hoisted(() => ({ request: vi.fn(() => null as Promise<unknown> | null) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: tauri.listen.mockImplementation(async (_event, handler) => {
    const unlisten = vi.fn();
    tauri.listeners.push(handler);
    tauri.unlisteners.push(unlisten);
    return unlisten;
  }),
}));
vi.mock('./kernelHost', () => ({ requestLocalJarvisKernelHost: localHost.request }));

import { createJarvisKernelClient } from './kernelClient';

function emit(payload: KernelClientResponseEvent): void {
  for (const listener of [...tauri.listeners]) listener({ payload });
}

describe('typed kernel client', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listen.mockClear();
    tauri.listeners.length = 0;
    tauri.unlisteners.length = 0;
    localHost.request.mockReset();
    localHost.request.mockReturnValue(null);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.useRealTimers();
  });

  it('run diagnostic rejects foreign host epochs and stamps only its registered native epoch', async () => {
    tauri.invoke.mockResolvedValue({ epoch: 41, requestId: 'diagnostic-request', deadlineMs: Date.now() + 1_000 });
    localHost.request.mockResolvedValue({ version: 1, kind: 'unavailable', requestKind: 'run_ownership_diagnostic', reason: 'host_unavailable' });
    const client = createJarvisKernelClient({ timeoutMs: 1_000 });
    const pending = client.getRunOwnershipDiagnostic({ runId: 'jrun_fixture' });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(1));
    const response = { version: 1 as const, kind: 'run_ownership_diagnostic' as const,
      accountId: 'account', runId: 'jrun_fixture', authorityEpoch: 3,
      consistency: 'non_atomic_observation' as const, settlementAuthority: false as const,
      latestAttempt: null, ownerCount: 0, terminalCount: 0, queueCount: 0,
      cancellationIntentCount: 0, approvalCount: 0, pendingCancellation: null,
      terminalRead: 'unavailable' as const, unknowns: ['registry_owner_unavailable'] };
    emit({ epoch: 42, requestId: 'diagnostic-request', response });
    expect(tauri.unlisteners.every(unlisten => unlisten.mock.calls.length === 0)).toBe(true);
    emit({ epoch: 41, requestId: 'diagnostic-request', response });
    await expect(pending).resolves.toMatchObject({ kind: 'run_ownership_diagnostic', nativeHostEpoch: 41 });
    expect(localHost.request).not.toHaveBeenCalled(); client.dispose();
  });

  it('exposes only closed typed methods and correlates simultaneous responses', async () => {
    tauri.invoke.mockImplementation(
      async (_command: string, input: { request: { kind: string } }) =>
        input.request.kind === 'cancel'
          ? { epoch: 8, requestId: 'cancel-request', deadlineMs: Date.now() + 1_000 }
          : { epoch: 8, requestId: 'snapshot-request', deadlineMs: Date.now() + 1_000 },
    );
    const client = createJarvisKernelClient({ timeoutMs: 1_000 });
    expect(Object.keys(client).sort()).toEqual([
      'cancel',
      'createApproval',
      'decideApproval',
      'dispatchTurn',
      'dispose',
      'executeApproval',
      'getApprovalPresentation',
      'getApprovalStatus',
      'getCommandCenterSnapshot',
      'getContextSourceRevision',
      'getRunOwnershipDiagnostic',
      'retryScheduled',
    ]);
    expect('request' in client).toBe(false);
    expect('resolveCredential' in client).toBe(false);

    const cancellation = client.cancel({ accountId: 'account-1', runId: 'run-1' });
    const snapshot = client.getCommandCenterSnapshot({ accountId: 'account-1' });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(2));
    expect(tauri.listen).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(tauri.listeners).toHaveLength(2));

    emit({
      epoch: 8,
      requestId: 'snapshot-request',
      response: {
        version: 1,
        kind: 'command_center_snapshot',
        accountId: 'account-1',
        runs: [{ runId: 'run-1', status: 'running', hasActiveEvidence: true }],
      },
    });
    emit({
      epoch: 8,
      requestId: 'cancel-request',
      response: {
        version: 1,
        kind: 'cancellation_state',
        runId: 'run-1',
        state: 'delivered',
      },
    });

    await expect(cancellation).resolves.toMatchObject({ kind: 'cancellation_state' });
    await expect(snapshot).resolves.toMatchObject({
      kind: 'command_center_snapshot',
      runs: [{ runId: 'run-1', status: 'running', hasActiveEvidence: true }],
    });
    expect(tauri.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it('returns safe unavailable truth on timeout and removes its listener once', async () => {
    vi.useFakeTimers();
    tauri.invoke.mockResolvedValue({ epoch: 3, requestId: 'late', deadlineMs: Date.now() + 25 });
    const client = createJarvisKernelClient({ timeoutMs: 25 });
    const pending = client.dispatchTurn({
      accountId: 'account-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toEqual({
      version: 1,
      kind: 'unavailable',
      requestKind: 'turn_dispatch',
      reason: 'request_timed_out',
    });
    expect(tauri.unlisteners[0]).toHaveBeenCalledOnce();
  });

  it('fails closed when no native host accepts the request', async () => {
    tauri.invoke.mockRejectedValue('kernel_host_unavailable');
    const client = createJarvisKernelClient();
    await expect(client.cancel({ accountId: 'account-1', runId: 'run-1' })).resolves.toEqual({
      version: 1,
      kind: 'unavailable',
      requestKind: 'cancel',
      reason: 'host_unavailable',
    });
    expect(tauri.unlisteners[0]).toHaveBeenCalledOnce();
  });

  it('uses the attested host-local closed DTO path without invoking native client admission', async () => {
    localHost.request.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_presentation',
      approvalId: 'approval-1',
      actionId: 'terminal.create',
      expectedEffect: 'Create one protected terminal.',
      risk: 'confirm',
      parameters: [],
    });
    const client = createJarvisKernelClient();

    await expect(
      client.getApprovalPresentation({ accountId: 'account-1', approvalId: 'approval-1' }),
    ).resolves.toMatchObject({ kind: 'approval_presentation', approvalId: 'approval-1' });
    expect(localHost.request).toHaveBeenCalledWith({
      version: 1,
      kind: 'approval_present',
      accountId: 'account-1',
      approvalId: 'approval-1',
    });
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('reads only the exact account-scoped canonical approval status', async () => {
    localHost.request.mockResolvedValueOnce({
      version: 1,
      kind: 'approval_state',
      accountId: 'account-1',
      approvalId: 'approval-1',
      status: 'denied',
    });
    const client = createJarvisKernelClient();

    await expect(
      client.getApprovalStatus({ accountId: 'account-1', approvalId: 'approval-1' }),
    ).resolves.toEqual({
      version: 1,
      kind: 'approval_state',
      accountId: 'account-1',
      approvalId: 'approval-1',
      status: 'denied',
    });
    expect(localHost.request).toHaveBeenCalledWith({
      version: 1,
      kind: 'approval_status',
      accountId: 'account-1',
      approvalId: 'approval-1',
    });
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('settles every pending request and cleans listeners on disposal', async () => {
    tauri.invoke.mockResolvedValue({
      epoch: 2,
      requestId: 'pending',
      deadlineMs: Date.now() + 5_000,
    });
    const client = createJarvisKernelClient();
    const pending = client.retryScheduled({
      accountId: 'account-1',
      runId: 'run-1',
      attemptId: 'attempt-2',
    });
    await vi.waitFor(() => expect(tauri.listeners).toHaveLength(1));
    client.dispose();
    await expect(pending).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'client_disposed',
    });
    expect(tauri.unlisteners[0]).toHaveBeenCalledOnce();
  });

  it('does not install a listener when disposed while native transport is loading', async () => {
    const client = createJarvisKernelClient();
    const pending = client.cancel({ accountId: 'account-1', runId: 'run-1' });
    client.dispose();

    await expect(pending).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'client_disposed',
    });
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});

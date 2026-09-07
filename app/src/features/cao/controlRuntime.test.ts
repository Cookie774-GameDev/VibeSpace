import { describe, expect, it, vi } from 'vitest';
import {
  createCaoControlRuntime,
  type CaoControlRecord,
  type CaoControlRuntimeDeps,
} from './controlRuntime';

const scope = { accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1' };
const command = {
  action: 'verify' as const,
  selectors: [{ kind: 'chat' as const, selector: 'chat-1', by: 'id' as const }],
  source: 'natural-language' as const,
};
const targets = [{ kind: 'chat' as const, targetId: 'chat-1', revision: 4 }];

function harness(overrides: Partial<CaoControlRuntimeDeps> = {}) {
  const records = new Map<string, CaoControlRecord>();
  const deps: CaoControlRuntimeDeps = {
    store: {
      load: vi.fn(async (requestId) => records.get(requestId)),
      save: vi.fn(async (expectedRevision, value) => {
        const current = records.get(value.requestId);
        if ((current?.revision ?? 0) !== expectedRevision) return false;
        records.set(value.requestId, structuredClone(value));
        return true;
      }),
    },
    approval: {
      request: vi.fn(async () => ({ state: 'approved' as const, approvalId: 'approval-1' })),
      read: vi.fn(async () => ({ state: 'approved' as const, approvalId: 'approval-1' })),
    },
    authority: {
      acquire: vi.fn(async () => ({ leaseId: 'lease-1' })),
      verify: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    },
    action: {
      execute: vi.fn(async () => ({ status: 'completed' as const, receiptId: 'receipt-1' })),
      cancel: vi.fn(async () => undefined),
    },
    now: vi.fn(() => 100),
    newRunId: vi.fn(() => 'jrun_cao_control_1'),
    ...overrides,
  };
  return { runtime: createCaoControlRuntime(deps), deps, records };
}

describe('CAO control runtime', () => {
  it('releases the exact lease when an action throws', async () => {
    const { runtime, deps } = harness({ action: { execute: async () => { throw new Error('offline'); }, cancel: async () => {} } });
    expect((await runtime.run({ ...scope, requestId: 'throwing', command, targets })).status).toBe('failed');
    expect(deps.authority!.release).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease-1' }));
  });

  it('propagates cancellation to the active action without overwriting the cancelled record', async () => {
    let notify!: () => void;
    const ready = new Promise<void>(resolve => { notify = resolve; });
    let signal: AbortSignal | undefined;
    const { runtime } = harness({ action: { execute: async input => {
      signal = input.signal; notify();
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'cancelled' };
    }, cancel: async () => {} } });
    const pending = runtime.run({ ...scope, requestId: 'cancel-active', command, targets });
    await ready;
    const result = await runtime.cancel({ ...scope, requestId: 'cancel-active' });
    expect(signal?.aborted).toBe(true);
    expect(result.status).toBe('cancelled');
    expect((await pending).status).toBe('cancelled');
  });
  it('persists, leases, revalidates, releases, and deduplicates a safe receipt', async () => {
    const { runtime, deps } = harness();
    const input = { ...scope, requestId: 'request-1', command, targets };
    const first = await runtime.run(input);
    const duplicate = await runtime.run(input);
    expect(first).toEqual(duplicate);
    expect(first).toEqual({
      identity: 'Jarvis CAO',
      action: 'verify',
      status: 'completed',
      runId: 'jrun_cao_control_1',
      requestId: 'request-1',
      targetIds: ['chat:chat-1'],
      receiptId: 'receipt-1',
    });
    expect(deps.action.execute).toHaveBeenCalledTimes(1);
    expect(deps.authority!.verify).toHaveBeenCalledTimes(2);
    expect(deps.authority!.release).toHaveBeenCalledTimes(1);
  });

  it.each(['restart', 'force-check'] as const)(
    'requires durable approval before %s',
    async (action) => {
      const approval = {
        request: vi.fn(async () => ({ state: 'pending' as const, approvalId: 'approval-pending' })),
        read: vi.fn(),
      };
      const { runtime, deps } = harness({ approval });
      const receipt = await runtime.run({
        ...scope,
        requestId: `request-${action}`,
        command: { ...command, action },
        targets,
      });
      expect(receipt.status).toBe('awaiting_approval');
      expect(receipt.approvalId).toBe('approval-pending');
      expect(deps.authority!.acquire).not.toHaveBeenCalled();
      expect(deps.action.execute).not.toHaveBeenCalled();
    },
  );

  it('resumes an approved durable request after reload without allocating a duplicate', async () => {
    const { runtime, deps } = harness({
      approval: {
        request: vi.fn(async () => ({ state: 'pending' as const, approvalId: 'approval-1' })),
        read: vi.fn(async () => ({ state: 'approved' as const, approvalId: 'approval-1' })),
      },
    });
    const input = {
      ...scope,
      requestId: 'request-reload',
      command: { ...command, action: 'restart' as const },
      targets,
    };
    expect((await runtime.run(input)).status).toBe('awaiting_approval');
    expect((await runtime.run(input)).status).toBe('completed');
    expect(deps.action.execute).toHaveBeenCalledTimes(1);
    expect(deps.newRunId).toHaveBeenCalledTimes(1);
  });

  it('does not replay an uncertain mutating effect after reload', async () => {
    const { runtime, records, deps } = harness();
    records.set('request-uncertain', {
      schemaVersion: 1,
      revision: 3,
      ...scope,
      requestId: 'request-uncertain',
      runId: 'jrun_existing',
      command: { ...command, action: 'restart' },
      targets,
      status: 'running',
      leaseId: 'lease-existing',
      updatedAt: 90,
    });
    const receipt = await runtime.run({
      ...scope,
      requestId: 'request-uncertain',
      command: { ...command, action: 'restart' },
      targets,
    });
    expect(receipt).toMatchObject({ status: 'failed', errorCode: 'cao_control_recovery_required' });
    expect(deps.action.execute).not.toHaveBeenCalled();
  });

  it('cancels only the exact durable request and returns a redacted categorical receipt', async () => {
    const { runtime, records, deps } = harness();
    await runtime.run({ ...scope, requestId: 'request-done', command, targets });
    expect((await runtime.cancel({ ...scope, requestId: 'missing' })).errorCode).toBe(
      'cao_control_request_missing',
    );
    records.set('request-running', {
      schemaVersion: 1,
      revision: 2,
      ...scope,
      requestId: 'request-running',
      runId: 'jrun_running',
      command,
      targets,
      status: 'running',
      leaseId: 'lease-running',
      updatedAt: 90,
    });
    const cancelled = await runtime.cancel({ ...scope, requestId: 'request-running' });
    expect(cancelled.status).toBe('cancelled');
    expect(deps.action.cancel).toHaveBeenCalledWith('jrun_running');
    expect(JSON.stringify(cancelled)).not.toMatch(/path|command|output|reasoning|secret/iu);
  });

  it('fails closed when canonical authority composition is unavailable', async () => {
    const { runtime } = harness({ authority: undefined as never });
    await expect(
      runtime.run({ ...scope, requestId: 'request-no-authority', command, targets }),
    ).rejects.toThrow('cao_control_authority_unavailable');
  });
});

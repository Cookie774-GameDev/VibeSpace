import { describe, expect, it, vi } from 'vitest';
import type { JarvisIssuedActionExecution } from './approvalEngine';
import {
  createNativeCapabilityBroker,
  type NativeCapabilityAdapter,
  type NativeCapabilityAdapterResult,
  type NativeCapabilityRequest,
} from './nativeCapabilityBroker';

const request = (overrides: Partial<NativeCapabilityRequest> = {}): NativeCapabilityRequest => ({
  capabilityId: 'file.primary',
  capabilityVersion: 1,
  kind: 'file',
  operation: 'file.read',
  accountId: 'account-1',
  runId: 'run-1',
  requestId: 'request-1',
  attemptNumber: 1,
  workspaceRoot: 'C:\\workspace',
  parameterHash: 'sha256:abcdef',
  ...overrides,
});

const adapter = (
  execute: NativeCapabilityAdapter['execute'] = vi.fn(
    async (): Promise<NativeCapabilityAdapterResult> => ({
      state: 'completed',
      resultRef: 'jresult_result_1',
    }),
  ),
): NativeCapabilityAdapter => ({
  id: 'file.primary',
  version: 1,
  kind: 'file',
  operations: ['file.read'],
  risk: 'read-only',
  approval: 'never',
  producerKinds: ['file_action'],
  execute,
});

function issuedExecution(
  overrides: Partial<JarvisIssuedActionExecution> = {},
): JarvisIssuedActionExecution {
  return {
    approval: {
      schemaVersion: 1,
      id: 'approval-1',
      runId: 'run-1',
      requestId: 'request-1',
      attemptNumber: 1,
      actionId: 'file.read',
      actionVersion: 1,
      capabilityId: 'file.primary',
      capabilitySnapshotHash: 'sha256:capability',
      params: {},
      paramsHash: 'sha256:abcdef',
      risk: 'safe',
      status: 'consumed',
      expectedEffect: 'Read a file.',
      createdAt: 1,
      expiresAt: 10,
    },
    producerKind: 'file_action',
    ownerId: 'owner-1',
    startEvent: {
      runId: 'run-1',
      seq: 1,
      idempotencyKey: 'start-1',
      type: 'tool',
      title: 'Started',
      sourceRefs: [],
      artifactIds: [],
      createdAt: 1,
    },
    initialLiveProof: {
      proofRef: 'jlive_start_1',
      accountId: 'account-1',
      runId: 'run-1',
      requestId: 'request-1',
      attemptNumber: 1,
      registrationId: 'file.primary',
      producerKind: 'file_action',
      resultRef: 'jresult_start_1',
      resultEventSeq: 1,
      transition: 'started',
      eventSeq: 1,
    },
    beginExternalEffect: vi.fn((begin) => ({
      kind: 'committed' as const,
      value: begin(new AbortController().signal),
    })),
    recordResult: vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        proofRef: 'jlive_result_1',
      },
    })),
    transferTerminalOwnership: vi.fn(),
    recordCancellationVerified: vi.fn(),
    requestCancellation: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as JarvisIssuedActionExecution;
}

function setup(execution: JarvisIssuedActionExecution) {
  const authority = new WeakSet<object>([execution as object]);
  const broker = createNativeCapabilityBroker({
    verifyIssuedRequest: (candidateRequest, candidateExecution) =>
      authority.has(candidateExecution as object) &&
      candidateRequest.workspaceRoot === 'C:\\workspace',
  });
  broker.register(adapter());
  return broker;
}

describe('native capability broker', () => {
  it('fails closed for unknown operations and adapter replacement', () => {
    const execution = issuedExecution();
    const broker = setup(execution);

    expect(() => broker.inspect(request({ operation: 'file.write' }))).toThrow(/operation/i);
    expect(() => broker.register(adapter())).toThrow(/already registered/i);
  });

  it('rejects structural forgeries and every issued-scope mismatch', async () => {
    const execution = issuedExecution();
    const broker = setup(execution);

    await expect(
      broker.execute(request(), { ...execution } as JarvisIssuedActionExecution),
    ).rejects.toThrow(/issued execution authority/i);
    await expect(broker.execute(request({ accountId: 'account-2' }), execution)).rejects.toThrow(
      /issued execution authority/i,
    );
    await expect(
      broker.execute(request({ parameterHash: 'sha256:fedcba' }), execution),
    ).rejects.toThrow(/issued execution authority/i);
    await expect(broker.execute(request({ capabilityVersion: 2 }), execution)).rejects.toThrow(
      /version/i,
    );
  });

  it('claims one issued execution once and returns only canonical evidence refs', async () => {
    const execution = issuedExecution();
    const execute = vi.fn(async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      return { state: 'completed' as const, resultRef: 'jresult_result_1' as const };
    });
    const authority = new WeakSet<object>([execution as object]);
    const broker = createNativeCapabilityBroker({
      verifyIssuedRequest: (candidateRequest, candidateExecution) =>
        authority.has(candidateExecution as object) &&
        candidateRequest.workspaceRoot === 'C:\\workspace',
    });
    broker.register(adapter(execute));

    await expect(broker.execute(request(), execution)).resolves.toEqual({
      capabilityId: 'file.primary',
      capabilityVersion: 1,
      kind: 'file',
      operation: 'file.read',
      state: 'completed',
      resultRef: 'jresult_result_1',
      evidenceRef: 'jlive_result_1',
    });
    await expect(broker.execute(request(), execution)).rejects.toThrow(/already been claimed/i);
    expect(execution.beginExternalEffect).toHaveBeenCalledTimes(1);
    expect(execution.recordResult).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'completed',
        resultRef: 'jresult_result_1',
      }),
    );
  });

  it('fails closed when authority is revoked and records adapter failures as degraded', async () => {
    const revoked = issuedExecution({
      beginExternalEffect: vi.fn(() => ({
        kind: 'account_authority_revoked' as const,
      })) as JarvisIssuedActionExecution['beginExternalEffect'],
    });
    const revokedBroker = setup(revoked);
    await expect(revokedBroker.execute(request(), revoked)).rejects.toThrow(/revoked/i);

    const failed = issuedExecution();
    const authority = new WeakSet<object>([failed as object]);
    const broker = createNativeCapabilityBroker({
      verifyIssuedRequest: (candidateRequest, candidateExecution) =>
        authority.has(candidateExecution as object) &&
        candidateRequest.workspaceRoot === 'C:\\workspace',
    });
    broker.register(
      adapter(
        vi.fn(async () => {
          throw new Error('secret adapter failure');
        }),
      ),
    );

    await expect(broker.execute(request(), failed)).resolves.toMatchObject({
      state: 'degraded',
      resultRef: 'jresult_native_capability_adapter_error',
      evidenceRef: 'jlive_result_1',
    });
  });

  it('binds the canonical workspace and never records cancellation as completion', async () => {
    const execution = issuedExecution();
    const broker = setup(execution);
    await expect(
      broker.execute(request({ workspaceRoot: 'C:\\other-workspace' }), execution),
    ).rejects.toThrow(/issued execution authority/i);

    const controller = new AbortController();
    const cancelled = issuedExecution({
      beginExternalEffect: vi.fn((begin) => {
        const started = begin(controller.signal);
        controller.abort();
        return { kind: 'committed' as const, value: started };
      }) as JarvisIssuedActionExecution['beginExternalEffect'],
    });
    const cancelledAuthority = new WeakSet<object>([cancelled as object]);
    const cancelledBroker = createNativeCapabilityBroker({
      verifyIssuedRequest: (candidateRequest, candidateExecution) =>
        cancelledAuthority.has(candidateExecution as object) &&
        candidateRequest.workspaceRoot === 'C:\\workspace',
    });
    cancelledBroker.register(
      adapter(
        vi.fn(async ({ signal }): Promise<NativeCapabilityAdapterResult> => {
          await Promise.resolve();
          if (signal.aborted) {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            throw error;
          }
          return { state: 'completed', resultRef: 'jresult_unexpected' };
        }),
      ),
    );

    await expect(cancelledBroker.execute(request(), cancelled)).rejects.toThrow(/cancelled/i);
    expect(cancelled.recordResult).not.toHaveBeenCalled();
  });

  it('never records ordinary completion when a non-cooperative adapter resolves after abort', async () => {
    const controller = new AbortController();
    const cancelled = issuedExecution({
      beginExternalEffect: vi.fn((begin) => {
        const started = begin(controller.signal);
        controller.abort();
        return { kind: 'committed' as const, value: started };
      }) as JarvisIssuedActionExecution['beginExternalEffect'],
    });
    const authority = new WeakSet<object>([cancelled as object]);
    const broker = createNativeCapabilityBroker({
      verifyIssuedRequest: (candidateRequest, candidateExecution) =>
        authority.has(candidateExecution as object) &&
        candidateRequest.workspaceRoot === 'C:\\workspace',
    });
    broker.register(
      adapter(
        vi.fn(async () => {
          await Promise.resolve();
          return {
            state: 'completed' as const,
            resultRef: 'jresult_must_not_commit' as const,
          };
        }),
      ),
    );

    await expect(broker.execute(request(), cancelled)).rejects.toThrow(/cancelled/i);
    expect(cancelled.recordResult).not.toHaveBeenCalled();
  });
});

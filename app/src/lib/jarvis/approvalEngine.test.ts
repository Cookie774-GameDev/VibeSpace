import { describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/actions/types';
import type {
  JarvisApprovalRepository,
  JarvisArtifactRepository,
  JarvisEventRepository,
  JarvisRunRepository,
} from '@/lib/db/jarvisRepositories';
import type { JarvisProviderAttemptEvidenceAuthority } from '@/lib/ai/providerAttemptEvidence';
import type {
  JarvisApprovalV1,
  JarvisAuthorityBoundResult,
  JarvisCanonicalLiveProducerEvidence,
  JarvisCapabilitySnapshot,
  JarvisEntitlementSnapshot,
  JarvisEvent,
  JarvisPreEffectTransportFailureEvidence,
  JarvisRun,
  JarvisTransportAttemptV1,
} from '@/lib/jarvis/contracts';
import {
  createJarvisActionCatalog,
  type JarvisRegisteredActionDefinition,
} from '@/lib/jarvis/actions/catalog';
import type { JarvisRequestAttempt } from '@/lib/jarvis/requestEnvelope';
import {
  createJarvisApprovalBindingSelectors,
  createJarvisActionLiveEvidenceVerifiers,
  createJarvisConsequentialEffectSafetyAuthority,
  createJarvisApprovalEngine,
  JarvisApprovalError,
  jarvisIssuedActionExecutionBrand,
  jarvisIssuedApprovalLifecycleBrand,
  type JarvisIssuedActionExecution,
  type JarvisIssuedApprovalLifecycle,
  type JarvisApprovalEngineDependencies,
} from './approvalEngine';

const now = 10_000;
const expectedNoteEffect =
  'Create one note at the registered target. Target: {"kind":"app_resource","namespace":"notes","resourceId":"hello"}';

function parentRun(overrides: Partial<JarvisRun> = {}): JarvisRun {
  const run: JarvisRun = {
    id: 'jrun_1',
    accountId: 'account-a',
    source: 'typed_chat',
    status: 'running',
    agentId: 'jarvis',
    identityVersion: 1,
    profileRevisionId: 'jprofile_1',
    model: {
      providerId: 'test',
      modelId: 'test-model',
      connectionMode: 'local',
      capabilities: {},
      capturedAt: 1,
    },
    createdAt: 1,
    updatedAt: 2,
  };
  return { ...run, ...overrides };
}

function requestAttempt(): JarvisRequestAttempt {
  return { kind: 'initial', requestId: 'request-1', runId: 'jrun_1', attemptNumber: 1 };
}

function capabilitySnapshot(): JarvisCapabilitySnapshot {
  return {
    capturedAt: 9_000,
    tools: [
      {
        id: 'capability.notes.write',
        state: 'available',
        operations: ['execute'],
        evidenceRef: 'evidence-capability',
        lastVerifiedAt: 9_000,
      },
    ],
    plugins: [],
    mcps: [],
    terminals: [],
    agents: [],
    entitlements: entitlementSnapshot(),
  };
}

function entitlementSnapshot(): JarvisEntitlementSnapshot {
  return {
    source: 'server',
    capabilities: ['entitlement.notes'],
    verifiedAt: 9_000,
    expiresAt: 20_000,
  };
}

function registration(
  overrides: Partial<JarvisRegisteredActionDefinition> = {},
): JarvisRegisteredActionDefinition {
  return {
    id: 'notes.create',
    version: 1,
    title: 'Create note',
    description: 'Creates one note.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
    requiredCapabilities: ['capability.notes.write'],
    requiredEntitlements: ['entitlement.notes'],
    risk: 'safe-write',
    approval: 'always',
    expectedEffect: 'Create one note at the registered target.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'notes.create' },
    credentialBindings: [],
    validateParameters(input) {
      if (
        Object.keys(input).length !== 1 ||
        typeof input.title !== 'string' ||
        !input.title.trim()
      ) {
        throw new Error('invalid');
      }
      return { title: input.title.trim() };
    },
    deriveTarget({ params }) {
      return { kind: 'app_resource', namespace: 'notes', resourceId: String(params.title) };
    },
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<JarvisIssuedApprovalLifecycle> = {},
): JarvisIssuedApprovalLifecycle {
  const revocation = new AbortController();
  return {
    accountId: 'account-a',
    runId: 'jrun_1',
    requestId: 'request-1',
    attemptNumber: 1,
    revocationSignal: revocation.signal,
    [jarvisIssuedApprovalLifecycleBrand]: true,
    putPreparedApproval: vi.fn(),
    decidePreparedApproval: vi.fn(),
    claimApprovedExecution: vi.fn(),
    claimAutoApprovedExecution: vi.fn(),
    dispose: vi.fn(() => revocation.abort()),
    ...overrides,
  };
}

function fixture(actionRegistration: JarvisRegisteredActionDefinition = registration()) {
  const run = parentRun();
  const catalog = createJarvisActionCatalog([actionRegistration]);
  const approvals = new Map<string, JarvisApprovalV1>();
  const runs: Pick<JarvisRunRepository, 'getById'> = {
    getById: vi.fn(async () => structuredClone(run)),
  };
  const approvalRepository: Pick<JarvisApprovalRepository, 'getById' | 'listByRun'> = {
    getById: vi.fn(async (_accountId, approvalId) => {
      const approval = approvals.get(approvalId);
      return approval ? structuredClone(approval) : undefined;
    }),
    listByRun: vi.fn(async () => [...approvals.values()].map((value) => structuredClone(value))),
  };
  const capabilitySnapshots = { getForAccount: vi.fn(async () => capabilitySnapshot()) };
  const entitlementSnapshots = { getForAccount: vi.fn(async () => entitlementSnapshot()) };
  const bindingSelectors = createJarvisApprovalBindingSelectors({
    catalog,
    capabilitySnapshots,
    entitlementSnapshots,
  });
  const executeRegisteredAction = vi.fn(
    async (
      _input: Parameters<JarvisApprovalEngineDependencies['executeRegisteredAction']>[0],
    ): Promise<{ kind: 'executor_returned'; result: ActionResult }> => ({
      kind: 'executor_returned',
      result: { ok: true, summary: 'created' },
    }),
  );
  const secretHandles = {
    validate: vi.fn(async () => ({ valid: true as const })),
    resolveOnce: vi.fn(async () => 'synthetic-unit-test-value'),
  };
  const engine = createJarvisApprovalEngine({
    runs,
    approvals: approvalRepository,
    catalog,
    bindingSelectors,
    secretHandles,
    executeRegisteredAction,
    newApprovalId: () => 'jappr_1',
    now: () => now,
    canonicalizeJson: JSON.stringify,
    hashCanonicalJson: async (value) => `hash:${JSON.stringify(value)}`,
  });

  return {
    run,
    approvals,
    runs,
    approvalRepository,
    capabilitySnapshots,
    entitlementSnapshots,
    executeRegisteredAction,
    secretHandles,
    engine,
  };
}

function expectApprovalError(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(JarvisApprovalError);
  expect((error as JarvisApprovalError).code).toBe(code);
  expect(String((error as Error).message)).not.toContain('synthetic-unit-test-value');
  return true;
}

describe('createJarvisApprovalBindingSelectors', () => {
  it('uses only the registered version and account-scoped providers', async () => {
    const catalog = createJarvisActionCatalog([registration()]);
    const capabilitySnapshots = { getForAccount: vi.fn(async () => capabilitySnapshot()) };
    const entitlementSnapshots = { getForAccount: vi.fn(async () => entitlementSnapshot()) };
    const selectors = createJarvisApprovalBindingSelectors({
      catalog,
      capabilitySnapshots,
      entitlementSnapshots,
    });
    await expect(
      selectors.deriveTargetSnapshot({
        accountId: 'account-a',
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
      }),
    ).resolves.toEqual({ kind: 'app_resource', namespace: 'notes', resourceId: 'hello' });
    expect(capabilitySnapshots.getForAccount).toHaveBeenCalledWith('account-a');
    expect(entitlementSnapshots.getForAccount).toHaveBeenCalledWith('account-a');

    await expect(
      selectors.deriveTargetSnapshot({
        accountId: 'account-a',
        actionId: 'notes.create',
        actionVersion: 2,
        params: { title: 'hello' },
      }),
    ).rejects.toSatisfy((error: unknown) => expectApprovalError(error, 'action_version_changed'));
  });
});

describe('createJarvisApprovalEngine', () => {
  it('derives and submits one non-secret pending approval through the issued lifecycle', async () => {
    const setup = fixture();
    const putPreparedApproval = vi.fn(
      async (input): Promise<JarvisAuthorityBoundResult<JarvisApprovalV1>> => ({
        kind: 'committed',
        value: {
          id: 'jappr_1',
          runId: input.parentRun.id,
          actionId: input.actionId,
          actionVersion: input.actionVersion,
          params: input.params,
          secretHandleRefs: [...input.secretHandleRefs],
          paramsHash: `hash:${JSON.stringify(input.params)}`,
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'notes',
            resourceId: 'hello',
          },
          risk: 'confirm',
          status: 'pending',
          createdAt: now,
          schemaVersion: 1,
          requestId: 'request-1',
          attemptNumber: 1,
          capabilityId: 'capability.notes.write',
          capabilitySnapshotHash: input.parentRun.id.startsWith('jrun_') ? expect.any(String) : '',
          expectedEffect: input.expectedEffect,
          expiresAt: now + 1_000,
        } as unknown as JarvisApprovalV1,
      }),
    );
    const issued = lifecycle({ putPreparedApproval });

    const result = await setup.engine.bindIssuedLifecycle(issued).create({
      parentRun: setup.run,
      attempt: requestAttempt(),
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: ' hello ' },
      expiresAt: now + 1_000,
    });

    expect(result).toMatchObject({
      id: 'jappr_1',
      requestId: 'request-1',
      attemptNumber: 1,
      actionId: 'notes.create',
      params: { title: 'hello' },
      risk: 'confirm',
      capabilityId: 'capability.notes.write',
      expectedEffect: expectedNoteEffect,
    });
    expect(result).not.toHaveProperty('accountId');
    expect(putPreparedApproval).toHaveBeenCalledOnce();
    expect(putPreparedApproval.mock.calls[0]![0]).toMatchObject({
      parentRun: { accountId: 'account-a', id: 'jrun_1' },
      attempt: { requestId: 'request-1', attemptNumber: 1 },
      params: { title: 'hello' },
      secretHandleRefs: [],
    });
  });

  it('rejects raw secret-shaped input before lifecycle mutation', async () => {
    const setup = fixture();
    const putPreparedApproval = vi.fn();
    const capability = setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval }));

    await expect(
      capability.create({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'sk-test-unit-secret' },
        expiresAt: now + 1_000,
      }),
    ).rejects.toSatisfy((error: unknown) => expectApprovalError(error, 'secret_value_rejected'));
    expect(putPreparedApproval).not.toHaveBeenCalled();
  });

  it('rejects undeclared authority-bearing properties at the create boundary', async () => {
    const setup = fixture();
    const putPreparedApproval = vi.fn();
    const capability = setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval }));

    await expect(
      capability.create({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
        credentialLocator: { pluginId: 'foreign', fieldId: 'token' },
      } as never),
    ).rejects.toSatisfy((error: unknown) =>
      expectApprovalError(error, 'caller_secret_resolver_rejected'),
    );
    expect(setup.runs.getById).not.toHaveBeenCalled();
    expect(putPreparedApproval).not.toHaveBeenCalled();
  });

  it('rejects nested cast authority instead of forwarding supplied run or attempt objects', async () => {
    const setup = fixture();
    const putPreparedApproval = vi.fn(async (input) => ({
      kind: 'committed' as const,
      value: input as unknown as JarvisApprovalV1,
    }));
    const capability = setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval }));
    const base = {
      parentRun: setup.run,
      attempt: requestAttempt(),
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'hello' },
      expiresAt: now + 1_000,
    };

    await expect(
      capability.create({
        ...base,
        parentRun: {
          ...setup.run,
          credentialProof: { rawSecret: 'synthetic-unit-test-value' },
        },
      } as never),
    ).rejects.toSatisfy((error: unknown) =>
      expectApprovalError(error, 'caller_secret_resolver_rejected'),
    );
    await expect(
      capability.create({
        ...base,
        attempt: {
          ...requestAttempt(),
          credentialLocator: { pluginId: 'foreign', fieldId: 'token' },
        },
      } as never),
    ).rejects.toSatisfy((error: unknown) =>
      expectApprovalError(error, 'caller_secret_resolver_rejected'),
    );
    expect(putPreparedApproval).not.toHaveBeenCalled();
  });

  it('requires executable operation authority for every required capability', async () => {
    const setup = fixture();
    setup.capabilitySnapshots.getForAccount.mockResolvedValue({
      ...capabilitySnapshot(),
      tools: [
        {
          id: 'capability.notes.write',
          state: 'available',
          operations: ['inspect'],
        },
      ],
    });
    const putPreparedApproval = vi.fn();

    await expect(
      setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval })).create({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
      }),
    ).rejects.toSatisfy((error: unknown) => expectApprovalError(error, 'capability_changed'));
    expect(putPreparedApproval).not.toHaveBeenCalled();
  });

  it('binds human-readable expected effects to the canonical target', async () => {
    const setup = fixture();
    const prepared: Array<{ expectedEffect: string }> = [];
    const putPreparedApproval = vi.fn(async (input) => {
      prepared.push(input);
      return { kind: 'committed' as const, value: input as unknown as JarvisApprovalV1 };
    });
    const capability = setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval }));

    await capability.create({
      parentRun: setup.run,
      attempt: requestAttempt(),
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'first' },
      expiresAt: now + 1_000,
    });
    await capability.create({
      parentRun: setup.run,
      attempt: requestAttempt(),
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'second' },
      expiresAt: now + 1_000,
    });

    expect(prepared[0]!.expectedEffect).toContain('Create one note at the registered target.');
    expect(prepared[0]!.expectedEffect).toContain('first');
    expect(prepared[1]!.expectedEffect).toContain('second');
    expect(prepared[0]!.expectedEffect).not.toBe(prepared[1]!.expectedEffect);
  });

  it('does not forward auto-approval context or cast authority into lifecycle input', async () => {
    const setup = fixture(registration({ risk: 'read-only', approval: 'never' }));
    const claimAutoApprovedExecution = vi.fn(
      async (
        _input: Parameters<JarvisIssuedApprovalLifecycle['claimAutoApprovedExecution']>[0],
      ) => ({ kind: 'account_authority_revoked' as const }),
    );
    const capability = setup.engine.bindIssuedLifecycle(lifecycle({ claimAutoApprovedExecution }));

    await expect(
      capability.executeAutoApprovedSafe({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
        context: {
          source: 'ai',
          authorizationProof: { trusted: true },
        },
      } as never),
    ).rejects.toSatisfy((error: unknown) =>
      expectApprovalError(error, 'caller_secret_resolver_rejected'),
    );
    expect(setup.runs.getById).not.toHaveBeenCalled();
    expect(claimAutoApprovedExecution).not.toHaveBeenCalled();

    await expect(
      capability.executeAutoApprovedSafe({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
        context: {
          source: 'ai',
          chatId: 'chat-1',
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toThrow(/authority|revoked/i);
    expect(claimAutoApprovedExecution).toHaveBeenCalledOnce();
    expect(claimAutoApprovedExecution.mock.calls[0]![0].approval).not.toHaveProperty('context');
  });

  it('fails closed when the current run or lifecycle binding differs', async () => {
    const setup = fixture();
    const foreign = lifecycle({ accountId: 'account-b' });

    await expect(
      setup.engine.bindIssuedLifecycle(foreign).create({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
      }),
    ).rejects.toSatisfy((error: unknown) => expectApprovalError(error, 'run_scope_mismatch'));
  });

  it('revokes a capability immediately when a frozen issued lifecycle is disposed', async () => {
    const setup = fixture();
    const putPreparedApproval = vi.fn(async (input) => ({
      kind: 'committed' as const,
      value: input as unknown as JarvisApprovalV1,
    }));
    const issued = Object.freeze(lifecycle({ putPreparedApproval }));
    const capability = setup.engine.bindIssuedLifecycle(issued);

    issued.dispose();

    await expect(
      capability.create({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
      }),
    ).rejects.toThrow(/authority|revoked/i);
    expect(setup.runs.getById).not.toHaveBeenCalled();
    expect(putPreparedApproval).not.toHaveBeenCalled();
  });

  it('claims before dispatch, records immutable result evidence, and disposes the execution', async () => {
    const setup = fixture();
    const sequence: string[] = [];
    const approval: JarvisApprovalV1 = {
      id: 'jappr_1',
      runId: setup.run.id,
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'hello' },
      secretHandleRefs: [],
      paramsHash: 'hash:{"title":"hello"}',
      targetSnapshot: { kind: 'app_resource', namespace: 'notes', resourceId: 'hello' },
      risk: 'confirm',
      status: 'approved',
      createdAt: now - 100,
      decidedAt: now - 50,
      schemaVersion: 1,
      requestId: 'request-1',
      attemptNumber: 1,
      capabilityId: 'capability.notes.write',
      capabilitySnapshotHash: '',
      expectedEffect: expectedNoteEffect,
      expiresAt: now + 1_000,
    };
    setup.approvals.set(approval.id, approval);

    const recordResult = vi.fn(async () => {
      sequence.push('record-result');
      return { kind: 'committed' as const, value: {} as never };
    });
    const execution: JarvisIssuedActionExecution = {
      approval,
      producerKind: 'action',
      ownerId: 'approval:jappr_1',
      startEvent: {} as never,
      initialLiveProof: {} as never,
      [jarvisIssuedActionExecutionBrand]: true,
      beginExternalEffect: vi.fn(),
      transferTerminalOwnership: vi.fn(),
      recordResult,
      recordCancellationVerified: vi.fn(),
      requestCancellation: vi.fn(),
      dispose: vi.fn(() => sequence.push('dispose')),
    };
    setup.executeRegisteredAction.mockImplementation(async ({ context }) => {
      expect(context).not.toHaveProperty('signal');
      sequence.push('dispatch');
      return { kind: 'executor_returned', result: { ok: true, summary: 'created' } };
    });
    const claimApprovedExecution = vi.fn(async () => {
      sequence.push('claim');
      return { kind: 'committed' as const, value: execution };
    });
    const issued = lifecycle({ claimApprovedExecution });

    // First obtain the exact canonical authorization hash produced by creation.
    const probePut = vi.fn(async (input) => {
      approval.capabilitySnapshotHash = String(input.capabilitySnapshotHash);
      return { kind: 'committed' as const, value: approval };
    });
    await setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval: probePut })).create({
      parentRun: setup.run,
      attempt: requestAttempt(),
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'hello' },
      expiresAt: approval.expiresAt,
    });

    const capability = setup.engine.bindIssuedLifecycle(issued);
    await expect(
      capability.execute({
        parentRun: setup.run,
        approvalId: approval.id,
        context: {
          source: 'ai',
          alternateCredentialResolver: () => 'synthetic-unit-test-value',
        },
      } as never),
    ).rejects.toSatisfy((error: unknown) =>
      expectApprovalError(error, 'caller_secret_resolver_rejected'),
    );
    expect(claimApprovedExecution).not.toHaveBeenCalled();

    setup.capabilitySnapshots.getForAccount.mockResolvedValue({
      ...capabilitySnapshot(),
      tools: [
        {
          id: 'capability.notes.write',
          state: 'available',
          operations: ['inspect'],
        },
      ],
    });
    await expect(
      capability.execute({
        parentRun: setup.run,
        approvalId: approval.id,
        context: { source: 'ai' },
      }),
    ).rejects.toSatisfy((error: unknown) => expectApprovalError(error, 'capability_changed'));
    expect(claimApprovedExecution).not.toHaveBeenCalled();
    setup.capabilitySnapshots.getForAccount.mockResolvedValue(capabilitySnapshot());

    const result = await capability.execute({
      parentRun: setup.run,
      approvalId: approval.id,
      context: { source: 'ai', signal: new AbortController().signal },
    });

    expect(result).toEqual({ kind: 'settled', result: { ok: true, summary: 'created' } });
    expect(sequence).toEqual(['claim', 'dispatch', 'record-result', 'dispose']);
    expect(setup.secretHandles.resolveOnce).not.toHaveBeenCalled();
    expect(claimApprovedExecution).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: approval.id, producerKind: 'action' }),
    );
  });

  it('does not dispatch when the issued lifecycle revokes the claim', async () => {
    const setup = fixture();
    const approval = {
      id: 'jappr_1',
      runId: setup.run.id,
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'hello' },
      secretHandleRefs: [],
      paramsHash: 'hash:{"title":"hello"}',
      targetSnapshot: { kind: 'app_resource', namespace: 'notes', resourceId: 'hello' },
      risk: 'confirm',
      status: 'approved',
      createdAt: now - 100,
      decidedAt: now - 50,
      schemaVersion: 1,
      requestId: 'request-1',
      attemptNumber: 1,
      capabilityId: 'capability.notes.write',
      capabilitySnapshotHash: '',
      expectedEffect: expectedNoteEffect,
      expiresAt: now + 1_000,
    } as JarvisApprovalV1;
    setup.approvals.set(approval.id, approval);

    const probePut = vi.fn(async (input) => {
      approval.capabilitySnapshotHash = String(input.capabilitySnapshotHash);
      return { kind: 'committed' as const, value: approval };
    });
    await setup.engine.bindIssuedLifecycle(lifecycle({ putPreparedApproval: probePut })).create({
      parentRun: setup.run,
      attempt: requestAttempt(),
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'hello' },
      expiresAt: approval.expiresAt,
    });

    await expect(
      setup.engine
        .bindIssuedLifecycle(
          lifecycle({
            claimApprovedExecution: vi.fn(async () => ({
              kind: 'account_authority_revoked' as const,
            })),
          }),
        )
        .execute({
          parentRun: setup.run,
          approvalId: approval.id,
          context: { source: 'ai' },
        }),
    ).rejects.toThrow(/authority/i);
    expect(setup.executeRegisteredAction).not.toHaveBeenCalled();
  });

  it('recovery verifies the same current run, registration, target, and authority binding', async () => {
    const setup = fixture();
    const putPreparedApproval = vi.fn(async (prepared) => {
      const approval = {
        id: prepared.approvalId,
        runId: prepared.parentRun.id,
        actionId: prepared.actionId,
        actionVersion: prepared.actionVersion,
        params: prepared.params,
        secretHandleRefs: prepared.secretHandleRefs,
        paramsHash: prepared.paramsHash,
        targetSnapshot: prepared.targetSnapshot,
        risk: prepared.risk,
        status: 'pending',
        createdAt: prepared.createdAt,
        schemaVersion: 1,
        requestId: prepared.attempt.requestId,
        attemptNumber: prepared.attempt.attemptNumber,
        capabilityId: prepared.capabilityId,
        capabilitySnapshotHash: prepared.capabilitySnapshotHash,
        expectedEffect: prepared.expectedEffect,
        expiresAt: prepared.expiresAt,
      } as JarvisApprovalV1;
      setup.approvals.set(approval.id, approval);
      return { kind: 'committed' as const, value: approval };
    });
    const approval = await setup.engine
      .bindIssuedLifecycle(lifecycle({ putPreparedApproval }))
      .create({
        parentRun: setup.run,
        attempt: requestAttempt(),
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'hello' },
        expiresAt: now + 1_000,
      });
    setup.run.status = 'awaiting_approval';
    setup.run.transportAttempts = [
      {
        schemaVersion: 1,
        attemptNumber: 1,
        kind: 'initial',
        requestId: 'request-1',
        state: 'provider_in_flight',
        startedEventSeq: 1,
        effectBarrier: { state: 'dirty', version: 1, updatedAt: now - 10 },
        createdAt: now - 100,
        updatedAt: now - 10,
      },
    ];
    const events = [
      {
        runId: setup.run.id,
        seq: 2,
        idempotencyKey: approval.id,
        type: 'approval' as const,
        status: 'pending',
        title: 'Approval required',
        safeSummary: 'Review the registered action before it runs.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: now - 10,
      },
    ];

    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: structuredClone(setup.run),
        events,
      }),
    ).resolves.toEqual({ valid: true, approvalId: approval.id });

    const canonicalAwaitingRun = structuredClone(setup.run);
    setup.run.status = 'completed';
    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: canonicalAwaitingRun,
        events,
      }),
    ).resolves.toEqual({ valid: false, reason: 'approval_binding_mismatch' });
    setup.run.status = 'awaiting_approval';

    const staleAttemptRun = structuredClone(setup.run);
    const canonicalAttempts = setup.run.transportAttempts!;
    setup.run.transportAttempts = [
      ...canonicalAttempts,
      {
        ...setup.run.transportAttempts![0]!,
        attemptNumber: 2,
        requestId: 'request-2',
        startedEventSeq: 3,
        createdAt: now - 5,
        updatedAt: now - 5,
      },
    ];
    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: staleAttemptRun,
        events,
      }),
    ).resolves.toEqual({ valid: false, reason: 'approval_binding_mismatch' });
    setup.run.transportAttempts = canonicalAttempts;

    setup.capabilitySnapshots.getForAccount.mockResolvedValue({
      ...capabilitySnapshot(),
      tools: [
        {
          id: 'capability.notes.write',
          state: 'available',
          operations: ['inspect'],
        },
      ],
    });
    const decidePreparedApproval = vi.fn();
    await expect(
      setup.engine.bindIssuedLifecycle(lifecycle({ decidePreparedApproval })).decide({
        parentRun: setup.run,
        approvalId: approval.id,
        decision: 'approve',
      }),
    ).rejects.toSatisfy((error: unknown) => expectApprovalError(error, 'capability_changed'));
    expect(decidePreparedApproval).not.toHaveBeenCalled();
    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: structuredClone(setup.run),
        events,
      }),
    ).resolves.toEqual({ valid: false, reason: 'approval_binding_mismatch' });
    setup.capabilitySnapshots.getForAccount.mockResolvedValue(capabilitySnapshot());

    const currentAttempts = setup.run.transportAttempts;
    setup.run.transportAttempts = undefined;
    const providerIdentity = {
      producerKind: 'provider' as const,
      providerId: setup.run.model.providerId,
      modelId: setup.run.model.modelId,
      modelSnapshotRef: `${setup.run.model.providerId}:${setup.run.model.modelId}`,
    };
    const responseBackedEvents = [
      {
        runId: setup.run.id,
        seq: 1,
        idempotencyKey: 'provider-start-request-1',
        type: 'model' as const,
        status: 'started',
        title: 'Provider started',
        safeSummary: 'The protected provider request started.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: now - 20,
        producerSourceEvidence: {
          schemaVersion: 1 as const,
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: approval.requestId,
          attemptNumber: approval.attemptNumber,
          producerKind: 'provider' as const,
          producerIdentity: providerIdentity,
          resultRef: 'provider-start-result-ref',
          observedAt: now - 20,
          phase: 'start' as const,
          state: 'started' as const,
        },
      },
      {
        runId: setup.run.id,
        seq: 2,
        idempotencyKey: 'provider-result-request-1',
        type: 'model' as const,
        status: 'completed',
        title: 'Provider completed',
        safeSummary: 'The protected provider request completed.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: now - 10,
        producerSourceEvidence: {
          schemaVersion: 1 as const,
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: approval.requestId,
          attemptNumber: approval.attemptNumber,
          producerKind: 'provider' as const,
          producerIdentity: providerIdentity,
          resultRef: 'provider-completed-result-ref',
          observedAt: now - 10,
          phase: 'result' as const,
          state: 'completed' as const,
        },
      },
      { ...events[0]!, seq: 3 },
    ];
    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: structuredClone(setup.run),
        events: responseBackedEvents,
      }),
    ).resolves.toEqual({ valid: true, approvalId: approval.id });
    for (const invalidEvents of [
      responseBackedEvents.filter((event) => event.producerSourceEvidence?.phase !== 'result'),
      responseBackedEvents.map((event) =>
        event.producerSourceEvidence?.phase === 'result'
          ? {
              ...event,
              producerSourceEvidence: { ...event.producerSourceEvidence, state: 'degraded' },
            }
          : event,
      ),
      [...responseBackedEvents, { ...responseBackedEvents[1]!, seq: 4 }],
      responseBackedEvents.map((event) =>
        event.producerSourceEvidence?.phase === 'result'
          ? {
              ...event,
              producerSourceEvidence: {
                ...event.producerSourceEvidence,
                requestId: 'request-stale',
              },
            }
          : event,
      ),
      responseBackedEvents.map((event) =>
        event.producerSourceEvidence?.phase === 'result'
          ? {
              ...event,
              producerSourceEvidence: {
                ...event.producerSourceEvidence,
                attemptNumber: 2,
              },
            }
          : event,
      ),
      responseBackedEvents.map((event) =>
        event.producerSourceEvidence?.phase === 'result'
          ? {
              ...event,
              producerSourceEvidence: {
                ...event.producerSourceEvidence,
                accountId: 'account-foreign',
              },
            }
          : event,
      ),
      responseBackedEvents.map((event) =>
        event.producerSourceEvidence?.phase === 'result'
          ? {
              ...event,
              producerSourceEvidence: {
                ...event.producerSourceEvidence,
                runId: 'jrun_foreign',
              },
            }
          : event,
      ),
    ]) {
      await expect(
        setup.engine.recoveryVerifier.verifyPendingApproval({
          accountId: 'account-a',
          run: structuredClone(setup.run),
          events: invalidEvents as never,
        }),
      ).resolves.toEqual({ valid: false, reason: 'approval_binding_mismatch' });
    }
    setup.run.transportAttempts = currentAttempts;

    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: structuredClone(setup.run),
        events: events.map((event) => ({ ...event, runId: 'jrun_foreign' })),
      }),
    ).resolves.toEqual({ valid: false, reason: 'approval_missing' });

    approval.targetSnapshot = {
      kind: 'app_resource',
      namespace: 'notes',
      resourceId: 'different',
    };
    await expect(
      setup.engine.recoveryVerifier.verifyPendingApproval({
        accountId: 'account-a',
        run: structuredClone(setup.run),
        events,
      }),
    ).resolves.toEqual({ valid: false, reason: 'approval_binding_mismatch' });
  });
});

describe('createJarvisConsequentialEffectSafetyAuthority', () => {
  function scheduledFixture(now: () => number = () => 10_000) {
    const attempt: JarvisTransportAttemptV1 = {
      schemaVersion: 1,
      attemptNumber: 1,
      kind: 'initial',
      requestId: 'request-1',
      state: 'provider_in_flight',
      startedEventSeq: 3,
      effectBarrier: { state: 'open', version: 0, updatedAt: 9_000 },
      createdAt: 9_000,
      updatedAt: 9_000,
    };
    const run = parentRun({
      source: 'schedule',
      transportAttempts: [attempt],
      scheduledRetrySnapshot: {
        schemaVersion: 1,
        accountId: 'account-a',
        eventId: 'schedule-event-1',
        occurrenceId: 'jocc_schedule-occurrence-1',
        dueAt: 8_500,
        logicalAttempt: 0,
        request: {} as NonNullable<JarvisRun['scheduledRetrySnapshot']>['request'],
      },
      model: {
        providerId: 'provider-a',
        modelId: 'model-a',
        connectionMode: 'native-api',
        capabilities: {},
        capturedAt: 8_000,
      },
    });
    const providerFailure: JarvisPreEffectTransportFailureEvidence = {
      schemaVersion: 1,
      accountId: run.accountId,
      runId: run.id,
      requestId: attempt.requestId,
      attemptNumber: attempt.attemptNumber,
      providerId: run.model.providerId,
      modelId: run.model.modelId,
      boundary: 'before_first_response_byte',
      responseStarted: false,
      chunkCount: 0,
      actionDispatchCount: 0,
      failureCategory: 'transport_unavailable',
      evidenceRef: 'provider-failure-1',
      verifiedAt: 9_500,
    };
    const approvals: Pick<JarvisApprovalRepository, 'listByRun'> = {
      listByRun: vi.fn(async () => []),
    };
    const artifacts: Pick<JarvisArtifactRepository, 'listByRun'> = {
      listByRun: vi.fn(async () => []),
    };
    const events: Pick<JarvisEventRepository, 'listByRun'> = {
      listByRun: vi.fn(async () => [
        {
          runId: run.id,
          seq: 4,
          idempotencyKey: 'warning-1',
          type: 'warning' as const,
          title: 'Provider unavailable',
          safeSummary: 'The provider did not start a response.',
          sourceRefs: [],
          artifactIds: [],
          createdAt: 9_600,
        },
      ]),
    };
    const providerAttemptEvidence: Pick<
      JarvisProviderAttemptEvidenceAuthority,
      'revalidateFailure'
    > = {
      revalidateFailure: vi.fn(async () => structuredClone(providerFailure)),
    };
    const authority = createJarvisConsequentialEffectSafetyAuthority({
      approvals: approvals as JarvisApprovalRepository,
      artifacts: artifacts as JarvisArtifactRepository,
      events: events as JarvisEventRepository,
      providerAttemptEvidence,
      now,
    });
    return {
      run,
      attempt,
      providerFailure,
      approvals,
      artifacts,
      events,
      providerAttemptEvidence,
      authority,
    };
  }

  function exactProviderStartRows(
    setup: ReturnType<typeof scheduledFixture>,
    firstSeq = 4,
  ): JarvisEvent[] {
    const providerStartRef = `jprovider_start_${setup.attempt.requestId}`;
    const modelSnapshotRef = `jmodel_${setup.run.model.providerId}_${setup.run.model.modelId}_${setup.run.model.capturedAt}`;
    return [
      {
        runId: setup.run.id,
        seq: firstSeq,
        idempotencyKey: `kernel-provider-start:${setup.attempt.requestId}:${setup.attempt.attemptNumber}`,
        type: 'model',
        status: 'started',
        title: 'Provider started',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_200,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider',
            providerId: setup.run.model.providerId,
            modelId: setup.run.model.modelId,
            modelSnapshotRef,
          },
          phase: 'start',
          state: 'started',
          resultRef: providerStartRef,
          observedAt: 9_200,
        },
      },
      {
        runId: setup.run.id,
        seq: firstSeq + 1,
        idempotencyKey: `kernel-live:${setup.run.id}:provider:started:${providerStartRef}`,
        type: 'model',
        status: 'started',
        title: 'Provider evidence updated',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_200,
        liveEvidence: {
          schemaVersion: 1,
          kind: 'model',
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          registrationId: `${setup.run.id}:provider`,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider',
            providerId: setup.run.model.providerId,
            modelId: setup.run.model.modelId,
            modelSnapshotRef,
          },
          transition: 'started',
          operations: ['generate'],
          resultRef: providerStartRef,
          resultEventSeq: firstSeq,
          observedAt: 9_200,
          providerId: setup.run.model.providerId,
          modelId: setup.run.model.modelId,
          modelSnapshotRef,
        },
      },
    ];
  }

  function scheduleBusyRow(setup: ReturnType<typeof scheduledFixture>, seq = 4): JarvisEvent {
    return {
      runId: setup.run.id,
      seq,
      idempotencyKey: `kernel-live:${setup.run.id}:schedule:${setup.attempt.attemptNumber}:busy`,
      type: 'tool',
      status: 'busy',
      title: 'Schedule evidence updated',
      sourceRefs: [],
      artifactIds: [],
      createdAt: 9_100,
      liveEvidence: {
        schemaVersion: 1,
        kind: 'capability',
        category: 'agent',
        capabilityId: 'schedule.dispatch',
        accountId: setup.run.accountId,
        runId: setup.run.id,
        requestId: setup.attempt.requestId,
        attemptNumber: setup.attempt.attemptNumber,
        registrationId: `${setup.run.id}:schedule:${setup.attempt.attemptNumber}`,
        producerKind: 'schedule',
        producerIdentity: {
          producerKind: 'schedule',
          eventId: setup.run.scheduledRetrySnapshot!.eventId,
          occurrenceId: setup.run.scheduledRetrySnapshot!.occurrenceId,
        },
        transition: 'busy',
        operations: ['execute', 'cancel', 'inspect'],
        resultRef: `jstart_${setup.run.id}_${setup.attempt.requestId}_${setup.attempt.attemptNumber}`,
        resultEventSeq: setup.attempt.startedEventSeq,
        observedAt: 9_100,
      },
    };
  }

  function settledScheduleRows(
    setup: ReturnType<typeof scheduledFixture>,
    firstSeq: number,
  ): JarvisEvent[] {
    const resultRef =
      `jresult_${setup.run.id}_${setup.attempt.requestId}_${setup.attempt.attemptNumber}_transport` as const;
    return [
      {
        runId: setup.run.id,
        seq: firstSeq,
        idempotencyKey: `jtransport:${setup.run.id}:${setup.attempt.requestId}:${setup.attempt.attemptNumber}:retry_available`,
        type: 'warning',
        status: 'transport_retry_available',
        title: 'Scheduled transport retry available',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        canonicalResultEvidence: {
          schemaVersion: 1,
          kind: 'scheduled_transport_settled',
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          state: 'degraded',
          resultRef,
          observedAt: 9_500,
        },
      },
      {
        runId: setup.run.id,
        seq: firstSeq + 1,
        idempotencyKey: `schedule:${setup.run.id}:${setup.attempt.requestId}:${setup.attempt.attemptNumber}:result`,
        type: 'tool',
        status: 'degraded',
        title: 'Scheduled dispatch result linked',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: setup.run.scheduledRetrySnapshot!.eventId,
            occurrenceId: setup.run.scheduledRetrySnapshot!.occurrenceId,
          },
          resultRef,
          observedAt: 9_500,
          phase: 'result',
          state: 'degraded',
          resultAuthority: {
            runId: setup.run.id,
            eventSeq: firstSeq,
            evidenceRef: resultRef,
          },
        },
      },
      {
        runId: setup.run.id,
        seq: firstSeq + 2,
        idempotencyKey: `kernel-live:${setup.run.id}:schedule:${setup.attempt.attemptNumber}:degraded`,
        type: 'tool',
        status: 'degraded',
        title: 'Schedule evidence updated',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        liveEvidence: {
          schemaVersion: 1,
          kind: 'capability',
          category: 'agent',
          capabilityId: 'schedule.dispatch',
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          registrationId: `${setup.run.id}:schedule:${setup.attempt.attemptNumber}`,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: setup.run.scheduledRetrySnapshot!.eventId,
            occurrenceId: setup.run.scheduledRetrySnapshot!.occurrenceId,
          },
          transition: 'degraded',
          operations: ['execute', 'cancel', 'inspect'],
          resultRef,
          resultEventSeq: firstSeq + 1,
          observedAt: 9_500,
          previousProofRef: 'jlive_schedule_started',
        },
      },
    ];
  }

  it('proves only exact pre-byte failure plus a complete zero-effect journal tail', async () => {
    const setup = scheduledFixture();

    const proof = await setup.authority.proveZeroConsequentialEffect({
      run: setup.run,
      attempt: setup.attempt,
      providerFailure: setup.providerFailure,
    });

    expect(proof).toEqual({
      schemaVersion: 1,
      accountId: 'account-a',
      runId: 'jrun_1',
      requestId: 'request-1',
      attemptNumber: 1,
      assessedAt: 10_000,
      providerBoundary: setup.providerFailure,
      effectBarrier: { state: 'open', version: 0 },
      approvals: { count: 0, evidenceRef: 'approvals-zero:jrun_1:request-1:1' },
      artifacts: { count: 0, evidenceRef: 'artifacts-zero:jrun_1:request-1:1' },
      executorClaims: { count: 0, throughSeq: 4, evidenceRef: 'claims-zero:jrun_1:4' },
    });
    expect(setup.providerAttemptEvidence.revalidateFailure).toHaveBeenCalledWith({
      evidence: setup.providerFailure,
      accountId: 'account-a',
      runId: 'jrun_1',
      requestId: 'request-1',
      attemptNumber: 1,
      providerId: 'provider-a',
      modelId: 'model-a',
    });
    expect(setup.approvals.listByRun).toHaveBeenCalledWith('account-a', 'jrun_1', {
      requestId: 'request-1',
      attemptNumber: 1,
      limit: 1,
    });
    expect(setup.artifacts.listByRun).toHaveBeenCalledWith('account-a', 'jrun_1', 1);
    expect(setup.events.listByRun).toHaveBeenCalledWith('account-a', 'jrun_1', {
      afterSeq: 3,
      limit: 500,
    });
  });

  it('denies any effect claim, binding drift, or inconclusive bounded tail', async () => {
    const setup = scheduledFixture();
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'claim-1',
        type: 'tool',
        title: 'Action claimed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600,
        executionEvidence: {
          schemaVersion: 1,
          requestId: 'request-1',
          attemptNumber: 1,
          kind: 'consequential_effect_claimed',
          ownerKind: 'action',
          ownerId: 'execution-1',
          evidenceRef: 'claim-evidence-1',
          observedAt: 9_600,
        },
      },
    ]);
    await expect(
      setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      }),
    ).resolves.toBeNull();

    vi.mocked(setup.providerAttemptEvidence.revalidateFailure).mockResolvedValueOnce(null);
    await expect(
      setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      }),
    ).resolves.toBeNull();

    vi.mocked(setup.providerAttemptEvidence.revalidateFailure).mockResolvedValueOnce(
      setup.providerFailure,
    );
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, index) => ({
        runId: setup.run.id,
        seq: index + 4,
        idempotencyKey: `warning-${index}`,
        type: 'warning' as const,
        title: 'Bounded event',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600 + index,
      })),
    );
    await expect(
      setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      }),
    ).resolves.toBeNull();
  });

  it('denies response and action observations even when no effect claim is present', async () => {
    const setup = scheduledFixture();
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'action-observation-1',
        type: 'tool',
        status: 'running',
        title: 'Action observed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          producerKind: 'action',
          producerIdentity: {
            producerKind: 'action',
            actionId: 'notes.create',
            actionVersion: 1,
            executionId: 'execution-1',
          },
          phase: 'start',
          state: 'busy',
          resultRef: 'action-observation-1',
          observedAt: 9_600,
        },
      },
    ]);
    await expect(
      setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      }),
    ).resolves.toBeNull();

    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'provider-result-1',
        type: 'model',
        status: 'completed',
        title: 'Provider result observed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600,
        canonicalResultEvidence: {
          schemaVersion: 1,
          kind: 'scheduled_transport_settled',
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          state: 'completed',
          resultRef: 'jresult_provider_1',
          observedAt: 9_600,
        },
      },
    ]);
    await expect(
      setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      }),
    ).resolves.toBeNull();
  });

  it('revalidates from the stored complete tail and denies a newly observed approval', async () => {
    const setup = scheduledFixture();
    const proof = await setup.authority.proveZeroConsequentialEffect({
      run: setup.run,
      attempt: setup.attempt,
      providerFailure: setup.providerFailure,
    });
    expect(proof).not.toBeNull();
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'warning-1',
        type: 'warning',
        title: 'Provider unavailable',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600,
      },
    ]);

    const revalidated = await setup.authority.revalidateZeroConsequentialEffect({
      run: setup.run,
      attempt: setup.attempt,
      evidence: proof!,
    });

    expect(revalidated?.executorClaims.throughSeq).toBe(4);
    expect(setup.events.listByRun).toHaveBeenLastCalledWith('account-a', 'jrun_1', {
      afterSeq: 3,
      limit: 500,
    });

    vi.mocked(setup.approvals.listByRun).mockResolvedValueOnce([{} as JarvisApprovalV1]);
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'warning-1',
        type: 'warning',
        title: 'Provider unavailable',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600,
      },
    ]);
    await expect(
      setup.authority.revalidateZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        evidence: revalidated!,
      }),
    ).resolves.toBeNull();
  });

  it('accepts only the exact pre-byte provider start source and linked live evidence', async () => {
    const setup = scheduledFixture();
    const providerRows = [scheduleBusyRow(setup), ...exactProviderStartRows(setup, 5)];
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce(providerRows);

    await expect(
      setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      }),
    ).resolves.toMatchObject({
      executorClaims: { count: 0, throughSeq: 6, evidenceRef: 'claims-zero:jrun_1:6' },
    });

    const mutations: Array<[string, (rows: JarvisEvent[]) => void]> = [
      [
        'provider',
        (rows) => {
          const source = rows[1]!.producerSourceEvidence!;
          rows[1]!.producerSourceEvidence = {
            ...source,
            producerIdentity: { ...source.producerIdentity, providerId: 'provider-forged' },
          } as never;
        },
      ],
      [
        'model',
        (rows) => {
          const live = rows[2]!.liveEvidence!;
          rows[2]!.liveEvidence = {
            ...live,
            producerIdentity: { ...live.producerIdentity, modelId: 'model-forged' },
          } as never;
        },
      ],
      [
        'snapshot',
        (rows) => {
          rows[2]!.liveEvidence = {
            ...rows[2]!.liveEvidence!,
            modelSnapshotRef: 'jmodel_forged',
          } as never;
        },
      ],
      [
        'reference',
        (rows) => {
          rows[1]!.producerSourceEvidence = {
            ...rows[1]!.producerSourceEvidence!,
            resultRef: 'jprovider_start_forged',
          };
        },
      ],
      [
        'observed time',
        (rows) => {
          rows[2]!.liveEvidence = { ...rows[2]!.liveEvidence!, observedAt: 9_201 };
        },
      ],
      [
        'schema',
        (rows) => {
          rows[1]!.producerSourceEvidence = {
            ...rows[1]!.producerSourceEvidence!,
            schemaVersion: 2,
          } as never;
        },
      ],
      [
        'conflicting evidence',
        (rows) => {
          rows[1]!.executionEvidence = {
            schemaVersion: 1,
            requestId: setup.attempt.requestId,
            attemptNumber: setup.attempt.attemptNumber,
            kind: 'consequential_effect_claimed',
            ownerKind: 'action',
            ownerId: 'forged-owner',
            evidenceRef: 'forged-claim',
            observedAt: 9_200,
          };
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const forgedRows = structuredClone(providerRows);
      mutate(forgedRows);
      vi.mocked(setup.events.listByRun).mockResolvedValueOnce(forgedRows);
      await expect(
        setup.authority.proveZeroConsequentialEffect({
          run: setup.run,
          attempt: setup.attempt,
          providerFailure: setup.providerFailure,
        }),
        label,
      ).resolves.toBeNull();
    }
  });

  it('revalidates the exact non-consequential schedule lifecycle through the latest journal tail', async () => {
    let now = 10_000;
    const setup = scheduledFixture(() => now++);
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'schedule-live-busy',
        type: 'tool',
        status: 'busy',
        title: 'Schedule evidence updated',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_100,
        liveEvidence: {
          schemaVersion: 1,
          kind: 'capability',
          category: 'agent',
          capabilityId: 'schedule.dispatch',
          accountId: setup.run.accountId,
          runId: setup.run.id,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          registrationId: `${setup.run.id}:schedule:1`,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: 'schedule-event-1',
            occurrenceId: 'jocc_schedule-occurrence-1',
          },
          transition: 'busy',
          operations: ['execute', 'cancel', 'inspect'],
          resultRef: `jstart_${setup.run.id}_${setup.attempt.requestId}_1`,
          resultEventSeq: setup.attempt.startedEventSeq,
          observedAt: 9_100,
        },
      },
    ]);
    const proof = await setup.authority.proveZeroConsequentialEffect({
      run: setup.run,
      attempt: setup.attempt,
      providerFailure: setup.providerFailure,
    });
    expect(proof).not.toBeNull();

    const retryableAttempt: JarvisTransportAttemptV1 = {
      ...setup.attempt,
      state: 'retryable_failed',
      failureCategory: setup.providerFailure.failureCategory,
      zeroEffectEvidence: proof!,
      updatedAt: 9_500,
    };
    const retryableRun: JarvisRun = {
      ...setup.run,
      transportAttempts: [retryableAttempt],
      updatedAt: 9_500,
    };
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: retryableRun.id,
        seq: 4,
        idempotencyKey: 'schedule-live-busy',
        type: 'tool',
        status: 'busy',
        title: 'Schedule evidence updated',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_100,
        liveEvidence: {
          schemaVersion: 1,
          kind: 'capability',
          category: 'agent',
          capabilityId: 'schedule.dispatch',
          accountId: retryableRun.accountId,
          runId: retryableRun.id,
          requestId: retryableAttempt.requestId,
          attemptNumber: retryableAttempt.attemptNumber,
          registrationId: `${retryableRun.id}:schedule:1`,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: 'schedule-event-1',
            occurrenceId: 'jocc_schedule-occurrence-1',
          },
          transition: 'busy',
          operations: ['execute', 'cancel', 'inspect'],
          resultRef: `jstart_${retryableRun.id}_${retryableAttempt.requestId}_1`,
          resultEventSeq: retryableAttempt.startedEventSeq,
          observedAt: 9_100,
        },
      },
      {
        runId: retryableRun.id,
        seq: 5,
        idempotencyKey: `jtransport:${retryableRun.id}:${retryableAttempt.requestId}:1:retry_available`,
        type: 'warning',
        status: 'transport_retry_available',
        title: 'Scheduled transport retry available',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        canonicalResultEvidence: {
          schemaVersion: 1,
          kind: 'scheduled_transport_settled',
          accountId: retryableRun.accountId,
          runId: retryableRun.id,
          requestId: retryableAttempt.requestId,
          attemptNumber: retryableAttempt.attemptNumber,
          state: 'degraded',
          resultRef: `jresult_${retryableRun.id}_${retryableAttempt.requestId}_1_transport`,
          observedAt: 9_500,
        },
      },
      {
        runId: retryableRun.id,
        seq: 6,
        idempotencyKey: `schedule:${retryableRun.id}:${retryableAttempt.requestId}:1:result`,
        type: 'tool',
        status: 'degraded',
        title: 'Scheduled dispatch result linked',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: retryableRun.accountId,
          runId: retryableRun.id,
          requestId: retryableAttempt.requestId,
          attemptNumber: retryableAttempt.attemptNumber,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: 'schedule-event-1',
            occurrenceId: 'jocc_schedule-occurrence-1',
          },
          resultRef: `jresult_${retryableRun.id}_${retryableAttempt.requestId}_1_transport`,
          observedAt: 9_500,
          phase: 'result',
          state: 'degraded',
          resultAuthority: {
            runId: retryableRun.id,
            eventSeq: 5,
            evidenceRef: `jresult_${retryableRun.id}_${retryableAttempt.requestId}_1_transport`,
          },
        },
      },
      {
        runId: retryableRun.id,
        seq: 7,
        idempotencyKey: 'schedule-live-degraded',
        type: 'tool',
        status: 'degraded',
        title: 'Schedule evidence updated',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        liveEvidence: {
          schemaVersion: 1,
          kind: 'capability',
          category: 'agent',
          capabilityId: 'schedule.dispatch',
          accountId: retryableRun.accountId,
          runId: retryableRun.id,
          requestId: retryableAttempt.requestId,
          attemptNumber: retryableAttempt.attemptNumber,
          registrationId: `${retryableRun.id}:schedule:1`,
          producerKind: 'schedule',
          producerIdentity: {
            producerKind: 'schedule',
            eventId: 'schedule-event-1',
            occurrenceId: 'jocc_schedule-occurrence-1',
          },
          transition: 'degraded',
          operations: ['execute', 'cancel', 'inspect'],
          resultRef: `jresult_${retryableRun.id}_${retryableAttempt.requestId}_1_transport`,
          resultEventSeq: 6,
          observedAt: 9_500,
          previousProofRef: 'jlive_schedule_started',
        },
      },
    ]);

    const revalidated = await setup.authority.revalidateZeroConsequentialEffect({
      run: retryableRun,
      attempt: retryableAttempt,
      evidence: proof!,
    });

    expect(revalidated).toMatchObject({
      assessedAt: 10_001,
      executorClaims: {
        count: 0,
        throughSeq: 7,
        evidenceRef: `claims-zero:${retryableRun.id}:7`,
      },
    });
  });

  it.each(['duplicate schedule transition', 'provider activity after settlement'] as const)(
    'rejects %s',
    async (scenario) => {
      const setup = scheduledFixture();
      vi.mocked(setup.events.listByRun).mockResolvedValueOnce([scheduleBusyRow(setup)]);
      const proof = await setup.authority.proveZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        providerFailure: setup.providerFailure,
      });
      expect(proof).not.toBeNull();
      const retryableAttempt: JarvisTransportAttemptV1 = {
        ...setup.attempt,
        state: 'retryable_failed',
        failureCategory: setup.providerFailure.failureCategory,
        zeroEffectEvidence: proof!,
        updatedAt: 9_500,
      };
      const retryableRun: JarvisRun = {
        ...setup.run,
        transportAttempts: [retryableAttempt],
        updatedAt: 9_500,
      };
      const duplicateBusy = scheduleBusyRow(setup, 5);
      duplicateBusy.idempotencyKey += ':duplicate';
      const rows =
        scenario === 'duplicate schedule transition'
          ? [scheduleBusyRow(setup), duplicateBusy, ...settledScheduleRows(setup, 6)]
          : [
              scheduleBusyRow(setup),
              settledScheduleRows(setup, 5)[0]!,
              ...exactProviderStartRows(setup, 6),
              {
                ...settledScheduleRows(setup, 5)[1]!,
                seq: 8,
              },
              {
                ...settledScheduleRows(setup, 5)[2]!,
                seq: 9,
                liveEvidence: {
                  ...settledScheduleRows(setup, 5)[2]!.liveEvidence!,
                  resultEventSeq: 8,
                },
              },
            ];
      vi.mocked(setup.events.listByRun).mockResolvedValueOnce(rows);
      await expect(
        setup.authority.revalidateZeroConsequentialEffect({
          run: retryableRun,
          attempt: retryableAttempt,
          evidence: proof!,
        }),
      ).resolves.toBeNull();
    },
  );

  it('rejects forged future checkpoints and re-scans the complete proof prefix', async () => {
    const setup = scheduledFixture();
    const proof = await setup.authority.proveZeroConsequentialEffect({
      run: setup.run,
      attempt: setup.attempt,
      providerFailure: setup.providerFailure,
    });
    expect(proof).not.toBeNull();

    const forged = {
      ...proof!,
      executorClaims: {
        ...proof!.executorClaims,
        throughSeq: 400,
        evidenceRef: `claims-zero:${setup.run.id}:400`,
      },
    };
    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([]);
    await expect(
      setup.authority.revalidateZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        evidence: forged,
      }),
    ).resolves.toBeNull();
    expect(setup.events.listByRun).toHaveBeenLastCalledWith('account-a', 'jrun_1', {
      afterSeq: setup.attempt.startedEventSeq,
      limit: 500,
    });

    vi.mocked(setup.events.listByRun).mockResolvedValueOnce([
      {
        runId: setup.run.id,
        seq: 4,
        idempotencyKey: 'hidden-claim',
        type: 'tool',
        title: 'Hidden action claim',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_600,
        executionEvidence: {
          schemaVersion: 1,
          requestId: setup.attempt.requestId,
          attemptNumber: setup.attempt.attemptNumber,
          kind: 'consequential_effect_claimed',
          ownerKind: 'action',
          ownerId: 'execution-hidden',
          evidenceRef: 'claim-hidden',
          observedAt: 9_600,
        },
      },
    ]);
    await expect(
      setup.authority.revalidateZeroConsequentialEffect({
        run: setup.run,
        attempt: setup.attempt,
        evidence: proof!,
      }),
    ).resolves.toBeNull();
  });
});

describe('createJarvisActionLiveEvidenceVerifiers', () => {
  it('accepts only the exact durable action claim/result source pair', async () => {
    const attempt: JarvisTransportAttemptV1 = {
      schemaVersion: 1,
      attemptNumber: 1,
      kind: 'initial',
      requestId: 'request-1',
      state: 'completed',
      startedEventSeq: 1,
      effectBarrier: { state: 'dirty', version: 1, updatedAt: 9_000 },
      createdAt: 8_000,
      updatedAt: 9_000,
    };
    const run = parentRun({ transportAttempts: [attempt] });
    const producerIdentity = {
      producerKind: 'action' as const,
      actionId: 'notes.create',
      actionVersion: 1,
      executionId: 'execution-1',
    };
    const events: JarvisEvent[] = [
      {
        runId: run.id,
        seq: 2,
        idempotencyKey: 'claim-1',
        type: 'tool',
        status: 'running',
        title: 'Action started',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_000,
        executionEvidence: {
          schemaVersion: 1,
          requestId: 'request-1',
          attemptNumber: 1,
          kind: 'consequential_effect_claimed',
          ownerKind: 'action',
          ownerId: 'execution-1',
          evidenceRef: 'effect-claim-1',
          observedAt: 9_000,
        },
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: 'account-a',
          runId: run.id,
          requestId: 'request-1',
          attemptNumber: 1,
          producerKind: 'action',
          producerIdentity,
          phase: 'start',
          state: 'busy',
          resultRef: 'effect-claim-1',
          observedAt: 9_000,
        },
      },
      {
        runId: run.id,
        seq: 3,
        idempotencyKey: 'result-1',
        type: 'tool',
        status: 'completed',
        title: 'Action completed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        executionEvidence: {
          schemaVersion: 1,
          requestId: 'request-1',
          attemptNumber: 1,
          kind: 'consequential_effect_completed',
          ownerKind: 'action',
          ownerId: 'execution-1',
          evidenceRef: 'jresult_action_1',
          observedAt: 9_500,
        },
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: 'account-a',
          runId: run.id,
          requestId: 'request-1',
          attemptNumber: 1,
          producerKind: 'action',
          producerIdentity,
          phase: 'result',
          state: 'completed',
          resultRef: 'jresult_action_1',
          observedAt: 9_500,
        },
      },
    ];
    const runRepository: Pick<JarvisRunRepository, 'getById'> = {
      getById: vi.fn(async () => structuredClone(run)),
    };
    const eventRepository: Pick<JarvisEventRepository, 'listByRun' | 'getBySeq'> = {
      listByRun: vi.fn(async () => structuredClone(events)),
      getBySeq: vi.fn(async (_accountId, _runId, seq) =>
        structuredClone(events.find((event) => event.seq === seq)),
      ),
    };
    const verifiers = createJarvisActionLiveEvidenceVerifiers({
      runs: runRepository as JarvisRunRepository,
      events: eventRepository as JarvisEventRepository,
    });
    const evidence: JarvisCanonicalLiveProducerEvidence<'action'> = {
      schemaVersion: 1,
      producerKind: 'action',
      producerIdentity,
      accountId: 'account-a',
      runId: run.id,
      requestId: 'request-1',
      attemptNumber: 1,
      resultRef: 'jresult_action_1',
      resultEventSeq: 3,
      state: 'completed',
      verifiedAt: 9_500,
    };
    const initialEvidence: JarvisCanonicalLiveProducerEvidence<'action'> = {
      ...evidence,
      resultRef: 'effect-claim-1',
      resultEventSeq: 2,
      state: 'busy',
      verifiedAt: 9_000,
    };

    await expect(verifiers.action.verify(initialEvidence)).resolves.toEqual(initialEvidence);
    await expect(verifiers.action.verify(evidence)).resolves.toEqual(evidence);
    expect(runRepository.getById).toHaveBeenCalledWith('account-a', run.id);
    expect(eventRepository.getBySeq).toHaveBeenCalledWith('account-a', run.id, 3);
    await expect(verifiers.action.verify({ ...evidence, verifiedAt: 9_501 })).resolves.toBeNull();
    await expect(verifiers.action.verify({ ...evidence, resultRef: ' ' })).resolves.toBeNull();
    vi.mocked(runRepository.getById).mockResolvedValueOnce({
      ...structuredClone(run),
      accountId: 'account-foreign',
    });
    await expect(verifiers.action.verify(evidence)).resolves.toBeNull();

    const validResult = structuredClone(events[1]!);
    events[1] = {
      ...events[1]!,
      executionEvidence: { ...events[1]!.executionEvidence!, ownerId: 'forged-execution' },
    };
    await expect(verifiers.action.verify(evidence)).resolves.toBeNull();

    events[1] = {
      ...validResult,
      producerSourceEvidence: {
        ...validResult.producerSourceEvidence!,
        observedAt: validResult.producerSourceEvidence!.observedAt + 1,
      },
    } as JarvisEvent;
    await expect(verifiers.action.verify(evidence)).resolves.toBeNull();

    events[1] = validResult;
    events.push({
      ...structuredClone(validResult),
      seq: 4,
      idempotencyKey: 'duplicate-result-1',
    });
    await expect(verifiers.action.verify(evidence)).resolves.toBeNull();
    events.pop();

    events[1] = { ...validResult, status: 'running' };
    await expect(verifiers.action.verify(evidence)).resolves.toBeNull();
    await expect(
      verifiers.plugin.verify({ ...evidence, producerKind: 'plugin' } as never),
    ).resolves.toBeNull();
  });

  it('binds non-schedule action evidence to one exact durable provider-start event', async () => {
    const run = parentRun({ source: 'typed_chat', transportAttempts: undefined });
    const producerIdentity = {
      producerKind: 'file_action' as const,
      actionId: 'file.search',
      actionVersion: 1,
      resultId: 'file-result-typed-1',
    };
    const events: JarvisEvent[] = [
      {
        runId: run.id,
        seq: 1,
        idempotencyKey: 'kernel-provider-start:request-typed-1:1',
        type: 'model',
        status: 'started',
        title: 'Provider started',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 8_500,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: run.accountId,
          runId: run.id,
          requestId: 'request-typed-1',
          attemptNumber: 1,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider',
            providerId: run.model.providerId,
            modelId: run.model.modelId,
            modelSnapshotRef: `jmodel_${run.model.providerId}_${run.model.modelId}_${run.model.capturedAt}`,
          },
          phase: 'start',
          state: 'started',
          resultRef: 'jprovider_start_request-typed-1',
          observedAt: 8_500,
        },
      },
      {
        runId: run.id,
        seq: 2,
        idempotencyKey: 'file-claim-typed-1',
        type: 'tool',
        status: 'running',
        title: 'File search started',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_000,
        executionEvidence: {
          schemaVersion: 1,
          requestId: 'request-typed-1',
          attemptNumber: 1,
          kind: 'consequential_effect_claimed',
          ownerKind: 'file',
          ownerId: producerIdentity.resultId,
          evidenceRef: 'file-claim-ref-typed-1',
          observedAt: 9_000,
        },
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: run.accountId,
          runId: run.id,
          requestId: 'request-typed-1',
          attemptNumber: 1,
          producerKind: 'file_action',
          producerIdentity,
          phase: 'start',
          state: 'busy',
          resultRef: 'file-claim-ref-typed-1',
          observedAt: 9_000,
        },
      },
      {
        runId: run.id,
        seq: 3,
        idempotencyKey: 'file-result-typed-1',
        type: 'tool',
        status: 'completed',
        title: 'File search completed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        executionEvidence: {
          schemaVersion: 1,
          requestId: 'request-typed-1',
          attemptNumber: 1,
          kind: 'consequential_effect_completed',
          ownerKind: 'file',
          ownerId: producerIdentity.resultId,
          evidenceRef: 'jresult_file_typed_1',
          observedAt: 9_500,
        },
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: run.accountId,
          runId: run.id,
          requestId: 'request-typed-1',
          attemptNumber: 1,
          producerKind: 'file_action',
          producerIdentity,
          phase: 'result',
          state: 'completed',
          resultRef: 'jresult_file_typed_1',
          observedAt: 9_500,
        },
      },
    ];
    const eventRepository: Pick<JarvisEventRepository, 'listByRun' | 'getBySeq'> = {
      listByRun: vi.fn(async (_accountId, _runId, options = {}) =>
        structuredClone(events.filter((event) => event.seq > (options.afterSeq ?? 0))),
      ),
      getBySeq: vi.fn(async (_accountId, _runId, seq) =>
        structuredClone(events.find((event) => event.seq === seq)),
      ),
    };
    const verifiers = createJarvisActionLiveEvidenceVerifiers({
      runs: { getById: vi.fn(async () => structuredClone(run)) } as never,
      events: eventRepository as JarvisEventRepository,
    });
    const initialEvidence: JarvisCanonicalLiveProducerEvidence<'file_action'> = {
      schemaVersion: 1,
      producerKind: 'file_action',
      producerIdentity,
      accountId: run.accountId,
      runId: run.id,
      requestId: 'request-typed-1',
      attemptNumber: 1,
      resultRef: 'file-claim-ref-typed-1',
      resultEventSeq: 2,
      state: 'busy',
      verifiedAt: 9_000,
    };
    const resultEvidence: JarvisCanonicalLiveProducerEvidence<'file_action'> = {
      ...initialEvidence,
      resultRef: 'jresult_file_typed_1',
      resultEventSeq: 3,
      state: 'completed',
      verifiedAt: 9_500,
    };

    await expect(verifiers.fileAction.verify(initialEvidence)).resolves.toEqual(initialEvidence);
    await expect(verifiers.fileAction.verify(resultEvidence)).resolves.toEqual(resultEvidence);

    const providerStart = structuredClone(events[0]!);
    const mutations: Array<[string, (event: JarvisEvent) => JarvisEvent]> = [
      ['idempotency', (event) => ({ ...event, idempotencyKey: 'forged-provider-start' })],
      [
        'provider',
        (event) =>
          ({
            ...event,
            producerSourceEvidence: {
              ...event.producerSourceEvidence!,
              producerIdentity: {
                ...event.producerSourceEvidence!.producerIdentity,
                providerId: 'provider-forged',
              },
            },
          }) as JarvisEvent,
      ],
      [
        'model',
        (event) =>
          ({
            ...event,
            producerSourceEvidence: {
              ...event.producerSourceEvidence!,
              producerIdentity: {
                ...event.producerSourceEvidence!.producerIdentity,
                modelId: 'model-forged',
              },
            },
          }) as JarvisEvent,
      ],
      [
        'snapshot',
        (event) =>
          ({
            ...event,
            producerSourceEvidence: {
              ...event.producerSourceEvidence!,
              producerIdentity: {
                ...event.producerSourceEvidence!.producerIdentity,
                modelSnapshotRef: 'jmodel_forged',
              },
            },
          }) as JarvisEvent,
      ],
      [
        'reference',
        (event) => ({
          ...event,
          producerSourceEvidence: {
            ...event.producerSourceEvidence!,
            resultRef: 'jprovider_start_forged',
          },
        }),
      ],
      [
        'observed time',
        (event) => ({
          ...event,
          producerSourceEvidence: {
            ...event.producerSourceEvidence!,
            observedAt: event.createdAt + 1,
          },
        }),
      ],
      [
        'schema',
        (event) => ({
          ...event,
          producerSourceEvidence: {
            ...event.producerSourceEvidence!,
            schemaVersion: 2,
          } as never,
        }),
      ],
      [
        'conflicting evidence',
        (event) => ({
          ...event,
          canonicalResultEvidence: {
            schemaVersion: 1,
            kind: 'kernel_turn_committed',
            accountId: run.accountId,
            runId: run.id,
            requestId: 'request-typed-1',
            attemptNumber: 1,
            state: 'completed',
            resultRef: 'jresult_conflict',
            observedAt: event.createdAt,
          },
        }),
      ],
    ];
    for (const [label, mutate] of mutations) {
      events[0] = mutate(structuredClone(providerStart));
      await expect(verifiers.fileAction.verify(initialEvidence), label).resolves.toBeNull();
    }
  });

  it.each([
    {
      kind: 'action' as const,
      verifier: 'action' as const,
      ownerKind: 'action' as const,
      ownerId: 'execution-1',
      identity: {
        producerKind: 'action' as const,
        actionId: 'notes.create',
        actionVersion: 1,
        executionId: 'execution-1',
      },
    },
    {
      kind: 'file_action' as const,
      verifier: 'fileAction' as const,
      ownerKind: 'file' as const,
      ownerId: 'file-result-1',
      identity: {
        producerKind: 'file_action' as const,
        actionId: 'file.write',
        actionVersion: 1,
        resultId: 'file-result-1',
      },
    },
    {
      kind: 'terminal' as const,
      verifier: 'terminal' as const,
      ownerKind: 'terminal' as const,
      ownerId: 'terminal-execution-1',
      identity: {
        producerKind: 'terminal' as const,
        sessionId: 'terminal-session-1',
        executionId: 'terminal-execution-1',
      },
    },
    {
      kind: 'plugin' as const,
      verifier: 'plugin' as const,
      ownerKind: 'plugin' as const,
      ownerId: 'plugin-invocation-1',
      identity: {
        producerKind: 'plugin' as const,
        pluginId: 'plugin-1',
        invocationId: 'plugin-invocation-1',
      },
    },
    {
      kind: 'mcp' as const,
      verifier: 'mcp' as const,
      ownerKind: 'mcp' as const,
      ownerId: 'mcp-invocation-1',
      identity: {
        producerKind: 'mcp' as const,
        serverId: 'server-1',
        toolName: 'tool-1',
        invocationId: 'mcp-invocation-1',
      },
    },
  ])('verifies the exact $kind producer pair', async (producer) => {
    const attempt: JarvisTransportAttemptV1 = {
      schemaVersion: 1,
      attemptNumber: 1,
      kind: 'initial',
      requestId: 'request-1',
      state: 'completed',
      startedEventSeq: 1,
      effectBarrier: { state: 'dirty', version: 1, updatedAt: 9_000 },
      createdAt: 8_000,
      updatedAt: 9_000,
    };
    const run = parentRun({ transportAttempts: [attempt] });
    const events = [
      {
        runId: run.id,
        seq: 2,
        idempotencyKey: `${producer.kind}-claim`,
        type: 'tool' as const,
        status: 'running',
        title: 'Capability started',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_000,
        executionEvidence: {
          schemaVersion: 1 as const,
          requestId: 'request-1',
          attemptNumber: 1,
          kind: 'consequential_effect_claimed' as const,
          ownerKind: producer.ownerKind,
          ownerId: producer.ownerId,
          evidenceRef: `${producer.kind}-claim-ref`,
          observedAt: 9_000,
        },
        producerSourceEvidence: {
          schemaVersion: 1 as const,
          accountId: 'account-a',
          runId: run.id,
          requestId: 'request-1',
          attemptNumber: 1,
          producerKind: producer.kind,
          producerIdentity: producer.identity,
          phase: 'start' as const,
          state: 'busy' as const,
          resultRef: `${producer.kind}-claim-ref`,
          observedAt: 9_000,
        },
      },
      {
        runId: run.id,
        seq: 3,
        idempotencyKey: `${producer.kind}-result`,
        type: 'tool' as const,
        status: 'completed',
        title: 'Capability completed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 9_500,
        executionEvidence: {
          schemaVersion: 1 as const,
          requestId: 'request-1',
          attemptNumber: 1,
          kind: 'consequential_effect_completed' as const,
          ownerKind: producer.ownerKind,
          ownerId: producer.ownerId,
          evidenceRef: `jresult_${producer.kind}_1`,
          observedAt: 9_500,
        },
        producerSourceEvidence: {
          schemaVersion: 1 as const,
          accountId: 'account-a',
          runId: run.id,
          requestId: 'request-1',
          attemptNumber: 1,
          producerKind: producer.kind,
          producerIdentity: producer.identity,
          phase: 'result' as const,
          state: 'completed' as const,
          resultRef: `jresult_${producer.kind}_1`,
          observedAt: 9_500,
        },
      },
    ] as JarvisEvent[];
    const verifiers = createJarvisActionLiveEvidenceVerifiers({
      runs: { getById: vi.fn(async () => structuredClone(run)) } as never,
      events: {
        listByRun: vi.fn(async () => structuredClone(events)),
        getBySeq: vi.fn(async (_accountId, _runId, seq) =>
          structuredClone(events.find((event) => event.seq === seq)),
        ),
      } as never,
    });
    const evidence = {
      schemaVersion: 1 as const,
      producerKind: producer.kind,
      producerIdentity: producer.identity,
      accountId: 'account-a',
      runId: run.id,
      requestId: 'request-1',
      attemptNumber: 1,
      resultRef: `jresult_${producer.kind}_1`,
      resultEventSeq: 3,
      state: 'completed' as const,
      verifiedAt: 9_500,
    };

    await expect(
      (verifiers[producer.verifier] as { verify(value: never): Promise<unknown> }).verify(
        evidence as never,
      ),
    ).resolves.toEqual(evidence);
  });
});

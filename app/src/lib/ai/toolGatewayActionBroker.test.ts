import { describe, expect, it, vi } from 'vitest';
import type {
  JarvisApprovalV1,
  JarvisRun,
  JarvisEntitlementSnapshot,
} from '@/lib/jarvis/contracts';
import {
  createJarvisApprovalEngine,
  createJarvisApprovalBindingSelectors,
  jarvisIssuedApprovalLifecycleBrand,
  type JarvisIssuedApprovalLifecycle,
  type JarvisKernelActionPort,
} from '@/lib/jarvis/approvalEngine';
import {
  createJarvisActionCatalog,
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
} from '@/lib/jarvis/actions/catalog';
import { createToolGatewayActionBroker } from './toolGatewayActionBroker';

function fixture() {
  const controller = new AbortController();
  const parentRun: JarvisRun = {
    id: 'run',
    accountId: 'account',
    chatId: 'chat',
    workspaceId: 'workspace',
    source: 'typed_chat',
    status: 'running',
    agentId: 'jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile',
    model: {
      connectionId: 'connection',
      providerId: 'openai',
      modelId: 'gpt-6-luna',
      connectionMode: 'native-api',
      capturedAt: 100,
      capabilities: { tools: true, vision: false },
    },
    createdAt: 100,
    updatedAt: 100,
  };
  const params = { title: 'QA', prompt: 'QA only', startAtMs: 10000, recurrence: 'once' };
  const approval: JarvisApprovalV1 = {
    schemaVersion: 1,
    id: 'jappr_tool',
    runId: 'run',
    requestId: 'provider',
    attemptNumber: 1,
    actionId: 'schedule.create',
    actionVersion: 1,
    params,
    paramsHash: 'canonical-hash',
    status: 'pending',
    risk: 'confirm',
    capabilityId: 'schedule.write',
    capabilitySnapshotHash: 'capability-hash',
    expectedEffect: 'Create schedule',
    createdAt: 100,
    expiresAt: 300100,
  };
  const actions: JarvisKernelActionPort = {
    create: vi.fn<JarvisKernelActionPort['create']>(async () => ({
      kind: 'committed',
      value: approval,
    })),
    decide: vi.fn<JarvisKernelActionPort['decide']>(async ({ decision }) => ({
      kind: 'committed',
      value: {
        ...approval,
        status: decision === 'approve' ? 'approved' : 'denied',
      },
    })),
    execute: vi.fn<JarvisKernelActionPort['execute']>(async () => ({
      kind: 'committed',
      value: {
        kind: 'settled',
        result: { ok: true, summary: 'Created', data: { id: 'schedule' } },
      },
    })),
    executeAutoApprovedSafe: vi.fn(),
  };
  let active = true;
  let clock = 100;
  const publishPending = vi.fn(async () => {});
  const publishOutcome = vi.fn(async () => {});
  const broker = createToolGatewayActionBroker({
    actions,
    catalog: createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS),
    now: () => clock,
    loadScope: async () => {
      if (!active || controller.signal.aborted) throw Error('tool_action_identity_unavailable');
      return {
        parentRun,
        attempt: { kind: 'initial', runId: 'run', requestId: 'provider', attemptNumber: 1 },
      };
    },
    publishPending,
    publishOutcome,
  });
  const request = {
    actionId: 'schedule.create',
    params,
    context: {
      requestId: 'tool-call',
      sessionId: 'native-session',
      messageId: 'provider',
      mutationApproved: true,
      signal: controller.signal,
    },
  };
  return {
    broker,
    parentRun,
    approval,
    request,
    controller,
    advanceClock: (milliseconds: number) => {
      clock += milliseconds;
    },
    actions,
    publishPending,
    publishOutcome,
    revoke: () => {
      active = false;
    },
  };
}

describe('protected Tool Gateway action broker', () => {
  it('prevents replay with the real approval engine that generates a fresh ID on each creation', async () => {
    const f = fixture();
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const entitlements: JarvisEntitlementSnapshot = {
      source: 'server',
      capabilities: [],
      verifiedAt: 100,
      expiresAt: 500000,
    };
    const capabilitySnapshots = {
      getForAccount: async () => ({
        capturedAt: 100,
        tools: [
          {
            id: 'schedule.write',
            state: 'available' as const,
            operations: ['execute'],
            evidenceRef: 'unit-capability',
            lastVerifiedAt: 100,
          },
        ],
        plugins: [],
        mcps: [],
        terminals: [],
        agents: [],
        entitlements,
      }),
    };
    let sequence = 0;
    const newApprovalId = vi.fn((): `jappr_${string}` => `jappr_real_${++sequence}`);
    const engine = createJarvisApprovalEngine({
      runs: { getById: async () => structuredClone(f.parentRun) },
      approvals: { getById: async () => undefined, listByRun: async () => [] },
      catalog,
      bindingSelectors: createJarvisApprovalBindingSelectors({
        catalog,
        capabilitySnapshots,
        entitlementSnapshots: { getForAccount: async () => entitlements },
      }),
      secretHandles: {
        validate: async () => ({ valid: true }),
        resolveOnce: async () => {
          throw Error('unused');
        },
      },
      executeRegisteredAction: async () => {
        throw Error('must_not_execute');
      },
      newApprovalId,
      now: () => 100,
      canonicalizeJson: JSON.stringify,
      hashCanonicalJson: async (value) => `unit-hash:${JSON.stringify(value)}`,
    });
    const lifecycle: JarvisIssuedApprovalLifecycle = {
      accountId: 'account',
      runId: 'run',
      requestId: 'provider',
      attemptNumber: 1,
      revocationSignal: f.controller.signal,
      [jarvisIssuedApprovalLifecycleBrand]: true,
      putPreparedApproval: async (input) => {
        const id: unknown = Reflect.get(input, 'approvalId');
        if (typeof id !== 'string' || !id.startsWith('jappr_real_'))
          throw Error('engine_did_not_issue_id');
        return {
          kind: 'committed',
          value: { ...f.approval, id, params: input.params, expiresAt: input.expiresAt },
        };
      },
      decidePreparedApproval: async () => {
        throw Error('unused');
      },
      claimApprovedExecution: async () => {
        throw Error('unused');
      },
      claimAutoApprovedExecution: async () => {
        throw Error('unused');
      },
      dispose: () => f.controller.abort(),
    };
    const capability = engine.bindIssuedLifecycle(lifecycle);
    const input: Parameters<typeof capability.create>[0] = {
      parentRun: f.parentRun,
      attempt: { kind: 'initial' as const, runId: 'run', requestId: 'provider', attemptNumber: 1 },
      actionId: 'schedule.create',
      actionVersion: 1,
      params: f.request.params,
      expiresAt: 300100,
    };
    const firstId = (await capability.create(input)).id;
    const secondId = (await capability.create(input)).id;
    expect(firstId).not.toBe(secondId);
    vi.mocked(f.actions.create).mockImplementation(async (value) => ({
      kind: 'committed',
      value: await capability.create(value),
    }));
    const waiting = f.broker.request(f.request);
    void waiting.catch(() => {});
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_replayed');
    expect(f.actions.create).toHaveBeenCalledOnce();
    expect(newApprovalId).toHaveBeenCalledTimes(3);
    f.broker.dispose();
    await expect(waiting).rejects.toThrow('tool_action_cancelled');
    expect(f.actions.execute).not.toHaveBeenCalled();
  });

  it('settles the original live request after the former thirty-second boundary', async () => {
    const f = fixture();
    const live = vi.fn(async () => true);
    const waiting = f.broker.request({
      ...f.request,
      context: { ...f.request.context, isRequestLive: live },
    });
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    f.advanceClock(31000);
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await expect(waiting).resolves.toMatchObject({ kind: 'settled', result: { ok: true } });
    expect(f.actions.create).toHaveBeenCalledOnce();
    expect(f.actions.execute).toHaveBeenCalledOnce();
  });

  it('cannot approve or execute after its individual native connection ended while the provider remains active', async () => {
    const f = fixture();
    const transport = new AbortController();
    let live = true;
    const waiting = f.broker.request({
      ...f.request,
      context: {
        ...f.request.context,
        signal: transport.signal,
        isRequestLive: async () => {
          if (!live) transport.abort();
          return live;
        },
      },
    });
    const rejected = expect(waiting).rejects.toThrow('tool_action_cancelled');
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    live = false;
    await expect(f.broker.decide('account', 'jappr_tool', 'approve')).rejects.toThrow(
      'tool_action_cancelled',
    );
    await rejected;
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.actions.decide).not.toHaveBeenCalled();
    expect(f.actions.execute).not.toHaveBeenCalled();
  });

  it('does not execute a committed approval when its native request ends during the owner decision', async () => {
    const f = fixture();
    const transport = new AbortController();
    let live = true;
    const decide = vi.mocked(f.actions.decide).getMockImplementation()!;
    vi.mocked(f.actions.decide).mockImplementation(async (input) => {
      const result = await decide(input);
      live = false;
      return result;
    });
    const waiting = f.broker.request({
      ...f.request,
      context: {
        ...f.request.context,
        signal: transport.signal,
        isRequestLive: async () => {
          if (!live) transport.abort();
          return live;
        },
      },
    });
    const rejected = expect(waiting).rejects.toThrow('tool_action_cancelled');
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await expect(f.broker.decide('account', 'jappr_tool', 'approve')).rejects.toThrow(
      'tool_action_cancelled',
    );
    await rejected;
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.actions.decide).toHaveBeenCalledOnce();
    expect(f.actions.execute).not.toHaveBeenCalled();
  });
  it('retains the tool request identity even if the caller mutates its context during the wait', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    f.request.context.requestId = 'replacement-call';
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await task;
    expect(f.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ callId: 'tool-call' }) }),
    );
  });

  it('rejects an expired owner decision without executing or inventing another decision', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    void task.catch(() => {});
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    f.advanceClock(300000);
    await expect(f.broker.decide('account', 'jappr_tool', 'approve')).rejects.toThrow(
      'tool_action_expired',
    );
    f.controller.abort();
    await expect(task).rejects.toThrow('tool_action_cancelled');
    expect(f.actions.decide).not.toHaveBeenCalled();
    expect(f.actions.execute).not.toHaveBeenCalled();
  });

  it('does not admit a second waiting request for the same canonical approval', async () => {
    const f = fixture();
    const first = f.broker.request(f.request);
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_replayed');
    expect(f.publishPending).toHaveBeenCalledOnce();
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await first;
    expect(f.actions.execute).toHaveBeenCalledOnce();
  });

  it('reserves a logical call before canonical creation even when creation returns fresh IDs', async () => {
    const f = fixture();
    const original = vi.mocked(f.actions.create).getMockImplementation()!;
    let sequence = 0;
    vi.mocked(f.actions.create).mockImplementation(async (input) => {
      const result = await original(input);
      return result.kind === 'committed'
        ? { ...result, value: { ...result.value, id: `fresh-${++sequence}` } }
        : result;
    });
    const first = f.broker.request(f.request);
    void first.catch(() => {});
    // Both calls enter before canonical creation has returned.
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_replayed');
    expect(f.actions.create).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    f.broker.dispose();
    await expect(first).rejects.toThrow('tool_action_cancelled');
    expect(f.actions.execute).not.toHaveBeenCalled();
  });

  it('retains settled call replay protection until the owning attempt is released', async () => {
    const f = fixture();
    const first = f.broker.request(f.request);
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await first;
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_replayed');
    expect(f.actions.create).toHaveBeenCalledOnce();
    expect(f.actions.execute).toHaveBeenCalledOnce();
  });

  it('rejects reuse of the logical call with conflicting parameters before a second approval', async () => {
    const f = fixture();
    const first = f.broker.request(f.request);
    void first.catch(() => {});
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await expect(
      f.broker.request({ ...f.request, params: { ...f.request.params, title: 'Other' } }),
    ).rejects.toThrow('tool_action_call_conflict');
    expect(f.actions.create).toHaveBeenCalledOnce();
    f.broker.dispose();
    await expect(first).rejects.toThrow('tool_action_cancelled');
  });

  it('retains failed creation replay protection and releases only the matching attempt', async () => {
    const f = fixture();
    vi.mocked(f.actions.create).mockRejectedValueOnce(Error('canonical_create_failed'));
    await expect(f.broker.request(f.request)).rejects.toThrow('canonical_create_failed');
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_replayed');
    f.broker.releaseAttempt('foreign', {
      kind: 'initial',
      runId: 'run',
      requestId: 'provider',
      attemptNumber: 1,
    });
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_replayed');
    f.broker.releaseAttempt('account', {
      kind: 'initial',
      runId: 'run',
      requestId: 'provider',
      attemptNumber: 1,
    });
    const next = f.broker.request(f.request);
    void next.catch(() => {});
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    f.broker.dispose();
    await expect(next).rejects.toThrow('tool_action_cancelled');
    expect(f.actions.create).toHaveBeenCalledTimes(2);
  });

  it('retains an invalid-parameter rejection so the same logical call cannot change its payload', async () => {
    const f = fixture();
    await expect(
      f.broker.request({ ...f.request, params: { ...f.request.params, title: '' } }),
    ).rejects.toThrow();
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_call_conflict');
    expect(f.actions.create).not.toHaveBeenCalled();
  });
  it('publishes the exact canonical approval to its chat and settles the same waiting tool call', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    expect(f.actions.execute).not.toHaveBeenCalled();
    expect(f.actions.executeAutoApprovedSafe).not.toHaveBeenCalled();
    expect(f.publishPending).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jappr_tool' }),
      expect.objectContaining({ parentRun: expect.objectContaining({ chatId: 'chat' }) }),
      f.request,
    );
    expect(await f.broker.decide('account', 'jappr_tool', 'approve')).toMatchObject({
      kind: 'committed',
    });
    await expect(task).resolves.toMatchObject({ kind: 'settled', result: { ok: true } });
    expect(f.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'jappr_tool',
        context: expect.objectContaining({
          source: 'ai',
          chatId: 'chat',
          runId: 'run',
          requestId: 'provider',
          attemptNumber: 1,
          callId: 'tool-call',
          signal: f.controller.signal,
        }),
      }),
    );
    expect(f.broker.owns('account', 'jappr_tool')).toBe(false);
  });

  it('does not execute after owner denial', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    const rejected = expect(task).rejects.toThrow('tool_action_denied');
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await f.broker.decide('account', 'jappr_tool', 'deny');
    await rejected;
    expect(f.actions.execute).not.toHaveBeenCalled();
  });

  it('cancels the waiting call without fabricating an owner decision or execution', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    const rejected = expect(task).rejects.toThrow('tool_action_cancelled');
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    f.controller.abort();
    await rejected;
    expect(f.actions.decide).not.toHaveBeenCalled();
    expect(f.actions.execute).not.toHaveBeenCalled();
    expect(f.broker.owns('account', 'jappr_tool')).toBe(false);
  });

  it('fails closed before creating an approval when the exact live identity is absent', async () => {
    const f = fixture();
    f.revoke();
    await expect(f.broker.request(f.request)).rejects.toThrow('tool_action_identity_unavailable');
    expect(f.actions.create).not.toHaveBeenCalled();
  });

  it('rejects a stale or mismatched decision and never executes it', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    const rejected = expect(task).rejects.toThrow('tool_action_cancelled');
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    expect(await f.broker.decide('foreign', 'jappr_tool', 'approve')).toBeNull();
    f.revoke();
    await expect(f.broker.decide('account', 'jappr_tool', 'approve')).rejects.toThrow(
      'tool_action_identity_unavailable',
    );
    f.controller.abort();
    await rejected;
    expect(f.actions.execute).not.toHaveBeenCalled();
  });

  it('retains a terminal handoff as pending rather than settled success', async () => {
    const f = fixture();
    vi.mocked(f.actions.execute).mockResolvedValueOnce({
      kind: 'committed',
      value: {
        kind: 'handoff_pending',
        executorKind: 'terminal',
        ownerId: 'terminal-owner',
        result: { ok: true, summary: 'Queued' },
      },
    });
    const task = f.broker.request(f.request);
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await expect(task).resolves.toMatchObject({
      kind: 'handoff_pending',
      ownerId: 'terminal-owner',
    });
  });

  it('rejects a revoked canonical result even after the executor returns', async () => {
    const f = fixture();
    vi.mocked(f.actions.execute).mockResolvedValueOnce({ kind: 'account_authority_revoked' });
    const task = f.broker.request(f.request);
    const rejected = expect(task).rejects.toThrow('tool_action_authority_revoked');
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await rejected;
  });

  it('cannot change approval parameters by mutating the caller object while awaiting its owner', async () => {
    const f = fixture();
    const task = f.broker.request(f.request);
    f.request.params.title = 'Changed';
    await vi.waitFor(() => expect(f.publishPending).toHaveBeenCalledOnce());
    expect(f.actions.create).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ title: 'QA' }) }),
    );
    await f.broker.decide('account', 'jappr_tool', 'approve');
    await task;
  });
});

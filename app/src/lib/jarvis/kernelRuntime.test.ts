import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import {
  fromJarvisApprovalRow,
  fromJarvisRunRow,
  toJarvisEventRow,
  toJarvisRunRow,
} from '@/lib/db/jarvisMappers';
import { createJarvisRepositories } from '@/lib/db/jarvisRepositories';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import type { Agent, ChatId, WorkspaceId } from '@/types';
import { createJarvisHiveLiveEvidenceVerifier } from '@/lib/ai/stacks/hiveWorkerExecutor';
import {
  JarvisProviderAttemptFailureError,
  createJarvisProviderAttemptEvidenceAuthority,
} from '@/lib/ai/providerAttemptEvidence';
import { createJarvisScheduleLiveEvidenceVerifier } from '@/features/schedule/jarvisScheduleDispatch';
import type {
  JarvisCanonicalLiveProducerEvidence,
  JarvisHiveStackPlanV1,
  JarvisResponseEnvelope,
  JarvisRun,
} from './contracts';
import {
  createJarvisActionLiveEvidenceVerifiers,
  jarvisTerminalHandoffReceiptBrand,
} from './approvalEngine';
import type {
  CreateJarvisApprovalInput,
  JarvisApprovalActionBinder,
  JarvisApprovalActionCapability,
  JarvisIssuedApprovalLifecycle,
  JarvisTerminalOwnedExecution,
} from './approvalEngine';
import type { JarvisKernelTurnInput } from './kernel';
import { createJarvisExecutionJournal } from './executionJournal/journal';
import {
  createJarvisKernelRuntime,
  type JarvisAllocatedScheduledOccurrence,
} from './kernelRuntime';

const NOW = 1_786_300_100_000;

function artifactAuthorities() {
  const ready = (producerId: string) =>
    Object.freeze({
      state: 'ready' as const,
      producerId,
      authority: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
  return Object.freeze({
    provider: ready('provider_response'),
    fileAction: ready('file_action_result'),
    terminal: ready('terminal_exit'),
    plugin: ready('plugin_result'),
    mcp: ready('mcp_result'),
    schedule: Object.freeze({
      state: 'unavailable' as const,
      producerId: 'schedule_result',
      reason: 'producer_task_not_landed' as const,
    }),
  });
}

function unavailableVerifiers() {
  const unavailable = <K extends string>(producerKind: K) =>
    Object.freeze({
      state: 'unavailable' as const,
      producerKind,
      reason: 'producer_task_not_landed' as const,
    });
  return Object.freeze({
    provider: unavailable('provider'),
    action: unavailable('action'),
    fileAction: unavailable('file_action'),
    terminal: unavailable('terminal'),
    plugin: unavailable('plugin'),
    mcp: unavailable('mcp'),
    voice: unavailable('voice'),
    schedule: unavailable('schedule'),
    hive: unavailable('hive'),
  });
}

function actionReadyVerifiers(db: JarvisDexie) {
  const repositories = createJarvisRepositories(db);
  const action = createJarvisActionLiveEvidenceVerifiers({
    runs: repositories.run,
    events: repositories.event,
  });
  return Object.freeze({
    ...unavailableVerifiers(),
    action: Object.freeze({ state: 'ready' as const, verifier: action.action }),
    fileAction: Object.freeze({ state: 'ready' as const, verifier: action.fileAction }),
    terminal: Object.freeze({ state: 'ready' as const, verifier: action.terminal }),
    plugin: Object.freeze({ state: 'ready' as const, verifier: action.plugin }),
    mcp: Object.freeze({ state: 'ready' as const, verifier: action.mcp }),
  });
}

function kernelRun(): JarvisRun {
  return {
    id: 'run-runtime-kernel',
    accountId: 'account-kernel',
    workspaceId: 'workspace-kernel',
    chatId: 'chat-runtime-kernel',
    source: 'typed_chat',
    status: 'queued',
    agentId: 'agent-runtime-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-runtime-kernel',
    model: {
      connectionId: 'connection-runtime-kernel',
      providerId: 'provider-kernel',
      modelId: 'model-kernel',
      connectionMode: 'native-api',
      capabilities: { tools: true, vision: false },
      capturedAt: NOW - 10,
    },
    createdAt: NOW - 20,
    updatedAt: NOW - 20,
  };
}

function kernelTurn(): JarvisKernelTurnInput {
  const current = kernelRun();
  const protectedJarvis: Agent = {
    id: 'agent-runtime-jarvis' as Agent['id'],
    slug: 'jarvis',
    name: 'Jarvis',
    description: 'Protected Jarvis',
    system_prompt: 'Legacy prompt.',
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    builtin: true,
    created_at: NOW - 20,
    updated_at: NOW - 20,
  };
  return {
    run: current,
    attempt: {
      kind: 'initial',
      requestId: 'request-runtime-kernel',
      runId: current.id,
      attemptNumber: 1,
    },
    accountId: current.accountId,
    workspaceId: current.workspaceId,
    chatId: current.chatId!,
    userMessageId: 'message-runtime-user',
    agent: protectedJarvis,
    surface: 'typed_chat',
    interactionMode: 'ask',
    userText: 'Give me the runtime answer.',
    messageHistory: [{ role: 'user', content: 'Give me the runtime answer.' }],
    model: current.model,
    identity: {
      identityVersion: 1,
      coreHash: 'core-runtime-kernel',
      responseContractHash: 'response-runtime-kernel',
    },
    profile: {
      profileId: 'profile-runtime-kernel',
      revisionId: 'profile-runtime-kernel',
      customInstructions: '',
      memoryScope: 'profile',
    },
    capabilities: {
      capturedAt: NOW - 10,
      tools: [],
      plugins: [],
      mcps: [],
      terminals: [],
      agents: [],
      entitlements: { source: 'local_development', capabilities: [] },
    },
    context: { items: [], budget: { maxChars: 4_000, usedChars: 0 }, exclusions: [] },
    outputContract: {
      preserveStructuredBlocks: true,
      allowActionBlocks: true,
      allowPlanBlocks: true,
      allowQuestionBlocks: true,
      allowPermissionBlocks: true,
      voiceDelivery: 'validated_stream',
    },
  };
}

describe('createJarvisKernelRuntime primary-host lifecycle', () => {
  let db: JarvisDexie;

  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('kernel-runtime-host'), TEST_INDEXED_DB);
    await db.open();
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-kernel' });
  });

  afterEach(async () => {
    await db.delete();
  });

  function runtime() {
    return createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(),
      } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-uuid',
      now: () => NOW,
    });
  }

  async function seedActionResponseCheckpoint(input: {
    parentRun: JarvisRun;
    requestId: string;
    approvalId: string;
    actionId: string;
    providerResultState?: 'completed' | 'degraded';
  }): Promise<void> {
    await db.chats.add({
      id: input.parentRun.chatId as ChatId,
      workspace_id: input.parentRun.workspaceId as WorkspaceId,
      title: 'Runtime action response',
      mode: 'chat',
      active_agent_ids: [input.parentRun.agentId as Agent['id']],
      created_at: NOW - 20,
      updated_at: NOW,
    });
    await db.messages.add({
      id: `msg_${input.requestId}` as never,
      chat_id: input.parentRun.chatId as ChatId,
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Canonical action response.' },
        {
          kind: 'action_proposal',
          call_id: `jarvisapproval:${encodeURIComponent(input.approvalId)}`,
          action_id: input.actionId,
          params: {},
          status: 'pending',
        },
      ],
      created_at: NOW,
      updated_at: NOW,
    });
    const events = await db.jarvis_events.where('run_id').equals(input.parentRun.id).sortBy('seq');
    const tail = events.at(-1);
    await db.jarvis_events.add(
      toJarvisEventRow({
        runId: input.parentRun.id,
        seq: (tail?.seq ?? 0) + 1,
        idempotencyKey: `action-response-ready:${input.approvalId}`,
        type: 'message',
        status: 'approval_required',
        title: 'Action approval required',
        safeSummary: 'The validated response is saved and awaiting an approval decision.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW,
        ...(input.providerResultState === undefined
          ? {}
          : {
              producerSourceEvidence: {
                schemaVersion: 1 as const,
                accountId: input.parentRun.accountId,
                runId: input.parentRun.id,
                requestId: input.requestId,
                attemptNumber: 1,
                producerKind: 'provider' as const,
                producerIdentity: {
                  producerKind: 'provider' as const,
                  providerId: input.parentRun.model.providerId,
                  modelId: input.parentRun.model.modelId,
                  modelSnapshotRef: `${input.parentRun.model.providerId}:${input.parentRun.model.modelId}`,
                },
                resultRef: `jprovider_result:${input.requestId}`,
                observedAt: NOW,
                phase: 'result' as const,
                state: input.providerResultState,
              },
            }),
      }),
    );
  }

  it('returns exactly feature-facing kernel and primary-host lifecycle members', () => {
    const composition = runtime();

    expect(Object.keys(composition).sort()).toEqual(['kernel', 'liveEvidenceHost']);
    expect(composition.kernel).not.toHaveProperty('read');
    expect(composition.kernel).not.toHaveProperty('ownerMaintenance');
    expect(composition.liveEvidenceHost).not.toHaveProperty('invalidateAccount');
    expect(composition.liveEvidenceHost).not.toHaveProperty('invalidateAll');
  });

  it('opens an account only after reconstruction and returns an account-bound read port', async () => {
    const { liveEvidenceHost } = runtime();

    const session = await liveEvidenceHost.openAccount('account-alpha');

    expect(Object.keys(session).sort()).toEqual(['accountId', 'assertCurrent', 'dispose', 'read']);
    expect(session.accountId).toBe('account-alpha');
    expect(session.read.accountId).toBe('account-alpha');
    expect(Object.keys(session.read).sort()).toEqual(['accountId', 'snapshot', 'subscribe']);
    expect(await session.read.snapshot('run-missing')).toBeUndefined();
    expect(session.assertCurrent()).toBeUndefined();
  });

  it('revokes the previous epoch before replacing it, including the same account', async () => {
    const { liveEvidenceHost } = runtime();
    const first = await liveEvidenceHost.openAccount('account-alpha');
    const firstListener = vi.fn();
    const unsubscribe = first.read.subscribe('run-alpha', firstListener);

    const second = await liveEvidenceHost.openAccount('account-alpha');

    expect(() => first.assertCurrent()).toThrow('kernel_host_session_stale');
    await expect(first.read.snapshot('run-alpha')).rejects.toThrow('kernel_host_session_stale');
    expect(() => first.read.subscribe('run-alpha', vi.fn())).toThrow('kernel_host_session_stale');
    expect(() => second.assertCurrent()).not.toThrow();
    unsubscribe();
  });

  it('serializes concurrent account replacement and leaves only the last session current', async () => {
    const { liveEvidenceHost } = runtime();

    const [first, second] = await Promise.all([
      liveEvidenceHost.openAccount('account-alpha'),
      liveEvidenceHost.openAccount('account-beta'),
    ]);

    expect(() => first.assertCurrent()).toThrow('kernel_host_session_stale');
    expect(() => second.assertCurrent()).not.toThrow();
    expect(second.accountId).toBe('account-beta');
  });

  it('makes session and host disposal idempotent and rejects future opens', async () => {
    const { liveEvidenceHost } = runtime();
    const session = await liveEvidenceHost.openAccount('account-alpha');

    session.dispose();
    session.dispose();
    expect(() => session.assertCurrent()).toThrow('kernel_host_session_stale');

    liveEvidenceHost.dispose();
    liveEvidenceHost.dispose();
    await expect(liveEvidenceHost.openAccount('account-beta')).rejects.toThrow(
      'kernel_host_disposed',
    );
  });

  it('opens one process-local recovery handle and commits the fixed recovered partial terminal', async () => {
    const current = {
      ...kernelRun(),
      source: 'voice' as const,
      status: 'running' as const,
    };
    await db.jarvis_runs.add(toJarvisRunRow(current));
    await db.chats.add({
      id: current.chatId as ChatId,
      workspace_id: current.workspaceId as WorkspaceId,
      title: 'Runtime voice recovery',
      mode: 'chat',
      active_agent_ids: [current.agentId as Agent['id']],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });
    await db.messages.add({
      id: 'message-runtime-recovery' as never,
      chat_id: current.chatId as ChatId,
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Saved before restart.' }],
      created_at: NOW - 5,
      updated_at: NOW - 5,
    });
    const providerStartEvent = {
      runId: current.id,
      seq: 1,
      idempotencyKey: 'kernel-provider-start:request-runtime-current:1',
      type: 'model' as const,
      status: 'started',
      title: 'Provider started',
      safeSummary: 'The protected provider dispatch started.',
      sourceRefs: [],
      artifactIds: [],
      createdAt: NOW - 6,
      producerSourceEvidence: {
        schemaVersion: 1 as const,
        accountId: current.accountId,
        runId: current.id,
        requestId: 'request-runtime-current',
        attemptNumber: 1,
        producerKind: 'provider' as const,
        producerIdentity: {
          producerKind: 'provider' as const,
          providerId: 'provider-kernel',
          modelId: 'model-kernel',
          modelSnapshotRef: 'provider-kernel:model-kernel',
        },
        resultRef: 'jprovider_start_runtime_recovery',
        observedAt: NOW - 6,
        phase: 'start' as const,
        state: 'started' as const,
      },
    };
    await db.jarvis_events.add(toJarvisEventRow(providerStartEvent));
    await db.jarvis_events.add(
      toJarvisEventRow({
        runId: current.id,
        seq: 2,
        idempotencyKey: `voice-response-ready:${current.id}:message-runtime-recovery`,
        type: 'message',
        status: 'response_ready',
        title: 'Voice response ready',
        safeSummary: 'The validated response is saved and awaiting playback outcome.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW - 5,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: current.accountId,
          runId: current.id,
          requestId: 'request-runtime-recovery',
          attemptNumber: 1,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider',
            providerId: 'provider-kernel',
            modelId: 'model-kernel',
            modelSnapshotRef: 'provider-kernel:model-kernel',
          },
          resultRef: 'jprovider_result_runtime_recovery',
          observedAt: NOW - 5,
          phase: 'result',
          state: 'completed',
        },
      }),
    );
    const { kernel } = runtime();

    await expect(
      kernel.openVoiceRecovery({ accountId: current.accountId, runId: current.id }),
    ).rejects.toThrow('voice_recovery_evidence_invalid');
    await db.jarvis_events.put(
      toJarvisEventRow({
        ...providerStartEvent,
        producerSourceEvidence: {
          ...providerStartEvent.producerSourceEvidence,
          requestId: 'request-runtime-recovery',
        },
      }),
    );

    const opened = await kernel.openVoiceRecovery({
      accountId: current.accountId,
      runId: current.id,
    });
    expect(opened).toMatchObject({ kind: 'committed', value: expect.any(Object) });
    if (opened.kind !== 'committed') throw new Error('expected recovery handle');
    expect(Object.isFrozen(opened.value)).toBe(true);
    const clone = { ...opened.value } as typeof opened.value;
    await expect(clone.commitRecoveredPartial()).rejects.toThrow('voice_recovery_handle_invalid');

    await expect(opened.value.commitRecoveredPartial()).resolves.toMatchObject({
      kind: 'committed',
      value: {
        committed: true,
        run: { status: 'partial', completedAt: NOW },
        event: {
          idempotencyKey: `voice-recovery:${current.id}`,
          title: 'Voice response recovered',
          safeSummary:
            'The response was saved, but playback completion could not be verified after restart.',
        },
      },
    });
    await expect(opened.value.commitRecoveredPartial()).rejects.toThrow(
      'voice_recovery_handle_invalid',
    );
    expect(await db.messages.count()).toBe(1);
    expect(await db.jarvis_events.count()).toBe(3);
    await expect(
      kernel.openVoiceRecovery({ accountId: current.accountId, runId: current.id }),
    ).rejects.toThrow('voice_recovery_evidence_invalid');
  });

  it('binds a protected turn through real lifecycle, live-evidence, and terminal transactions', async () => {
    const turn = kernelTurn();
    await db.jarvis_runs.add(toJarvisRunRow(turn.run));
    await db.chats.add({
      id: turn.chatId as ChatId,
      workspace_id: turn.workspaceId as WorkspaceId,
      title: 'Runtime kernel',
      mode: 'chat',
      active_agent_ids: [turn.agent.id],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });
    const providerVerifier = Object.freeze({
      state: 'ready' as const,
      producerKind: 'provider' as const,
      verifier: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
    const liveEvidenceVerifiers = {
      ...unavailableVerifiers(),
      provider: providerVerifier,
    };
    const processed: JarvisResponseEnvelope = {
      schemaVersion: 1,
      requestId: turn.attempt.requestId,
      runId: turn.run.id,
      mode: 'direct_answer',
      displayText: 'Runtime verified answer.',
      spokenText: 'Runtime verified answer.',
      parts: [{ kind: 'text', text: 'Runtime verified answer.' }],
      artifactIds: [],
      sourceRefs: [],
      executionState: { status: 'completed', verifiedBy: 'journal', lastEventSeq: 4 },
      provider: turn.model,
      enforcement: {
        linted: true,
        violations: [],
        repairAttempted: false,
        repairSucceeded: false,
        fallbackUsed: false,
      },
      completedAt: NOW + 10,
    };
    const start = vi.fn(() => ({
      receipt: {
        providerId: 'provider-kernel',
        modelId: 'model-kernel',
        modelSnapshotRef: 'provider-kernel:model-kernel',
        operations: ['generate'] as const,
        startedAt: NOW + 5,
      },
      response: Promise.resolve({
        text: 'Runtime verified answer.',
        provider: turn.model,
        verifiedFacts: {
          executionState: {
            status: 'completed' as const,
            verifiedBy: 'journal' as const,
            lastEventSeq: 4,
          },
          modelState: 'authenticated' as const,
          plugins: [],
          mcps: [],
        },
        completedAt: NOW + 10,
      }),
      abortAfterStart: vi.fn(),
    }));
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(async () => turn.run),
      },
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {
        registerIssuedOwner: vi.fn(() => vi.fn()),
      },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: liveEvidenceVerifiers as never,
      prepareProvider: vi.fn(async () => ({
        resolveConfiguration: vi.fn(async () => ({ start, dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      processResponse: vi.fn(async () => processed),
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-kernel-uuid',
      now: () => NOW,
    });

    const result = await runtime.kernel.runInitialTurn(turn);

    expect(result).toMatchObject({
      kind: 'committed',
      value: { response: processed },
    });
    expect(start).toHaveBeenCalledOnce();
    expect(fromJarvisRunRow((await db.jarvis_runs.get(turn.run.id))!)).toMatchObject({
      status: 'completed',
      completedAt: NOW + 10,
    });
    expect(await db.messages.count()).toBe(1);
    expect(await db.sync_queue.count()).toBe(2);
    expect(await db.jarvis_events.count()).toBe(6);
  });

  it('terminalizes a protected voice run cancelled before the first provider response', async () => {
    const base = kernelTurn();
    const turn: JarvisKernelTurnInput & { surface: 'voice' } = {
      ...base,
      run: { ...base.run, source: 'voice' },
      surface: 'voice',
    };
    await db.jarvis_runs.add(toJarvisRunRow(turn.run));
    await db.chats.add({
      id: turn.chatId as ChatId,
      workspace_id: turn.workspaceId as WorkspaceId,
      title: 'Runtime voice cancellation',
      mode: 'chat',
      active_agent_ids: [turn.agent.id],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });

    const providerVerifier = Object.freeze({
      state: 'ready' as const,
      producerKind: 'provider' as const,
      verifier: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
    const registeredOwners = new Map<string, Readonly<{ abort(): unknown | Promise<unknown> }>>();
    const registerIssuedOwner = vi.fn(
      (registration: Readonly<{ registrationId: string; abort(): unknown | Promise<unknown> }>) => {
        registeredOwners.set(registration.registrationId, registration);
        return () => registeredOwners.delete(registration.registrationId);
      },
    );
    const cancellationPlan = Object.freeze({
      accountId: turn.accountId,
      runId: turn.run.id,
      cancellationRequestId: 'voice-provider-cancel-runtime',
    });
    const deliverCancellation = vi.fn(async () => {
      const owner = registeredOwners.get(`${turn.run.id}:provider`);
      if (!owner) throw new Error('expected provider abort owner');
      const outcome = await owner.abort();
      return {
        kind: 'signal_delivered' as const,
        cancellationRequestId: cancellationPlan.cancellationRequestId,
        ownerIds:
          typeof outcome === 'object' &&
          outcome !== null &&
          'kind' in outcome &&
          outcome.kind === 'signal_delivered' &&
          'ownerId' in outcome
            ? [String(outcome.ownerId)]
            : [],
      };
    });
    let providerSignal: AbortSignal | undefined;
    const abortAfterStart = vi.fn();
    const start = vi.fn((signal: AbortSignal) => {
      providerSignal = signal;
      const response = new Promise<never>(() => undefined);
      return {
        receipt: {
          providerId: 'provider-kernel',
          modelId: 'model-kernel',
          modelSnapshotRef: 'provider-kernel:model-kernel',
          operations: ['generate'] as const,
          startedAt: NOW + 5,
        },
        response,
        abortAfterStart,
      };
    });
    const processResponse = vi.fn();
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(async () => turn.run),
      },
      cancellationDeliveryAuthority: {
        prepare: vi.fn(async () => ({ kind: 'prepared' as const, plan: cancellationPlan })),
        deliver: deliverCancellation,
        current: vi.fn(),
        sealWorkflowQuiescence: vi.fn(),
        abandonBeforeDelivery: vi.fn(),
      } as never,
      abortRegistrationAuthority: { registerIssuedOwner },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: {
        ...unavailableVerifiers(),
        provider: providerVerifier,
      } as never,
      prepareProvider: vi.fn(async () => ({
        resolveConfiguration: vi.fn(async () => ({ start, dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      processResponse,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-voice-provider-cancel-uuid',
      now: () => NOW,
    });

    const pendingTurn = runtime.kernel.startVoiceTurn(turn).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
      expect(registeredOwners.has(`${turn.run.id}:provider`)).toBe(true);
    });

    const cancellation = await runtime.kernel.requestCancellation({
      accountId: turn.accountId,
      runId: turn.run.id,
    });
    expect(cancellation).toMatchObject({
      kind: 'intent_committed',
      cancellationRequestId: cancellationPlan.cancellationRequestId,
      aggregate: {
        kind: 'signal_delivered',
        ownerIds: [`${turn.run.id}:provider`],
      },
    });
    expect(providerSignal?.aborted).toBe(true);

    const outcome = await Promise.race([
      pendingTurn,
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), 1_000),
      ),
    ]);
    expect(outcome).toMatchObject({ kind: 'rejected', error: { name: 'AbortError' } });
    expect(fromJarvisRunRow((await db.jarvis_runs.get(turn.run.id))!)).toMatchObject({
      status: 'cancelled',
      completedAt: NOW,
    });
    const events = await db.jarvis_events.orderBy('[run_id+seq]').toArray();
    expect(events.map((event) => event.status)).toEqual([
      'compiling',
      'running',
      'started',
      'started',
      'cancellation_requested',
      'cancelled',
    ]);
    expect(
      events.filter((event) => event.producer_source_evidence?.phase === 'result'),
    ).toHaveLength(0);
    expect(processResponse).not.toHaveBeenCalled();
    expect(abortAfterStart).not.toHaveBeenCalled();
    expect(await db.messages.count()).toBe(0);
  });

  it('issues one opaque voice handle and keeps the run nonterminal through response-ready commit', async () => {
    const base = kernelTurn();
    const turn: JarvisKernelTurnInput & { surface: 'voice' } = {
      ...base,
      run: { ...base.run, source: 'voice' },
      surface: 'voice',
    };
    await db.jarvis_runs.add(toJarvisRunRow(turn.run));
    await db.chats.add({
      id: turn.chatId as ChatId,
      workspace_id: turn.workspaceId as WorkspaceId,
      title: 'Runtime voice kernel',
      mode: 'chat',
      active_agent_ids: [turn.agent.id],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });
    const providerVerifier = Object.freeze({
      state: 'ready' as const,
      producerKind: 'provider' as const,
      verifier: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
    const releaseVoiceStarts = [vi.fn(), vi.fn()];
    const authorizeVoiceStart = vi
      .fn()
      .mockImplementationOnce(() => releaseVoiceStarts[0])
      .mockImplementationOnce(() => releaseVoiceStarts[1]);
    const voiceVerifier = Object.freeze({
      state: 'ready' as const,
      producerKind: 'voice' as const,
      verifier: Object.freeze({
        verify: vi.fn(async (value: unknown) => value),
        authorizeStart: authorizeVoiceStart,
      }),
    });
    const playbackResult = Object.freeze({
      tts: Object.freeze({
        state: 'degraded' as const,
        reason: 'stopped' as const,
        resultRef: 'voice-tts-result-runtime',
        observedAt: NOW + 13,
      }),
      playback: Object.freeze({
        state: 'degraded' as const,
        reason: 'stopped' as const,
        resultRef: 'voice-playback-result-runtime',
        observedAt: NOW + 14,
      }),
      terminalStatus: 'partial' as const,
    });
    let resolvePlayback!: (value: typeof playbackResult) => void;
    const playbackSettlement = new Promise<typeof playbackResult>((resolve) => {
      resolvePlayback = resolve;
    });
    let abortDelivered = false;
    const voiceController = Object.freeze({
      receipt: Object.freeze({
        sessionId: 'vsession-runtime',
        engineId: 'system:jarvis-prime',
        ttsExecutionId: 'voice-tts-runtime',
        playbackExecutionId: 'voice-playback-runtime',
        ttsStartedAt: NOW + 11,
        playbackStartedAt: NOW + 12,
      }),
      start: vi.fn(() => playbackSettlement),
      verify: vi.fn((candidate: unknown) => candidate === playbackResult),
      abort: vi.fn(() => {
        if (abortDelivered) return 'already_exited' as const;
        abortDelivered = true;
        resolvePlayback(playbackResult);
        return 'signal_delivered' as const;
      }),
      dispose: vi.fn(),
    });
    const voicePlaybackAdapter = Object.freeze({
      prepare: vi.fn(() => voiceController),
    });
    const registeredOwners = new Map<string, { abort(): unknown | Promise<unknown> }>();
    const registerIssuedOwner = vi.fn(
      (registration: { registrationId: string; abort(): unknown | Promise<unknown> }) => {
        registeredOwners.set(registration.registrationId, registration);
        return () => registeredOwners.delete(registration.registrationId);
      },
    );
    const cancellationPlan = Object.freeze({
      accountId: turn.accountId,
      runId: turn.run.id,
      cancellationRequestId: 'voice-cancel-runtime',
    });
    const prepareCancellation = vi.fn(async () => ({
      kind: 'prepared' as const,
      plan: cancellationPlan,
    }));
    let releaseCancellationDelivery!: () => void;
    const cancellationDeliveryGate = new Promise<void>((resolve) => {
      releaseCancellationDelivery = resolve;
    });
    const deliverCancellation = vi.fn(async () => {
      const outcomes = await Promise.all(
        [...registeredOwners.entries()]
          .filter(([ownerId]) => ownerId.endsWith(':tts') || ownerId.endsWith(':playback'))
          .map(([, registration]) => registration.abort()),
      );
      await cancellationDeliveryGate;
      return {
        kind: 'signal_delivered' as const,
        cancellationRequestId: cancellationPlan.cancellationRequestId,
        ownerIds: outcomes
          .filter(
            (outcome): outcome is { kind: 'signal_delivered'; ownerId: string } =>
              typeof outcome === 'object' &&
              outcome !== null &&
              'kind' in outcome &&
              outcome.kind === 'signal_delivered' &&
              'ownerId' in outcome,
          )
          .map((outcome) => outcome.ownerId),
      };
    });
    const sealCancellation = vi.fn(async () => ({
      kind: 'sealed' as const,
      cancellationRequestId: cancellationPlan.cancellationRequestId,
      ownerIds: [`${turn.run.id}:tts`, `${turn.run.id}:playback`],
    }));
    const releaseVoiceHandle = vi.fn();
    const processed: JarvisResponseEnvelope = {
      schemaVersion: 1,
      requestId: turn.attempt.requestId,
      runId: turn.run.id,
      mode: 'direct_answer',
      displayText: 'Runtime voice answer.',
      spokenText: 'Runtime voice answer.',
      parts: [{ kind: 'text', text: 'Runtime voice answer.' }],
      artifactIds: [],
      sourceRefs: [],
      executionState: { status: 'completed', verifiedBy: 'journal', lastEventSeq: 4 },
      provider: turn.model,
      enforcement: {
        linted: true,
        violations: [],
        repairAttempted: false,
        repairSucceeded: false,
        fallbackUsed: false,
      },
      completedAt: NOW + 10,
    };
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(async () => turn.run),
      },
      cancellationDeliveryAuthority: {
        prepare: prepareCancellation,
        deliver: deliverCancellation,
        current: vi.fn(),
        sealWorkflowQuiescence: sealCancellation,
        abandonBeforeDelivery: vi.fn(),
      } as never,
      abortRegistrationAuthority: { registerIssuedOwner },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: {
        ...unavailableVerifiers(),
        provider: providerVerifier,
        voice: voiceVerifier,
      } as never,
      voiceLiveEvidenceStartAuthority: voiceVerifier.verifier,
      voicePlaybackAdapter,
      onVoiceTurnHandleIssued: () => releaseVoiceHandle,
      prepareProvider: vi.fn(async () => ({
        resolveConfiguration: vi.fn(async () => ({
          start: vi.fn(() => ({
            receipt: {
              providerId: 'provider-kernel',
              modelId: 'model-kernel',
              modelSnapshotRef: 'provider-kernel:model-kernel',
              operations: ['generate'] as const,
              startedAt: NOW + 5,
            },
            response: Promise.resolve({
              text: 'Runtime voice answer.',
              provider: turn.model,
              verifiedFacts: {
                executionState: {
                  status: 'completed' as const,
                  verifiedBy: 'journal' as const,
                  lastEventSeq: 4,
                },
                modelState: 'authenticated' as const,
                plugins: [],
                mcps: [],
              },
              completedAt: NOW + 10,
            }),
            abortAfterStart: vi.fn(),
          })),
          dispose: vi.fn(),
        })),
        dispose: vi.fn(),
      })),
      processResponse: vi.fn(async () => processed),
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-voice-uuid',
      now: () => NOW,
    });

    const started = await runtime.kernel.startVoiceTurn(turn);
    expect(started).toMatchObject({
      kind: 'committed',
      value: { result: { response: processed }, handle: expect.any(Object) },
    });
    if (started.kind !== 'committed') throw new Error('expected voice turn');
    const voiceHandle = started.value.handle;
    expect(Object.isFrozen(started.value.handle)).toBe(true);
    expect(await db.messages.count()).toBe(0);
    expect(fromJarvisRunRow((await db.jarvis_runs.get(turn.run.id))!)).toMatchObject({
      status: 'running',
    });

    const messageReads = vi.spyOn(db.messages, 'get');
    const eventAdd = vi
      .spyOn(db.jarvis_events, 'add')
      .mockRejectedValueOnce(new Error('injected response-ready transaction failure'));
    await expect(started.value.handle.runValidatedPlayback()).rejects.toThrow(
      'voice_handle_phase_conflict',
    );
    const commitWithInjectedPayload = started.value.handle.commitResponseReady as (
      injected: unknown,
    ) => ReturnType<typeof voiceHandle.commitResponseReady>;
    const commitPromise = commitWithInjectedPayload.call(started.value.handle, {
      assistantMessage: { id: 'forged-message' },
      spokenText: 'Forged speech.',
    });
    const concurrentCommit = started.value.handle.commitResponseReady();
    await expect(started.value.handle.runValidatedPlayback()).rejects.toThrow(
      'voice_handle_phase_conflict',
    );
    const committed = await commitPromise;
    await expect(concurrentCommit).resolves.toBe(committed);
    expect(committed).toMatchObject({
      kind: 'committed',
      value: {
        committed: true,
        run: { status: 'running' },
        event: { status: 'response_ready' },
        message: { chat_id: turn.chatId },
      },
    });
    expect(await db.messages.count()).toBe(1);
    expect(eventAdd).toHaveBeenCalledTimes(3);
    expect(fromJarvisRunRow((await db.jarvis_runs.get(turn.run.id))!)).toMatchObject({
      status: 'running',
    });
    const providerVerificationOrder = providerVerifier.verifier.verify.mock.invocationCallOrder[0];
    expect(providerVerificationOrder).toBeTypeOf('number');
    expect(
      messageReads.mock.invocationCallOrder.some((order) => order > providerVerificationOrder!),
    ).toBe(true);
    await expect(started.value.handle.commitResponseReady()).resolves.toBe(committed);
    expect(await db.messages.count()).toBe(1);

    const clone = { ...started.value.handle } as typeof started.value.handle;
    await expect(clone.commitResponseReady()).rejects.toThrow('voice_handle_invalid');
    const playback = started.value.handle.runValidatedPlayback();
    await vi.waitFor(() => expect(voiceController.start).toHaveBeenCalledOnce());
    await expect(started.value.handle.runValidatedPlayback()).rejects.toThrow(
      'voice_handle_phase_conflict',
    );
    const cancellation = started.value.handle.requestCancellation();
    await vi.waitFor(() => expect(deliverCancellation).toHaveBeenCalledOnce());
    expect(voiceController.abort).toHaveBeenCalledOnce();
    expect(releaseVoiceHandle).not.toHaveBeenCalled();
    releaseCancellationDelivery();
    await expect(cancellation).resolves.toMatchObject({
      kind: 'intent_committed',
      cancellationRequestId: cancellationPlan.cancellationRequestId,
      aggregate: { kind: 'signal_delivered' },
    });
    await expect(playback).resolves.toMatchObject({
      kind: 'committed',
      value: { committed: true, run: { status: 'cancelled' } },
    });
    expect(sealCancellation).toHaveBeenCalledWith(
      turn.accountId,
      turn.run.id,
      cancellationPlan.cancellationRequestId,
    );
    expect(releaseVoiceHandle).toHaveBeenCalledOnce();
    expect(voicePlaybackAdapter.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: turn.accountId,
        runId: turn.run.id,
        requestId: turn.attempt.requestId,
        attemptNumber: turn.attempt.attemptNumber,
        spokenText: processed.spokenText,
      }),
    );
    expect(voiceController.start).toHaveBeenCalledOnce();
    expect(voiceController.verify).toHaveBeenCalledWith(playbackResult);
    expect(
      authorizeVoiceStart.mock.calls.map(([source]) => source.producerIdentity.engineKind),
    ).toEqual(['tts', 'playback']);
    for (const release of releaseVoiceStarts) expect(release).toHaveBeenCalledOnce();
    expect(
      registerIssuedOwner.mock.calls.map(([registration]) => registration.registrationId),
    ).toEqual(
      expect.arrayContaining([
        `${turn.run.id}:provider`,
        `${turn.run.id}:tts`,
        `${turn.run.id}:playback`,
      ]),
    );
    const voiceSourceRows = (await db.jarvis_events.toArray()).filter(
      (row) => row.producer_source_evidence?.producerKind === 'voice',
    );
    const voiceSourceLineage = voiceSourceRows.map((row) => {
      const source = row.producer_source_evidence;
      if (source?.producerKind !== 'voice') throw new Error('expected voice source');
      return [source.producerIdentity.engineKind, source.phase];
    });
    expect(voiceSourceLineage).toEqual([
      ['tts', 'start'],
      ['playback', 'start'],
      ['tts', 'result'],
      ['playback', 'result'],
      ['playback', 'result'],
    ]);
    expect(voiceSourceRows.at(-1)?.producer_source_evidence).toEqual(
      voiceSourceRows.at(-2)?.producer_source_evidence,
    );
    expect(JSON.stringify(voiceSourceRows)).not.toMatch(/Runtime voice answer|spokenText|audio/i);
    expect(fromJarvisRunRow((await db.jarvis_runs.get(turn.run.id))!)).toMatchObject({
      status: 'cancelled',
    });
    started.value.handle.dispose();
    started.value.handle.dispose();
    await expect(started.value.handle.commitResponseReady()).rejects.toThrow(
      'voice_handle_phase_conflict',
    );
  });

  it('revokes on an account switch after configuration and never starts the provider', async () => {
    const turn = kernelTurn();
    await db.jarvis_runs.add(toJarvisRunRow(turn.run));
    await db.chats.add({
      id: turn.chatId as ChatId,
      workspace_id: turn.workspaceId as WorkspaceId,
      title: 'Runtime kernel revoked',
      mode: 'chat',
      active_agent_ids: [turn.agent.id],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });
    const start = vi.fn();
    const processResponse = vi.fn();
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(async () => turn.run),
      },
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {
        registerIssuedOwner: vi.fn(() => vi.fn()),
      },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn(async () => ({
        resolveConfiguration: vi.fn(async () => {
          useAuthStore.setState({ localUserId: 'account-other' });
          return { start, dispose: vi.fn() };
        }),
        dispose: vi.fn(),
      })),
      processResponse,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-kernel-revoked-uuid',
      now: () => NOW,
    });

    await expect(runtime.kernel.runInitialTurn(turn)).resolves.toEqual({
      kind: 'account_authority_revoked',
    });

    expect(start).not.toHaveBeenCalled();
    expect(processResponse).not.toHaveBeenCalled();
    expect(fromJarvisRunRow((await db.jarvis_runs.get(turn.run.id))!)).toMatchObject({
      status: 'running',
    });
    expect(await db.jarvis_events.count()).toBe(2);
    expect(await db.messages.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
  });

  it('derives a fresh private action lifecycle from the canonical parent and disposes it after success', async () => {
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'request-runtime-action',
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    const expectedApproval = { id: 'jappr_runtime_action' };
    let issued: JarvisIssuedApprovalLifecycle | undefined;
    let abortedDuringCall = true;
    const capability: JarvisApprovalActionCapability = {
      create: vi.fn(async () => {
        abortedDuringCall = issued!.revocationSignal.aborted;
        return expectedApproval as never;
      }),
      decide: vi.fn() as never,
      execute: vi.fn() as never,
      executeAutoApprovedSafe: vi.fn() as never,
    };
    const bindKernelActions: JarvisApprovalActionBinder = vi.fn((lifecycle) => {
      issued = lifecycle;
      return capability;
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-action-uuid',
      now: () => NOW,
    });
    const createInput: CreateJarvisApprovalInput = {
      parentRun,
      attempt: {
        kind: 'initial',
        requestId: 'request-runtime-action',
        runId: parentRun.id,
        attemptNumber: 1,
      },
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'Runtime action' },
      expiresAt: NOW + 60_000,
    };

    await expect(runtime.kernel.actions.create(createInput)).resolves.toEqual({
      kind: 'committed',
      value: expectedApproval,
    });

    expect(bindKernelActions).toHaveBeenCalledOnce();
    expect(issued).toMatchObject({
      accountId: parentRun.accountId,
      runId: parentRun.id,
      requestId: 'request-runtime-action',
      attemptNumber: 1,
    });
    expect(abortedDuringCall).toBe(false);
    expect(issued!.revocationSignal.aborted).toBe(true);
  });

  it('denies stale request scope before binding an action capability', async () => {
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'request-runtime-current',
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    const bindKernelActions = vi.fn() as JarvisApprovalActionBinder;
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-action-stale-uuid',
      now: () => NOW,
    });

    await expect(
      runtime.kernel.actions.create({
        parentRun,
        attempt: {
          kind: 'initial',
          requestId: 'request-runtime-stale',
          runId: parentRun.id,
          attemptNumber: 1,
        },
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'Stale' },
        expiresAt: NOW + 60_000,
      }),
    ).rejects.toThrow('kernel_action_scope_mismatch');
    expect(bindKernelActions).not.toHaveBeenCalled();
  });

  it('maps genuine account revocation during an action and releases the lifecycle once', async () => {
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'request-runtime-revoked-action',
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    let issued: JarvisIssuedApprovalLifecycle | undefined;
    let abortCount = 0;
    const bindKernelActions: JarvisApprovalActionBinder = vi.fn((lifecycle) => {
      issued = lifecycle;
      lifecycle.revocationSignal.addEventListener('abort', () => {
        abortCount += 1;
      });
      return {
        create: vi.fn(async () => {
          useAuthStore.setState({ localUserId: 'account-other' });
          return { id: 'must-not-escape-after-revocation' } as never;
        }),
        decide: vi.fn() as never,
        execute: vi.fn() as never,
        executeAutoApprovedSafe: vi.fn() as never,
      };
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-action-revoked-uuid',
      now: () => NOW,
    });

    await expect(
      runtime.kernel.actions.create({
        parentRun,
        attempt: {
          kind: 'initial',
          requestId: 'request-runtime-revoked-action',
          runId: parentRun.id,
          attemptNumber: 1,
        },
        actionId: 'notes.create',
        actionVersion: 1,
        params: { title: 'Revoked' },
        expiresAt: NOW + 60_000,
      }),
    ).resolves.toEqual({ kind: 'account_authority_revoked' });
    expect(issued!.revocationSignal.aborted).toBe(true);
    expect(abortCount).toBe(1);
  });

  it('persists prepared approval creation and decision through fresh signal-bound lifecycles', async () => {
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'request-runtime-persisted-approval',
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    const approvalId = 'jappr_runtime_persisted';
    const bindKernelActions: JarvisApprovalActionBinder = (lifecycle) => ({
      async create(createInput) {
        const result = await lifecycle.putPreparedApproval({
          ...createInput,
          secretHandleRefs: [],
          approvalId,
          paramsHash: 'params-hash-runtime-persisted',
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'notes',
            resourceId: 'runtime-persisted',
          },
          risk: 'confirm',
          capabilityId: 'capability.notes.write',
          capabilitySnapshotHash: 'capability-hash-runtime-persisted',
          expectedEffect: 'Create the persisted runtime note.',
          createdAt: NOW,
        } as never);
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async decide(decideInput) {
        const result = await lifecycle.decidePreparedApproval({
          approvalId: decideInput.approvalId,
          decision: decideInput.decision,
        });
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      execute: vi.fn() as never,
      executeAutoApprovedSafe: vi.fn() as never,
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-persisted-approval-uuid',
      now: () => NOW,
    });
    const createInput: CreateJarvisApprovalInput = {
      parentRun,
      attempt: {
        kind: 'initial',
        requestId: 'request-runtime-persisted-approval',
        runId: parentRun.id,
        attemptNumber: 1,
      },
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'Persisted runtime approval' },
      expiresAt: NOW + 60_000,
    };

    await expect(runtime.kernel.actions.create(createInput)).resolves.toMatchObject({
      kind: 'committed',
      value: { id: approvalId, status: 'pending' },
    });
    await expect(
      runtime.kernel.actions.decide({
        parentRun,
        approvalId,
        decision: 'approve',
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: { id: approvalId, status: 'approved' },
    });

    expect(fromJarvisApprovalRow((await db.jarvis_approvals.get(approvalId))!)).toMatchObject({
      id: approvalId,
      status: 'approved',
      requestId: 'request-runtime-persisted-approval',
      attemptNumber: 1,
    });
    expect(fromJarvisRunRow((await db.jarvis_runs.get(parentRun.id))!)).toMatchObject({
      status: 'awaiting_approval',
    });
    expect(await db.jarvis_events.count()).toBe(3);
  });

  it('decides an exact typed-chat approval backed by completed provider response evidence', async () => {
    const requestId = 'request-runtime-response-backed-approval';
    const approvalId = 'jappr_runtime_response_backed';
    const parentRun: JarvisRun = {
      ...kernelRun(),
      status: 'running',
      updatedAt: NOW - 5,
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    await db.jarvis_events.add(
      toJarvisEventRow({
        runId: parentRun.id,
        seq: 1,
        idempotencyKey: `provider-start:${requestId}`,
        type: 'model',
        status: 'started',
        title: 'Provider started',
        safeSummary: 'The protected provider request started.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW - 5,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: parentRun.accountId,
          runId: parentRun.id,
          requestId,
          attemptNumber: 1,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider',
            providerId: parentRun.model.providerId,
            modelId: parentRun.model.modelId,
            modelSnapshotRef: `${parentRun.model.providerId}:${parentRun.model.modelId}`,
          },
          resultRef: `jprovider_start:${requestId}`,
          observedAt: NOW - 5,
          phase: 'start',
          state: 'started',
        },
      }),
    );
    const bindKernelActions: JarvisApprovalActionBinder = (lifecycle) => ({
      async create(createInput) {
        const result = await lifecycle.putPreparedApproval({
          ...createInput,
          secretHandleRefs: [],
          approvalId,
          paramsHash: 'params-hash-response-backed',
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'files',
            resourceId: 'response-backed',
          },
          risk: 'confirm',
          capabilityId: 'capability.files.write',
          capabilitySnapshotHash: 'capability-hash-response-backed',
          expectedEffect: 'Create the exact approved file.',
          createdAt: NOW,
        } as never);
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async decide(decideInput) {
        const result = await lifecycle.decidePreparedApproval({
          approvalId: decideInput.approvalId,
          decision: decideInput.decision,
        });
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      execute: vi.fn() as never,
      executeAutoApprovedSafe: vi.fn() as never,
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-response-backed-approval-uuid',
      now: () => NOW,
    });

    await runtime.kernel.actions.create({
      parentRun,
      attempt: { kind: 'initial', requestId, runId: parentRun.id, attemptNumber: 1 },
      actionId: 'files.create',
      actionVersion: 1,
      params: { title: 'Response backed' },
      expiresAt: NOW + 60_000,
    });
    const awaitingRun: JarvisRun = {
      ...parentRun,
      status: 'awaiting_approval',
      updatedAt: NOW,
    };
    await db.jarvis_runs.put(toJarvisRunRow(awaitingRun));
    await expect(
      runtime.kernel.actions.decide({
        parentRun: awaitingRun,
        approvalId,
        decision: 'approve',
      }),
    ).rejects.toThrow('kernel_action_scope_mismatch');
    expect(fromJarvisApprovalRow((await db.jarvis_approvals.get(approvalId))!)).toMatchObject({
      id: approvalId,
      status: 'pending',
    });
    await seedActionResponseCheckpoint({
      parentRun: awaitingRun,
      requestId,
      approvalId,
      actionId: 'files.create',
      providerResultState: 'completed',
    });

    await expect(
      runtime.kernel.actions.decide({
        parentRun: awaitingRun,
        approvalId,
        decision: 'approve',
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: {
        id: approvalId,
        runId: awaitingRun.id,
        requestId,
        attemptNumber: 1,
        status: 'approved',
      },
    });
  });

  it('decides the first files.create in a ten-file batch from the last-card response checkpoint', async () => {
    const requestId = 'request-runtime-files-create-batch';
    const approvalIds = Array.from(
      { length: 10 },
      (_value, index) => `jappr_runtime_files_create_${String(index + 1).padStart(2, '0')}`,
    );
    const parentRun: JarvisRun = {
      ...kernelRun(),
      id: 'run-runtime-files-create-batch',
      chatId: 'chat-runtime-files-create-batch',
      status: 'running',
      updatedAt: NOW - 5,
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    await db.jarvis_events.add(
      toJarvisEventRow({
        runId: parentRun.id,
        seq: 1,
        idempotencyKey: `provider-start:${requestId}`,
        type: 'model',
        status: 'started',
        title: 'Provider started',
        safeSummary: 'The protected provider request started.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW - 5,
        producerSourceEvidence: {
          schemaVersion: 1,
          accountId: parentRun.accountId,
          runId: parentRun.id,
          requestId,
          attemptNumber: 1,
          producerKind: 'provider',
          producerIdentity: {
            producerKind: 'provider',
            providerId: parentRun.model.providerId,
            modelId: parentRun.model.modelId,
            modelSnapshotRef: `${parentRun.model.providerId}:${parentRun.model.modelId}`,
          },
          resultRef: `jprovider_start:${requestId}`,
          observedAt: NOW - 5,
          phase: 'start',
          state: 'started',
        },
      }),
    );
    let nextApprovalIndex = 0;
    const bindKernelActions: JarvisApprovalActionBinder = (lifecycle) => ({
      async create(createInput) {
        const approvalId = approvalIds[nextApprovalIndex];
        nextApprovalIndex += 1;
        if (!approvalId) throw new Error('unexpected_extra_batch_create');
        const result = await lifecycle.putPreparedApproval({
          ...createInput,
          secretHandleRefs: [],
          approvalId,
          paramsHash: `params-hash-files-create-batch-${approvalId}`,
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'files',
            resourceId: approvalId,
          },
          risk: 'confirm',
          capabilityId: 'capability.files.write',
          capabilitySnapshotHash: 'capability-hash-files-create-batch',
          expectedEffect: 'Create the exact approved file.',
          createdAt: NOW,
        } as never);
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async decide(decideInput) {
        const result = await lifecycle.decidePreparedApproval({
          approvalId: decideInput.approvalId,
          decision: decideInput.decision,
        });
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      execute: vi.fn() as never,
      executeAutoApprovedSafe: vi.fn() as never,
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-files-create-batch-uuid',
      now: () => NOW,
    });

    for (const [index, approvalId] of approvalIds.entries()) {
      await runtime.kernel.actions.create({
        parentRun: {
          ...parentRun,
          status: index === 0 ? 'running' : 'awaiting_approval',
          updatedAt: NOW,
        },
        attempt: { kind: 'initial', requestId, runId: parentRun.id, attemptNumber: 1 },
        actionId: 'files.create',
        actionVersion: 1,
        params: { path: `${approvalId}.txt` },
        expiresAt: NOW + 60_000,
      });
    }

    const awaitingRun: JarvisRun = {
      ...parentRun,
      status: 'awaiting_approval',
      updatedAt: NOW,
    };
    await expect(
      runtime.kernel.actions.decide({
        parentRun: awaitingRun,
        approvalId: approvalIds[0]!,
        decision: 'approve',
      }),
    ).rejects.toThrow('kernel_action_scope_mismatch');

    await seedActionResponseCheckpoint({
      parentRun: awaitingRun,
      requestId,
      approvalId: approvalIds[9]!,
      actionId: 'files.create',
      providerResultState: 'completed',
    });

    await expect(
      runtime.kernel.actions.decide({
        parentRun: awaitingRun,
        approvalId: approvalIds[0]!,
        decision: 'approve',
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: {
        id: approvalIds[0],
        runId: awaitingRun.id,
        requestId,
        attemptNumber: 1,
        status: 'approved',
      },
    });
  });

  it('claims and settles an approved action with durable start, result, and live evidence', async () => {
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'request-runtime-action-result',
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    const approvalId = 'jappr_runtime_action_result';
    let effectSignal: AbortSignal | undefined;
    const bindKernelActions: JarvisApprovalActionBinder = (lifecycle) => ({
      async create(createInput) {
        const result = await lifecycle.putPreparedApproval({
          ...createInput,
          secretHandleRefs: [],
          approvalId,
          paramsHash: 'params-hash-runtime-action-result',
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'notes',
            resourceId: 'runtime-action-result',
          },
          risk: 'confirm',
          capabilityId: 'capability.notes.write',
          capabilitySnapshotHash: 'capability-hash-runtime-action-result',
          expectedEffect: 'Create the runtime action result note.',
          createdAt: NOW,
        } as never);
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async decide(decideInput) {
        const result = await lifecycle.decidePreparedApproval({
          approvalId: decideInput.approvalId,
          decision: decideInput.decision,
        });
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async execute(executeInput) {
        const claim = await lifecycle.claimApprovedExecution({
          approvalId: executeInput.approvalId,
          producerKind: 'action',
          ownerId: `approval:${executeInput.approvalId}`,
          evidenceRef: `approval:${executeInput.approvalId}:claim`,
          startedAt: NOW + 1,
        });
        if (claim.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        const execution = claim.value;
        const started = execution.beginExternalEffect((signal) => {
          effectSignal = signal;
          return { completion: Promise.resolve('created') };
        });
        if (started.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        await started.value.completion;
        const settled = await execution.recordResult({
          state: 'completed',
          resultRef: 'jresult_runtime_action_result',
          completedAt: NOW + 2,
        });
        execution.dispose();
        if (settled.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return { kind: 'settled' as const, result: { ok: true as const, summary: 'created' } };
      },
      executeAutoApprovedSafe: vi.fn() as never,
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: actionReadyVerifiers(db) as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-action-result-uuid',
      now: () => NOW,
    });
    const createInput: CreateJarvisApprovalInput = {
      parentRun,
      attempt: {
        kind: 'initial',
        requestId: 'request-runtime-action-result',
        runId: parentRun.id,
        attemptNumber: 1,
      },
      actionId: 'notes.create',
      actionVersion: 1,
      params: { title: 'Runtime action result' },
      expiresAt: NOW + 60_000,
    };
    await runtime.kernel.actions.create(createInput);
    await runtime.kernel.actions.decide({ parentRun, approvalId, decision: 'approve' });

    await expect(
      runtime.kernel.actions.execute({
        parentRun,
        approvalId,
        context: { source: 'ai' },
      }),
    ).resolves.toEqual({
      kind: 'committed',
      value: { kind: 'settled', result: { ok: true, summary: 'created' } },
    });

    expect(effectSignal).toBeDefined();
    expect(effectSignal!.aborted).toBe(true);
    expect(fromJarvisApprovalRow((await db.jarvis_approvals.get(approvalId))!)).toMatchObject({
      status: 'consumed',
      consumedAt: NOW + 1,
    });
    const events = await db.jarvis_events.orderBy('[run_id+seq]').toArray();
    expect(events.map((event) => event.status)).toEqual([
      'awaiting_approval',
      'pending',
      'approved',
      'consequential_effect_claimed',
      'ready',
      'completed',
      'completed',
    ]);
  });

  it('projects a response-backed terminal handoff before native result settlement', async () => {
    const requestId = 'request-runtime-terminal-response';
    const approvalId = 'jappr_runtime_terminal_response';
    const actionId = 'terminal.execute';
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId,
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    let ownedExecution: JarvisTerminalOwnedExecution | undefined;
    const bindKernelActions: JarvisApprovalActionBinder = (lifecycle) => ({
      async create(createInput) {
        const result = await lifecycle.putPreparedApproval({
          ...createInput,
          secretHandleRefs: [],
          approvalId,
          paramsHash: 'params-hash-runtime-terminal-response',
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'terminal',
            resourceId: 'runtime-terminal-response',
          },
          risk: 'confirm',
          capabilityId: 'capability.terminal.execute',
          capabilitySnapshotHash: 'capability-hash-runtime-terminal-response',
          expectedEffect: 'Run the approved terminal action.',
          createdAt: NOW,
        } as never);
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async decide(decideInput) {
        const result = await lifecycle.decidePreparedApproval({
          approvalId: decideInput.approvalId,
          decision: decideInput.decision,
        });
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async execute(executeInput) {
        const claim = await lifecycle.claimApprovedExecution({
          approvalId: executeInput.approvalId,
          producerKind: 'terminal',
          ownerId: `approval:${executeInput.approvalId}`,
          evidenceRef: `approval:${executeInput.approvalId}:terminal-claim`,
          startedAt: NOW + 2,
        });
        if (claim.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        const executionId = 'jterminal_execution_runtime_response';
        const handoff = claim.value.transferTerminalOwnership({
          executionId,
          acceptor: {
            acceptIssuedExecution(input) {
              ownedExecution = input.execution;
              return Object.freeze({
                executionId,
                ownerId: input.ownerId,
                [jarvisTerminalHandoffReceiptBrand]: true as const,
              });
            },
          },
        });
        if (handoff.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return {
          kind: 'handoff_pending' as const,
          executorKind: 'terminal' as const,
          ownerId: claim.value.ownerId,
          result: { ok: true as const, summary: 'terminal handed off' },
        };
      },
      executeAutoApprovedSafe: vi.fn() as never,
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: actionReadyVerifiers(db) as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-terminal-response-uuid',
      now: () => NOW + 2,
    });
    const attempt = {
      kind: 'initial' as const,
      requestId,
      runId: parentRun.id,
      attemptNumber: 1 as const,
    };
    await runtime.kernel.actions.create({
      parentRun,
      attempt,
      actionId,
      actionVersion: 1,
      params: {},
      expiresAt: NOW + 60_000,
    });
    await seedActionResponseCheckpoint({ parentRun, requestId, approvalId, actionId });
    await runtime.kernel.actions.decide({ parentRun, approvalId, decision: 'approve' });

    await expect(
      runtime.kernel.actions.execute({ parentRun, approvalId, context: { source: 'ai' } }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: { kind: 'handoff_pending', executorKind: 'terminal' },
    });
    expect((await db.messages.get(`msg_${requestId}` as never))?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'queued' })]),
    );
    expect(fromJarvisRunRow((await db.jarvis_runs.get(parentRun.id))!).status).toBe('running');

    await expect(
      ownedExecution!.recordResult({
        state: 'completed',
        resultRef: 'jresult_runtime_terminal_response',
        completedAt: NOW + 4,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    ownedExecution!.dispose();
    expect((await db.messages.get(`msg_${requestId}` as never))?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'success' })]),
    );
    expect(fromJarvisRunRow((await db.jarvis_runs.get(parentRun.id))!)).toMatchObject({
      status: 'completed',
      completedAt: NOW + 4,
    });
  });

  it('retains terminal ownership through cancellation intent and native verification', async () => {
    const parentRun: JarvisRun = {
      ...kernelRun(),
      source: 'schedule',
      status: 'running',
      updatedAt: NOW - 5,
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'request-runtime-terminal-cancel',
          state: 'provider_in_flight',
          startedEventSeq: 1,
          effectBarrier: { state: 'open', version: 0, updatedAt: NOW - 5 },
          createdAt: NOW - 5,
          updatedAt: NOW - 5,
        },
      ],
    };
    await db.jarvis_runs.add(toJarvisRunRow(parentRun));
    const approvalId = 'jappr_runtime_terminal_cancel';
    let ownedExecution: JarvisTerminalOwnedExecution | undefined;
    const bindKernelActions: JarvisApprovalActionBinder = (lifecycle) => ({
      async create(createInput) {
        const result = await lifecycle.putPreparedApproval({
          ...createInput,
          secretHandleRefs: [],
          approvalId,
          paramsHash: 'params-hash-runtime-terminal-cancel',
          targetSnapshot: {
            kind: 'app_resource',
            namespace: 'terminal',
            resourceId: 'runtime-terminal-cancel',
          },
          risk: 'dangerous',
          capabilityId: 'capability.terminal.execute',
          capabilitySnapshotHash: 'capability-hash-runtime-terminal-cancel',
          expectedEffect: 'Run the approved terminal command.',
          createdAt: NOW,
        } as never);
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async decide(decideInput) {
        const result = await lifecycle.decidePreparedApproval({
          approvalId: decideInput.approvalId,
          decision: decideInput.decision,
        });
        if (result.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return result.value;
      },
      async execute(executeInput) {
        const claim = await lifecycle.claimApprovedExecution({
          approvalId: executeInput.approvalId,
          producerKind: 'terminal',
          ownerId: `approval:${executeInput.approvalId}`,
          evidenceRef: `approval:${executeInput.approvalId}:terminal-claim`,
          startedAt: NOW + 3,
        });
        if (claim.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        const executionId = 'jterminal_execution_runtime_cancel';
        const handoff = claim.value.transferTerminalOwnership({
          executionId,
          acceptor: {
            acceptIssuedExecution(input) {
              ownedExecution = input.execution;
              return Object.freeze({
                executionId,
                ownerId: input.ownerId,
                [jarvisTerminalHandoffReceiptBrand]: true as const,
              });
            },
          },
        });
        if (handoff.kind !== 'committed') throw new Error('unexpected_authority_revocation');
        return {
          kind: 'handoff_pending' as const,
          executorKind: 'terminal' as const,
          ownerId: claim.value.ownerId,
          result: { ok: true as const, summary: 'terminal started' },
        };
      },
      executeAutoApprovedSafe: vi.fn() as never,
    });
    const cancellationPlan = {
      accountId: parentRun.accountId,
      runId: parentRun.id,
      cancellationRequestId: 'jcancel_runtime_terminal',
    };
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun: vi.fn() } as never,
      cancellationDeliveryAuthority: {
        prepare: vi.fn(async () => ({
          kind: 'prepared' as const,
          plan: cancellationPlan as never,
        })),
        deliver: vi.fn(async () => ({
          kind: 'signal_delivered' as const,
          cancellationRequestId: cancellationPlan.cancellationRequestId,
          ownerIds: ['terminal-owner-runtime'],
        })),
        current: vi.fn() as never,
        sealWorkflowQuiescence: vi.fn() as never,
        abandonBeforeDelivery: vi.fn(),
      },
      abortRegistrationAuthority: {} as never,
      bindKernelActions,
      liveEvidenceVerifiers: actionReadyVerifiers(db) as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-terminal-cancel-uuid',
      now: () => NOW + 2,
    });
    const createInput: CreateJarvisApprovalInput = {
      parentRun,
      attempt: {
        kind: 'initial',
        requestId: 'request-runtime-terminal-cancel',
        runId: parentRun.id,
        attemptNumber: 1,
      },
      actionId: 'terminal.execute',
      actionVersion: 1,
      params: { commandRef: 'approved-command-ref' },
      expiresAt: NOW + 60_000,
    };
    await runtime.kernel.actions.create(createInput);
    await runtime.kernel.actions.decide({ parentRun, approvalId, decision: 'approve' });
    await expect(
      runtime.kernel.actions.execute({
        parentRun,
        approvalId,
        context: { source: 'ai' },
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: { kind: 'handoff_pending', executorKind: 'terminal' },
    });

    expect(ownedExecution).toBeDefined();
    await expect(ownedExecution!.requestCancellation()).resolves.toMatchObject({
      kind: 'intent_committed',
      cancellationRequestId: cancellationPlan.cancellationRequestId,
    });
    await expect(
      ownedExecution!.recordCancellationVerified({
        cancellationRequestId: cancellationPlan.cancellationRequestId,
        resultRef: 'jresult_runtime_terminal_cancelled',
        verifiedAt: NOW + 4,
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: { run: { status: 'cancelled' }, event: { status: 'cancelled' } },
    });
    ownedExecution!.dispose();

    expect(fromJarvisRunRow((await db.jarvis_runs.get(parentRun.id))!)).toMatchObject({
      status: 'cancelled',
      completedAt: NOW + 4,
    });
    const events = await db.jarvis_events.orderBy('[run_id+seq]').toArray();
    expect(events.map((event) => event.status)).toEqual([
      'awaiting_approval',
      'pending',
      'approved',
      'consequential_effect_claimed',
      'ready',
      'cancellation_requested',
      'degraded',
      'cancelled',
      'degraded',
    ]);
  });

  it('commits a signal-bound cancellation intent before delivering it to the run owner', async () => {
    const turn = kernelTurn();
    await db.jarvis_runs.add(toJarvisRunRow(turn.run));
    const plan = Object.freeze({
      accountId: turn.accountId,
      runId: turn.run.id,
      cancellationRequestId: 'cancel-runtime-kernel',
    });
    const prepare = vi.fn(async () => ({ kind: 'prepared' as const, plan: plan as never }));
    const deliver = vi.fn(async () => {
      const rows = await db.jarvis_events.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        run_id: turn.run.id,
        status: 'cancellation_requested',
        idempotency_key: plan.cancellationRequestId,
      });
      return {
        kind: 'signal_delivered' as const,
        cancellationRequestId: plan.cancellationRequestId,
        ownerIds: [`${turn.run.id}:provider`],
      };
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(async () => turn.run),
      },
      cancellationDeliveryAuthority: {
        prepare,
        deliver,
        current: vi.fn(),
        sealWorkflowQuiescence: vi.fn() as never,
        abandonBeforeDelivery: vi.fn(),
      },
      abortRegistrationAuthority: {
        registerIssuedOwner: vi.fn(() => vi.fn()),
      },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'runtime-kernel-cancel-uuid',
      now: () => NOW,
    });

    await expect(
      runtime.kernel.requestCancellation({
        accountId: turn.accountId,
        runId: turn.run.id,
      }),
    ).resolves.toEqual({
      kind: 'intent_committed',
      requestState: 'new',
      authorityState: 'current',
      cancellationRequestId: plan.cancellationRequestId,
      aggregate: {
        kind: 'signal_delivered',
        ownerIds: [`${turn.run.id}:provider`],
      },
    });
    expect(prepare).toHaveBeenCalledWith(turn.accountId, turn.run.id);
    expect(deliver).toHaveBeenCalledWith(plan);
  });
});

describe('createJarvisKernelRuntime scheduled attempt authority', () => {
  let db: JarvisDexie;

  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('kernel-runtime-schedule'), TEST_INDEXED_DB);
    await db.open();
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-kernel' });
  });

  afterEach(async () => {
    await db.delete();
  });

  it('allocates, prepares, and atomically begins one snapshot-bound opaque occurrence', async () => {
    const repositories = createJarvisRepositories(db);
    const journal = createJarvisExecutionJournal(repositories, { now: () => NOW });
    const basis = kernelTurn();
    await db.chats.add({
      id: basis.chatId as ChatId,
      workspace_id: basis.workspaceId as WorkspaceId,
      title: 'Scheduled runtime kernel',
      mode: 'chat',
      active_agent_ids: [basis.agent.id],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });
    const scheduleVerifier = createJarvisScheduleLiveEvidenceVerifier({
      runs: repositories.run,
      events: repositories.event,
    });
    const providerVerifier = Object.freeze({
      state: 'ready' as const,
      producerKind: 'provider' as const,
      verifier: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
    const providerStart = vi.fn(() => ({
      receipt: {
        providerId: basis.model.providerId,
        modelId: basis.model.modelId,
        modelSnapshotRef: `${basis.model.providerId}:${basis.model.modelId}`,
        operations: ['generate'] as const,
        startedAt: NOW + 5,
      },
      response: Promise.resolve({
        text: 'Scheduled verified answer.',
        provider: basis.model,
        verifiedFacts: {
          executionState: {
            status: 'completed' as const,
            verifiedBy: 'journal' as const,
            lastEventSeq: 4,
          },
          modelState: 'authenticated' as const,
          plugins: [],
          mcps: [],
        },
        completedAt: NOW + 10,
      }),
      abortAfterStart: vi.fn(),
    }));
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: { registerIssuedOwner: vi.fn(() => vi.fn()) },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: {
        ...unavailableVerifiers(),
        provider: providerVerifier,
        schedule: { state: 'ready', verifier: scheduleVerifier },
      } as never,
      resolveScheduledOccurrence: vi.fn(async () => ({
        workspaceId: basis.workspaceId,
        chatId: basis.chatId,
        userMessageId: basis.userMessageId,
        agent: basis.agent,
        interactionMode: 'agent' as const,
        userText: 'Run the saved schedule prompt.',
        messageHistory: [],
        model: basis.model,
        identity: basis.identity,
        profile: basis.profile,
        capabilities: basis.capabilities,
        context: basis.context,
        outputContract: { ...basis.outputContract, voiceDelivery: 'none' as const },
      })),
      prepareProvider: vi.fn(async () => ({
        resolveConfiguration: vi.fn(async () => ({ start: providerStart, dispose: vi.fn() })),
        dispose: vi.fn(),
      })),
      processResponse: vi.fn(async (raw, request) => ({
        schemaVersion: 1 as const,
        requestId: request.requestId,
        runId: request.runId,
        mode: 'direct_answer' as const,
        displayText: raw.text,
        spokenText: raw.text,
        parts: [{ kind: 'text' as const, text: raw.text }],
        artifactIds: [],
        sourceRefs: [],
        executionState: {
          status: 'completed' as const,
          verifiedBy: 'journal' as const,
          lastEventSeq: 4,
        },
        provider: raw.provider,
        enforcement: {
          linted: true,
          violations: [],
          repairAttempted: false,
          repairSucceeded: false,
          fallbackUsed: false,
        },
        completedAt: raw.completedAt,
      })),
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'scheduled-runtime-uuid',
      now: () => NOW,
    });

    const allocated = await runtime.kernel.allocateScheduledOccurrence({
      accountId: basis.accountId,
      eventId: 'event-scheduled-runtime',
      dueAt: NOW - 100,
    });
    expect(allocated.kind).toBe('committed');
    if (allocated.kind !== 'committed') throw new Error('expected allocation');
    expect(Object.keys(allocated.value)).toEqual([]);

    await expect(
      runtime.kernel.prepareScheduledAttempt({
        allocation: Object.freeze({}) as JarvisAllocatedScheduledOccurrence,
      }),
    ).rejects.toThrow('kernel_schedule_allocation_invalid');

    const prepared = await runtime.kernel.prepareScheduledAttempt({ allocation: allocated.value });
    expect(Object.keys(prepared)).toEqual([]);
    const begun = await runtime.kernel.beginPreparedScheduledAttempt({ prepared });
    expect(begun.kind).toBe('committed');
    if (begun.kind !== 'committed') throw new Error('expected scheduled begin');
    expect(Object.keys(begun.value).sort()).toEqual(['dispose', 'requestCancellation']);

    const rows = await db.jarvis_runs.toArray();
    expect(rows).toHaveLength(1);
    const persisted = fromJarvisRunRow(rows[0]!);
    expect(persisted).toMatchObject({
      source: 'schedule',
      status: 'running',
      scheduledRetrySnapshot: {
        schemaVersion: 1,
        accountId: basis.accountId,
        eventId: 'event-scheduled-runtime',
        dueAt: NOW - 100,
        logicalAttempt: 0,
        request: {
          runId: persisted.id,
          surface: 'schedule',
          userText: 'Run the saved schedule prompt.',
        },
      },
      transportAttempts: [
        {
          schemaVersion: 1,
          attemptNumber: 1,
          kind: 'initial',
          requestId: 'jreq_scheduled-runtime-uuid',
          state: 'provider_in_flight',
        },
      ],
    });
    await expect(
      runtime.kernel.dispatchPreparedScheduledAttempt({ prepared, handle: begun.value }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: {
        kind: 'committed',
        result: { response: { displayText: 'Scheduled verified answer.' } },
      },
    });
    expect(providerStart).toHaveBeenCalledOnce();
    const events = await repositories.event.listByRun(basis.accountId, persisted.id, { limit: 50 });
    const canonical = events.find(
      (event) => event.canonicalResultEvidence?.kind === 'kernel_turn_committed',
    );
    const scheduleResult = events.find(
      (event) =>
        event.producerSourceEvidence?.producerKind === 'schedule' &&
        event.producerSourceEvidence.phase === 'result',
    );
    const scheduleCompleted = events.find(
      (event) =>
        event.liveEvidence?.producerKind === 'schedule' &&
        event.liveEvidence.transition === 'completed',
    );
    expect(canonical).toBeDefined();
    expect(scheduleResult?.producerSourceEvidence).toMatchObject({
      resultAuthority: {
        runId: persisted.id,
        eventSeq: canonical!.seq,
        evidenceRef: canonical!.canonicalResultEvidence!.resultRef,
      },
    });
    expect(scheduleCompleted?.liveEvidence).toMatchObject({
      registrationId: `${persisted.id}:schedule:1`,
      resultEventSeq: scheduleResult!.seq,
      previousProofRef: expect.stringMatching(/^jlive_/),
    });
    expect(canonical!.seq).toBeLessThan(scheduleResult!.seq);
    expect(scheduleResult!.seq).toBeLessThan(scheduleCompleted!.seq);
    expect(fromJarvisRunRow((await db.jarvis_runs.get(persisted.id))!)).toMatchObject({
      status: 'completed',
      completedAt: NOW + 10,
    });
    await expect(runtime.kernel.beginPreparedScheduledAttempt({ prepared })).rejects.toThrow(
      'kernel_schedule_preparation_invalid',
    );
    begun.value.dispose();
  });

  it('fails closed before resolving changed settings for a snapshotless run from an earlier runtime', async () => {
    const repositories = createJarvisRepositories(db);
    const journal = createJarvisExecutionJournal(repositories, { now: () => NOW });
    const basis = kernelTurn();
    const originalResolver = vi.fn(async () => ({
      workspaceId: basis.workspaceId,
      chatId: basis.chatId,
      userMessageId: basis.userMessageId,
      agent: basis.agent,
      interactionMode: 'agent' as const,
      userText: 'Original immutable schedule prompt.',
      messageHistory: [],
      model: basis.model,
      identity: basis.identity,
      profile: basis.profile,
      capabilities: basis.capabilities,
      context: basis.context,
      outputContract: { ...basis.outputContract, voiceDelivery: 'none' as const },
    }));
    const runtimeA = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: { registerIssuedOwner: vi.fn(() => vi.fn()) },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      resolveScheduledOccurrence: originalResolver,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'snapshotless-runtime-a',
      now: () => NOW,
    });
    await expect(
      runtimeA.kernel.allocateScheduledOccurrence({
        accountId: basis.accountId,
        eventId: 'event-snapshotless-restart',
        dueAt: NOW - 200,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const snapshotless = fromJarvisRunRow((await db.jarvis_runs.toArray())[0]!);
    expect(snapshotless).toMatchObject({
      source: 'schedule',
      status: 'queued',
    });
    expect(snapshotless).not.toHaveProperty('scheduledRetrySnapshot');
    expect(snapshotless).not.toHaveProperty('transportAttempts');

    useAuthStore.setState({ localUserId: 'account-other' });
    useAuthStore.setState({ localUserId: basis.accountId });
    const changedResolver = vi.fn(async () => ({
      ...(await originalResolver()),
      userText: 'Changed settings must never bind to the old run.',
    }));
    const runtimeB = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: { registerIssuedOwner: vi.fn(() => vi.fn()) },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      resolveScheduledOccurrence: changedResolver,
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'snapshotless-runtime-b',
      now: () => NOW + 1,
    });

    await expect(
      runtimeB.kernel.allocateScheduledOccurrence({
        accountId: basis.accountId,
        eventId: 'event-snapshotless-restart',
        dueAt: NOW - 200,
      }),
    ).rejects.toThrow('kernel_schedule_unbound_restart');
    expect(changedResolver).not.toHaveBeenCalled();
    expect(fromJarvisRunRow((await db.jarvis_runs.toArray())[0]!)).toEqual(snapshotless);
    expect(await db.jarvis_events.count()).toBe(0);
  });

  it('settles a pre-byte schedule failure as retryable and revalidates its durable lifecycle tail', async () => {
    const repositories = createJarvisRepositories(db);
    let clock = NOW;
    const now = () => clock++;
    const journal = createJarvisExecutionJournal(repositories, { now });
    const basis = kernelTurn();
    await db.chats.add({
      id: basis.chatId as ChatId,
      workspace_id: basis.workspaceId as WorkspaceId,
      title: 'Scheduled transport retry runtime',
      mode: 'chat',
      active_agent_ids: [basis.agent.id],
      created_at: NOW - 20,
      updated_at: NOW - 20,
    });
    const scheduleVerifier = createJarvisScheduleLiveEvidenceVerifier({
      runs: repositories.run,
      events: repositories.event,
    });
    const providerVerifier = Object.freeze({
      async verify(evidence: JarvisCanonicalLiveProducerEvidence<'provider'>) {
        const event = await repositories.event.getBySeq(
          evidence.accountId,
          evidence.runId,
          evidence.resultEventSeq,
        );
        const source = event?.producerSourceEvidence;
        return event &&
          source?.producerKind === 'provider' &&
          event.seq === evidence.resultEventSeq &&
          source.accountId === evidence.accountId &&
          source.runId === evidence.runId &&
          source.requestId === evidence.requestId &&
          source.attemptNumber === evidence.attemptNumber &&
          source.resultRef === evidence.resultRef &&
          source.observedAt === evidence.verifiedAt &&
          source.state === evidence.state &&
          source.producerIdentity.providerId === evidence.producerIdentity.providerId &&
          source.producerIdentity.modelId === evidence.producerIdentity.modelId &&
          source.producerIdentity.modelSnapshotRef === evidence.producerIdentity.modelSnapshotRef
          ? Object.freeze(structuredClone(evidence))
          : null;
      },
    });
    const providerEvidenceAuthority = createJarvisProviderAttemptEvidenceAuthority({
      async sha256(canonical) {
        const digest = await globalThis.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(canonical),
        );
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      },
    });
    let requestOrdinal = 0;
    const prepareProvider = vi.fn(async (providerInput) => {
      const tracker = providerEvidenceAuthority.begin({
        accountId: providerInput.accountId,
        runId: providerInput.runId,
        requestId: providerInput.requestId,
        attemptNumber: providerInput.attemptNumber,
        providerId: providerInput.model.providerId,
        modelId: providerInput.model.modelId,
      });
      return {
        resolveConfiguration: vi.fn(async () => {
          const classification = await providerEvidenceAuthority.classifyFailure(tracker, {
            failureCategory: 'network_unavailable',
            failedAt: now(),
          });
          return {
            start: vi.fn(() => {
              const response = Promise.reject(
                new JarvisProviderAttemptFailureError(classification),
              );
              void response.catch(() => undefined);
              return {
                receipt: {
                  providerId: providerInput.model.providerId,
                  modelId: providerInput.model.modelId,
                  modelSnapshotRef: `jmodel_${providerInput.model.providerId}_${providerInput.model.modelId}_${providerInput.model.capturedAt}`,
                  operations: ['generate'] as const,
                  startedAt: now(),
                },
                response,
                abortAfterStart: vi.fn(),
              };
            }),
            dispose: vi.fn(),
          };
        }),
        dispose: vi.fn(),
      };
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: { registerIssuedOwner: vi.fn(() => vi.fn()) },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: {
        ...unavailableVerifiers(),
        provider: { state: 'ready', verifier: providerVerifier },
        schedule: { state: 'ready', verifier: scheduleVerifier },
      } as never,
      resolveScheduledOccurrence: vi.fn(async () => ({
        workspaceId: basis.workspaceId,
        chatId: basis.chatId,
        userMessageId: basis.userMessageId,
        agent: basis.agent,
        interactionMode: 'agent' as const,
        userText: 'Run the immutable retry fixture.',
        messageHistory: [],
        model: basis.model,
        identity: basis.identity,
        profile: basis.profile,
        capabilities: basis.capabilities,
        context: basis.context,
        outputContract: { ...basis.outputContract, voiceDelivery: 'none' as const },
      })),
      providerAttemptEvidence: {
        revalidateFailure:
          providerEvidenceAuthority.revalidateFailure.bind(providerEvidenceAuthority),
      },
      prepareProvider,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => `schedule-retry-${++requestOrdinal}`,
      now,
    });

    const allocated = await runtime.kernel.allocateScheduledOccurrence({
      accountId: basis.accountId,
      eventId: 'event-schedule-retry-runtime',
      dueAt: NOW - 100,
    });
    expect(allocated.kind).toBe('committed');
    if (allocated.kind !== 'committed') throw new Error('expected schedule allocation');
    const prepared = await runtime.kernel.prepareScheduledAttempt({ allocation: allocated.value });
    const begun = await runtime.kernel.beginPreparedScheduledAttempt({ prepared });
    expect(begun.kind).toBe('committed');
    if (begun.kind !== 'committed') throw new Error('expected scheduled begin');
    await expect(
      runtime.kernel.dispatchPreparedScheduledAttempt({ prepared, handle: begun.value }),
    ).resolves.toEqual({
      kind: 'committed',
      value: { kind: 'pre_effect_transport_failure' },
    });

    const settled = await runtime.kernel.settleScheduledTransportFailure({ handle: begun.value });
    expect(settled).toMatchObject({
      kind: 'committed',
      value: {
        kind: 'retryable',
        run: {
          status: 'running',
          transportAttempts: [{ state: 'retryable_failed' }],
        },
      },
    });
    const runId = (await db.jarvis_runs.toArray())[0]!.id;
    const persisted = fromJarvisRunRow((await db.jarvis_runs.get(runId))!);
    expect(persisted).toMatchObject({
      status: 'running',
      transportAttempts: [
        {
          state: 'retryable_failed',
          effectBarrier: { state: 'open', version: 0 },
          zeroEffectEvidence: { executorClaims: { count: 0 } },
        },
      ],
    });

    const loaded = await runtime.kernel.loadScheduledRun({
      accountId: basis.accountId,
      runId,
    });
    expect(loaded.kind).toBe('committed');
    if (loaded.kind !== 'committed' || !loaded.value) {
      throw new Error('expected retry allocation');
    }
    const retryPrepared = await runtime.kernel.prepareScheduledAttempt({
      allocation: loaded.value,
    });
    const retryBegun = await runtime.kernel.beginPreparedScheduledAttempt({
      prepared: retryPrepared,
    });
    expect(retryBegun.kind).toBe('committed');
    expect(fromJarvisRunRow((await db.jarvis_runs.get(runId))!)).toMatchObject({
      status: 'running',
      transportAttempts: [
        { state: 'retryable_failed', effectBarrier: { state: 'sealed_for_retry' } },
        { state: 'provider_in_flight', kind: 'transport_retry', attemptNumber: 2 },
      ],
    });
  });
});

describe('createJarvisKernelRuntime Hive worker authority', () => {
  let db: JarvisDexie;

  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('kernel-runtime-hive'), TEST_INDEXED_DB);
    await db.open();
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-kernel' });
  });

  afterEach(async () => {
    await db.delete();
  });

  it('binds one immutable plan and derives one opaque worker from parent plus step only', async () => {
    const repositories = createJarvisRepositories(db);
    const journal = createJarvisExecutionJournal(repositories, { now: () => NOW });
    const basis = kernelTurn();
    const parent = await journal.allocateRun({
      id: 'jrun_hive_parent',
      accountId: basis.accountId,
      workspaceId: basis.workspaceId,
      chatId: basis.chatId,
      source: 'hive_final',
      agentId: basis.agent.id,
      identityVersion: basis.identity.identityVersion,
      profileRevisionId: basis.profile.revisionId,
      model: basis.model,
    });
    const plan: JarvisHiveStackPlanV1 = {
      schemaVersion: 1,
      accountId: parent.accountId,
      parentRunId: parent.id,
      stackId: 'stack-runtime-hive',
      steps: [
        {
          schemaVersion: 1,
          stepId: 'step-research',
          label: 'Research',
          workerId: 'worker-research',
          agent: {
            id: basis.agent.id,
            slug: 'researcher',
            builtin: true,
            name: 'Researcher',
            description: 'Research specialist',
            systemPrompt: 'Keep this exact specialist prompt.',
            toolsAllowed: [],
            memoryScope: 'workspace',
            capabilities: ['research'],
            createdAt: NOW - 20,
            updatedAt: NOW - 10,
          },
          model: basis.model,
          messages: [{ role: 'user', content: 'Research this exact topic.' }],
        },
        {
          schemaVersion: 1,
          stepId: 'step-polish',
          label: 'Polish',
          workerId: 'worker-polish',
          agent: {
            id: basis.agent.id,
            slug: 'polisher',
            builtin: true,
            name: 'Polisher',
            description: 'Polish specialist',
            systemPrompt: 'Keep this exact polish prompt.',
            toolsAllowed: [],
            memoryScope: 'workspace',
            capabilities: ['writing'],
            createdAt: NOW - 20,
            updatedAt: NOW - 10,
          },
          model: basis.model,
          messages: [{ role: 'user', content: 'Research this exact topic.' }],
        },
      ],
    };
    const execute = vi.fn(async () => ({
      status: 'completed' as const,
      providerId: basis.model.providerId,
      modelId: basis.model.modelId,
      text: 'Verified worker output.',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
      observedAt: NOW + 10,
    }));
    const hiveVerifier = createJarvisHiveLiveEvidenceVerifier({
      runs: repositories.run,
      events: repositories.event,
    });
    const runtime = createJarvisKernelRuntime({
      db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal,
      cancellationDeliveryAuthority: {} as never,
      abortRegistrationAuthority: { registerIssuedOwner: vi.fn(() => vi.fn()) },
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: {
        ...unavailableVerifiers(),
        hive: { state: 'ready', verifier: hiveVerifier },
      } as never,
      hiveWorkerExecutor: { execute },
      prepareProvider: vi.fn() as never,
      processResponse: vi.fn() as never,
      takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 'hive-runtime-uuid',
      now: () => NOW,
    });

    const boundPlan = await runtime.kernel.bindHiveStackPlan({ plan });
    expect(boundPlan).toMatchObject({
      kind: 'committed',
      value: { hiveStackPlan: plan },
    });
    if (boundPlan.kind !== 'committed') throw new Error('expected bound Hive plan');
    const opened = await runtime.kernel.openHiveWorker({
      parentRunId: parent.id,
      stepId: 'step-research',
    });
    expect(opened.kind).toBe('committed');
    if (opened.kind !== 'committed') throw new Error('expected Hive worker handle');
    expect(Object.keys(opened.value).sort()).toEqual(['dispose', 'execute', 'requestCancellation']);
    const completed = await opened.value.execute();
    expect(completed).toMatchObject({
      kind: 'committed',
      value: {
        result: {
          workerId: 'worker-research',
          stepId: 'step-research',
          status: 'completed',
          text: 'Verified worker output.',
        },
      },
    });
    if (completed.kind !== 'committed') throw new Error('expected first Hive outcome');
    expect(execute).toHaveBeenCalledWith({
      agent: expect.objectContaining({
        slug: 'researcher',
        system_prompt: 'Keep this exact specialist prompt.',
      }),
      messages: [{ role: 'user', content: 'Research this exact topic.' }],
      signal: expect.any(AbortSignal),
      connectionId: basis.model.connectionId,
    });
    await expect(
      runtime.kernel.openHiveWorker({
        parentRunId: parent.id,
        stepId: 'step-research',
      }),
    ).rejects.toThrow('kernel_hive_step_consumed');
    const child = (await db.jarvis_runs.toArray())
      .map(fromJarvisRunRow)
      .find((candidate) => candidate.parentRunId === parent.id);
    expect(child).toMatchObject({ status: 'completed', parentRunId: parent.id });
    const childEvents = await repositories.event.listByRun(parent.accountId, child!.id, {
      limit: 10,
    });
    expect(childEvents.at(-1)?.canonicalResultEvidence).toMatchObject({
      kind: 'hive_child_provider_result',
      parentRunId: parent.id,
      stepId: 'step-research',
    });
    const parentEvents = await repositories.event.listByRun(parent.accountId, parent.id, {
      limit: 10,
    });
    expect(
      parentEvents.find(
        (event) =>
          event.producerSourceEvidence?.producerKind === 'hive' &&
          event.producerSourceEvidence.phase === 'result' &&
          event.producerSourceEvidence.producerIdentity.stepId === 'step-research',
      )?.producerSourceEvidence,
    ).toMatchObject({
      producerKind: 'hive',
      phase: 'result',
      producerIdentity: { stepId: 'step-research', workerId: 'worker-research' },
      resultAuthority: { runId: child!.id, eventSeq: childEvents.at(-1)!.seq },
    });
    expect(
      parentEvents
        .filter(
          (event) =>
            event.liveEvidence?.producerKind === 'hive' &&
            event.liveEvidence.registrationId === `${parent.id}:hive:step-research`,
        )
        .map((event) => ({
          transition: event.liveEvidence!.transition,
          previousProofRef: event.liveEvidence!.previousProofRef,
        })),
    ).toEqual([
      { transition: 'busy', previousProofRef: undefined },
      { transition: 'completed', previousProofRef: expect.stringMatching(/^jlive_/) },
    ]);

    const polished = await runtime.kernel.openHiveWorker({
      parentRunId: parent.id,
      stepId: 'step-polish',
    });
    expect(polished.kind).toBe('committed');
    if (polished.kind !== 'committed') throw new Error('expected second Hive worker handle');
    const polishedCompleted = await polished.value.execute();
    expect(polishedCompleted).toMatchObject({ kind: 'committed' });
    if (polishedCompleted.kind !== 'committed') throw new Error('expected second Hive outcome');
    expect(execute).toHaveBeenLastCalledWith({
      agent: expect.objectContaining({
        slug: 'polisher',
        system_prompt: 'Keep this exact polish prompt.',
      }),
      messages: [
        { role: 'user', content: 'Research this exact topic.' },
        { role: 'assistant', content: 'Verified worker output.' },
        {
          role: 'user',
          content: 'Continue to the next Hive step (Polish). Use the content above as input.',
        },
      ],
      signal: expect.any(AbortSignal),
      connectionId: basis.model.connectionId,
    });

    const finalInput = {
      run: boundPlan.value,
      attempt: {
        kind: 'initial' as const,
        requestId: 'jreq_hive_final_authority',
        runId: parent.id,
        attemptNumber: 1 as const,
      },
      userMessageId: basis.userMessageId,
      interactionMode: basis.interactionMode,
      agent: basis.agent,
      userText: basis.userText,
      messageHistory: basis.messageHistory,
      identity: basis.identity,
      profile: basis.profile,
      model: basis.model,
      capabilities: basis.capabilities,
      context: basis.context,
      outputContract: basis.outputContract,
      workers: [completed.value, polishedCompleted.value],
    };
    const originalParentResultRow = toJarvisEventRow(
      parentEvents.find(
        (event) =>
          event.producerSourceEvidence?.producerKind === 'hive' &&
          event.producerSourceEvidence.phase === 'result',
      )!,
    );
    await db.jarvis_events.put({ ...originalParentResultRow, status: 'tampered' });
    await expect(runtime.kernel.runHiveFinalTurn(finalInput)).rejects.toThrow(
      'kernel_hive_worker_authority_changed',
    );
    await db.jarvis_events.put(originalParentResultRow);

    useAuthStore.setState({
      cloudSession: { user_id: parent.accountId } as never,
      localUserId: parent.accountId,
    });
    await expect(runtime.kernel.runHiveFinalTurn(finalInput)).resolves.toEqual({
      kind: 'account_authority_revoked',
    });
  });
});
